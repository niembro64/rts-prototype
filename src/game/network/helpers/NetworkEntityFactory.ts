// Network entity creation helpers

import type { Entity, BuildingBlueprintId, FactoryDefaultWaypoint, Turret } from '../../sim/types';
import {
  isMetalExtractorBlueprintId,
} from '../../../types/buildingTypes';
import {
  createCombatComponent,
  createEmptyEntityComponentSlots,
  createTransform,
  NO_ENTITY_ID,
} from '../../sim/types';
import type { NetworkServerSnapshotEntity, NetworkServerSnapshotTurret } from '../NetworkManager';
import {
  codeToTurretState,
  codeToUnitBlueprintId,
  codeToBuildingBlueprintId,
  buildingBlueprintIdToCode,
  codeToTurretBlueprintId,
} from '../../../types/network';
import { getUnitBlueprint, getUnitLocomotion } from '../../sim/blueprints';
import { getBuildingConfig } from '../../sim/buildConfigs';
import { cloneBuildingSupportSurface } from '../../sim/buildingSupportSurface';
import { cloneUnitSupportSurface } from '../../sim/unitSupportSurface';
import { BUILD_GRID_CELL_SIZE } from '../../sim/buildGrid';
import { COST_MULTIPLIER, REAL_BATTLE_FACTORY_WAYPOINT_TYPE } from '../../../config';
import { buildShieldPanelCache } from '../../sim/shieldPanelCache';
import {
  createBuildingRuntimeTurrets,
  createUnitRuntimeTurrets,
} from '../../sim/runtimeTurrets';
import { createBuildable, getBuildFraction } from '../../sim/buildableHelpers';
import { initializeConstructionPieceHealth } from '../../sim/constructionLifecycle';
import { isFiniteNumber } from '../../math';
import { createUnitSuspension } from '../../sim/unitSuspension';
import { computeUnitActionHash } from '../../sim/unitActions';
import { PATH_REQUEST_NONE } from '../../sim/SimulationPathPlanScheduler';
import { createTransportComponentForUnitBlueprint } from '../../sim/transports';
import {
  decodeFactoryProductionQueue,
  decodeFactoryProductionQuotaCounts,
  decodeFactoryProductionQuotas,
} from '../factoryProductionQueueWire';
import {
  dequantizeEntityPosition as deqEntityPos,
  dequantizeNormal as deqNormal,
  dequantizeRotation as deqRot,
  dequantizeVelocity as deqVel,
} from '../snapshotQuantization';
import {
  applyNetworkUnitActionWireRows,
  decodeNetworkUnitActions,
  decodeNetworkUnitBlueprintId,
  readNetworkCombatFireState,
  readNetworkUnitSupportPointOffsetZ,
  readNetworkUnitMass,
  readNetworkUnitMoveState,
  readNetworkUnitRadius,
  readNetworkUnitSurfaceNormal,
  readNetworkUnitVelocity,
} from '../unitSnapshotFields';
import {
  ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE,
  ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE,
  type EntitySnapshotWireSource,
} from '../stateSerializerEntities';
import { unitBlueprintBarDefaultMoveState } from '../../sim/unitCommandCapabilities';

function unitMoveStateFromWireCode(code: number): 'maneuver' | 'holdPosition' | 'roam' {
  return code === 2 ? 'roam' : code === 1 ? 'holdPosition' : 'maneuver';
}

function unitFireStateFromWireCode(code: number): 'fireAtWill' | 'returnFire' | 'holdFire' | 'defend' | 'fireAtAll' {
  return code === 4
    ? 'fireAtAll'
    : code === 3
      ? 'defend'
      : code === 2
        ? 'holdFire'
        : code === 1
          ? 'returnFire'
          : 'fireAtWill';
}

function trajectoryModeFromWireCode(code: number): 'low' | 'high' | 'auto' {
  return code === 2 ? 'auto' : code === 1 ? 'high' : 'low';
}

function orientationFromYaw(yaw: number): { x: number; y: number; z: number; w: number } {
  const half = (Number.isFinite(yaw) ? yaw : 0) * 0.5;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

function decodeNetworkBuildingBlueprintId(buildingBlueprintCode: unknown): BuildingBlueprintId | null {
  if (!isFiniteNumber(buildingBlueprintCode)) return null;
  const decoded = codeToBuildingBlueprintId(buildingBlueprintCode);
  if (!decoded) return null;
  return buildingBlueprintIdToCode(decoded) === buildingBlueprintCode ? decoded as BuildingBlueprintId : null;
}

function applyNetworkTurretState(turret: Turret, nw: NetworkServerSnapshotTurret): void {
  const wire = nw.turret;
  const wireTurretBlueprintId = codeToTurretBlueprintId(wire.turretBlueprintCode);
  if (wireTurretBlueprintId !== turret.config.turretBlueprintId) return;
  if (nw.active === false) {
    turret.target = null;
    turret.state = 'idle';
    turret.shield = null;
    return;
  }
  turret.target = nw.targetId ?? null;
  turret.state = codeToTurretState(nw.state);
  turret.rotation = deqRot(wire.angular.rot);
  turret.pitch = deqRot(wire.angular.pitch);
  turret.angularVelocity = deqRot(wire.angular.vel);
  turret.pitchVelocity = deqRot(wire.angular.pitchVel);
  // angularAcceleration / pitchAcceleration are no longer shipped on
  // the wire (the sim still writes them for its own turret physics,
  // but the client never receives them and predicts rotation from
  // angular velocity only). Leave the client-side values at the
  // runtimeTurrets default of 0.
  const shield = turret.shield;
  // Reconcile the client-local debounce counter against the wire:
  // a fully-down server field means the host's onTimeMs is 0, so any
  // locally accumulated value is stale prediction drift.
  turret.shield = nw.currentShieldRange !== undefined && nw.currentShieldRange !== null
    ? {
        range: nw.currentShieldRange,
        transition: shield !== null ? shield.transition : 0,
        onTimeMs: nw.currentShieldRange > 0 && shield !== null ? shield.onTimeMs : 0,
      }
    : null;
}

function applyWireTurretState(
  turret: Turret,
  source: EntitySnapshotWireSource,
  rowIndex: number,
): boolean {
  if (rowIndex < 0 || rowIndex >= source.turretRows.count) return false;
  const rows = source.turretRows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE;
  const wireTurretBlueprintId = codeToTurretBlueprintId(rows[base + 4]);
  if (wireTurretBlueprintId !== turret.config.turretBlueprintId) return false;
  if (rows[base + 10] !== 0) {
    turret.target = null;
    turret.state = 'idle';
    turret.shield = null;
    return true;
  }
  turret.rotation = deqRot(rows[base + 0]);
  turret.angularVelocity = deqRot(rows[base + 1]);
  turret.pitch = deqRot(rows[base + 2]);
  turret.pitchVelocity = deqRot(rows[base + 3]);
  turret.target = rows[base + 6] !== 0 ? rows[base + 7] : null;
  turret.state = codeToTurretState(rows[base + 5]);
  turret.shield = rows[base + 8] !== 0
    ? {
        range: rows[base + 9],
        transition: turret.shield !== null ? turret.shield.transition : 0,
        onTimeMs: rows[base + 9] > 0 && turret.shield !== null ? turret.shield.onTimeMs : 0,
      }
    : null;
  return true;
}

function preserveClientTurretVisualState(next: Turret, prev: Turret): void {
  if (next.config.turretBlueprintId !== prev.config.turretBlueprintId) return;

  // Full snapshots rebuild turret arrays, but visual aim correction still
  // belongs to ServerTarget + prediction so snapshots do not hard-snap poses.
  next.rotation = prev.rotation;
  next.pitch = prev.pitch;
  next.angularVelocity = prev.angularVelocity;
  next.angularAcceleration = prev.angularAcceleration;
  next.pitchVelocity = prev.pitchVelocity;
  next.pitchAcceleration = prev.pitchAcceleration;
  next.barrelFireIndex = prev.barrelFireIndex;
  next.worldPos.x = prev.worldPos.x;
  next.worldPos.y = prev.worldPos.y;
  next.worldPos.z = prev.worldPos.z;
  next.worldVelocity.x = prev.worldVelocity.x;
  next.worldVelocity.y = prev.worldVelocity.y;
  next.worldVelocity.z = prev.worldVelocity.z;
  next.worldPosTick = prev.worldPosTick;

  if (prev.shield !== null) {
    // next.shield was just built from the wire by applyNetworkTurretState;
    // a fully-down wire range proves the host debounce counter is 0, so
    // only carry the client-local counter across the rebuild while the
    // server field is up.
    const wireRange = next.shield !== null ? next.shield.range : 0;
    next.shield = {
      range: prev.shield.range,
      transition: prev.shield.transition,
      onTimeMs: wireRange > 0 ? prev.shield.onTimeMs : 0,
    };
  }
}

export function applyNetworkTurretNonVisualState(
  entity: Entity,
  netTurrets: NetworkServerSnapshotTurret[] | undefined | null,
): void {
  if (!Array.isArray(netTurrets) || netTurrets.length === 0 || !entity.combat) return;
  const turrets = entity.combat.turrets;
  for (let i = 0; i < netTurrets.length && i < turrets.length; i++) {
    if (netTurrets[i].active === false) {
      turrets[i].target = null;
      turrets[i].state = 'idle';
      turrets[i].shield = null;
      continue;
    }
    turrets[i].target = netTurrets[i].targetId ?? null;
    turrets[i].state = codeToTurretState(netTurrets[i].state);
  }
}

function createTurretsFromNetwork(
  unitBlueprintId: string,
  unitBodyRadius: number,
  netTurrets: NetworkServerSnapshotTurret[] | undefined | null,
): Turret[] | undefined {
  if (!Array.isArray(netTurrets) || netTurrets.length === 0) return undefined;

  try {
    const canonical = createUnitRuntimeTurrets(unitBlueprintId, unitBodyRadius);
    for (let i = 0; i < netTurrets.length && i < canonical.length; i++) {
      applyNetworkTurretState(canonical[i], netTurrets[i]);
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function createUnitTurretsFromWire(
  unitBlueprintId: string,
  unitBodyRadius: number,
  source: EntitySnapshotWireSource,
  offset: number,
  count: number,
): Turret[] | undefined {
  if (offset < 0 || count <= 0 || offset + count > source.turretRows.count) return undefined;
  try {
    const canonical = createUnitRuntimeTurrets(unitBlueprintId, unitBodyRadius);
    if (canonical.length !== count) return undefined;
    for (let i = 0; i < count; i++) {
      if (!applyWireTurretState(canonical[i], source, offset + i)) return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function createBuildingTurretsFromWire(
  buildingBlueprintId: BuildingBlueprintId,
  source: EntitySnapshotWireSource,
  offset: number,
  count: number,
): Turret[] | undefined {
  if (offset < 0 || count <= 0 || offset + count > source.turretRows.count) return undefined;
  try {
    const canonical = createBuildingRuntimeTurrets(buildingBlueprintId);
    if (canonical.length !== count) return undefined;
    for (let i = 0; i < count; i++) {
      if (!applyWireTurretState(canonical[i], source, offset + i)) return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

export function readFactoryWaypointFromWire(
  source: EntitySnapshotWireSource,
  offset: number,
): FactoryDefaultWaypoint | null {
  if (offset < 0 || offset >= source.waypointRows.count) return null;
  const values = source.waypointRows.values;
  const base = offset * ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE;
  const typeSlot = values[base + 4] | 0;
  const type = source.waypointStrings[typeSlot];
  if (type !== 'move' && type !== 'fight' && type !== 'patrol') return null;
  return {
    x: values[base + 0],
    y: values[base + 1],
    z: values[base + 2] !== 0 ? values[base + 3] : null,
    type,
  };
}

export function refreshUnitTurretsFromNetwork(
  entity: Entity,
  unitBlueprintId: string,
  unitBodyRadius: number,
  netTurrets: NetworkServerSnapshotTurret[] | undefined | null,
): void {
  const existingCombat = entity.combat;
  const previous = existingCombat !== null ? existingCombat.turrets : undefined;
  const turrets = createTurretsFromNetwork(unitBlueprintId, unitBodyRadius, netTurrets);
  if (!turrets) {
    entity.combat = null;
    return;
  }

  if (previous) {
    for (let i = 0; i < turrets.length && i < previous.length; i++) {
      preserveClientTurretVisualState(turrets[i], previous[i]);
    }
  }
  entity.combat = entity.combat
    ? { ...entity.combat, turrets }
    : createCombatComponent(turrets);
}

export function refreshBuildingTurretsFromNetwork(
  entity: Entity,
  buildingBlueprintId: BuildingBlueprintId,
  netTurrets: NetworkServerSnapshotTurret[] | undefined | null,
): void {
  let turrets: Turret[];
  try {
    turrets = createBuildingRuntimeTurrets(buildingBlueprintId);
  } catch {
    entity.combat = null;
    return;
  }

  if (turrets.length === 0) {
    entity.combat = null;
    return;
  }

  if (Array.isArray(netTurrets)) {
    for (let i = 0; i < netTurrets.length && i < turrets.length; i++) {
      applyNetworkTurretState(turrets[i], netTurrets[i]);
    }
  }

  const previous = entity.combat !== null ? entity.combat.turrets : undefined;
  if (previous) {
    for (let i = 0; i < turrets.length && i < previous.length; i++) {
      preserveClientTurretVisualState(turrets[i], previous[i]);
    }
  }

  entity.combat = entity.combat
    ? { ...entity.combat, turrets }
    : createCombatComponent(turrets);
}

/**
 * Create an Entity from NetworkServerSnapshotEntity data. Projectiles
 * are out of scope here — they hydrate from `ClientProjectileStore`
 * spawn events, not entity snapshots.
 */
export function createEntityFromNetwork(netEntity: NetworkServerSnapshotEntity): Entity | null {
  const { id, type, pos, rotation, playerId } = netEntity;
  if (!pos || rotation === null) return null;
  const x = deqEntityPos(pos.x);
  const y = deqEntityPos(pos.y);
  const z = deqEntityPos(pos.z);
  const rot = deqRot(rotation);

  if (type === 'unit') {
    return createUnitFromNetwork(netEntity, id, x, y, z, rot, playerId);
  }

  if (type === 'building') {
    return createBuildingFromNetwork(netEntity, id, x, y, z, rot, playerId);
  }

  return null;
}

export function createEntityFromTypedFullWireRow(
  source: EntitySnapshotWireSource,
  entityIndex: number,
): Entity | null {
  const kind = source.kinds[entityIndex];
  if (kind === ENTITY_SNAPSHOT_WIRE_KIND_UNIT) {
    return createUnitFromTypedFullWireRow(source, entityIndex);
  }
  if (kind === ENTITY_SNAPSHOT_WIRE_KIND_BUILDING) {
    return createBuildingFromTypedFullWireRow(source, entityIndex);
  }
  return null;
}

function createUnitFromNetwork(
  netEntity: NetworkServerSnapshotEntity,
  id: number,
  x: number,
  y: number,
  z: number,
  rotation: number,
  playerId: number
): Entity | null {
  const u = netEntity.unit;

  const unitBlueprintId = decodeNetworkUnitBlueprintId(u !== null ? u.unitBlueprintCode : undefined);
  if (!unitBlueprintId) return null;
  const unitHp = u !== null ? u.hp : null;
  // Rust raw-entity wire rows omit absent optional keys entirely, so a
  // completed unit arrives with no `build` key at all — treat that the
  // same as the JS serializer's explicit `build: null`.
  const unitBuild = u !== null && u.build !== undefined ? u.build : null;
  const unitOrientation = u !== null ? u.orientation : null;
  const unitAngularVelocity3 = u !== null ? u.angularVelocity3 : null;
  const unitTurrets = u !== null ? u.turrets : null;
  const decodedActions = decodeNetworkUnitActions(u !== null ? u.actions : null);
  const actions = decodedActions.actions;
  const velocity = readNetworkUnitVelocity(u);
  const surfaceNormal = readNetworkUnitSurfaceNormal(u);
  let unitBlueprint: ReturnType<typeof getUnitBlueprint> | undefined;
  try {
    unitBlueprint = getUnitBlueprint(unitBlueprintId);
  } catch { /* unknown unit blueprint fallback handled by existing defaults */ }
  const blueprintRadius = unitBlueprint !== undefined && unitBlueprint.radius !== undefined
    ? unitBlueprint.radius
    : { other: 15, hitbox: 15, collision: 15 };
  const blueprintMass = unitBlueprint !== undefined && unitBlueprint.mass !== undefined
    ? unitBlueprint.mass
    : 25;
  const radius = readNetworkUnitRadius(
    u,
    blueprintRadius,
  );
  const blueprintSupportPointOffsetZ = unitBlueprint !== undefined &&
    unitBlueprint.supportPointOffsetZ !== undefined
    ? unitBlueprint.supportPointOffsetZ
    : radius.collision;
  const entity: Entity = {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'unit',
    transform: createTransform(x, y, z, rotation),
    ownership: { playerId },
    selectable: { selected: false },
    unit: {
      unitBlueprintId,
      hp: unitHp !== null ? unitHp.curr : 100,
      maxHp: unitHp !== null ? unitHp.max : 100,
      radius,
      supportPointOffsetZ: readNetworkUnitSupportPointOffsetZ(
        u,
        blueprintSupportPointOffsetZ,
      ),
      supportSurface: cloneUnitSupportSurface(unitBlueprint?.supportSurface),
      locomotion: getUnitLocomotion(unitBlueprintId),
      mass: readNetworkUnitMass(u, blueprintMass),
      actions,
      actionHash: computeUnitActionHash(actions),
      repeatQueue: u !== null && u.repeatQueue === true,
      moveState: readNetworkUnitMoveState(u, unitBlueprintId),
      wantCloak: u !== null && u.wantCloak === true,
      cloaked: u !== null && u.cloaked === true,
      cloakRestoreFireState: null,
      patrolStartIndex: null,
      activePath: decodedActions.routePreview,
      pathRequestLane: PATH_REQUEST_NONE,
      pathRequestForceLocal: false,
      flyingLoiterTargetX: null,
      flyingLoiterTargetY: null,
      flyingLoiterTargetZ: null,
      flyingLoiterTurnSign: null,
      velocityX: velocity.x,
      velocityY: velocity.y,
      velocityZ: velocity.z,
      thrustDirX: 0,
      thrustDirY: 0,
      headingDirX: 0,
      headingDirY: 0,
      shieldPanels: [],
      shieldBoundRadius: 0,
      // Smoothed surface normal: hydrated from the wire when present.
      // Defaults to flat-up so old sparse records or pre-unit-ground-normal-EMA
      // snapshots don't leave a zero normal for downstream consumers.
      surfaceNormal,
      suspension: createUnitSuspension(
        unitBlueprint !== undefined ? unitBlueprint.suspension : undefined,
      ),
      // 3-DOF orientation triad. New snapshots send it for every unit;
      // yaw fallback keeps older/sparse snapshots usable.
      orientation: unitOrientation !== null
        ? { x: unitOrientation.x, y: unitOrientation.y, z: unitOrientation.z, w: unitOrientation.w }
        : orientationFromYaw(rotation),
      angularVelocity3: unitAngularVelocity3 !== null
        ? { x: unitAngularVelocity3.x, y: unitAngularVelocity3.y, z: unitAngularVelocity3.z }
        : { x: 0, y: 0, z: 0 },
      stuckTicks: 0,
    },
  };

  const turrets = createTurretsFromNetwork(unitBlueprintId, entity.unit!.radius.other, unitTurrets);
  if (turrets) {
    const combat = createCombatComponent(turrets);
    combat.fireState = readNetworkCombatFireState(u, unitBlueprintId);
    combat.fireEnabled = combat.fireState !== 'holdFire';
    combat.trajectoryMode = u?.trajectoryMode ?? 'auto';
    entity.combat = combat;
  }
  // Cache shield panels for fast beam collision checks. Same helper
  // runs on the host (WorldState.createUnitFromBlueprint) so the
  // hydrated client and the authoritative sim share one rectangle.
  try {
    const bp = unitBlueprint ?? getUnitBlueprint(entity.unit!.unitBlueprintId);
    entity.unit!.shieldBoundRadius = buildShieldPanelCache(
      bp, entity.unit!.shieldPanels,
    );
  } catch { /* */ }

  if (u !== null && u.isCommander === true) {
    if (unitBlueprint !== undefined && unitBlueprint.dgun !== undefined && unitBlueprint.dgun !== null) {
      const dgun = unitBlueprint.dgun;
      entity.commander = {
        isDGunActive: false,
        dgunEnergyCost: dgun.energyCost,
      };
    }
  }
  if (unitBlueprint !== undefined && unitBlueprint.builder !== undefined && unitBlueprint.builder !== null) {
    const builder = unitBlueprint.builder;
    entity.builder = {
      buildRange: builder.buildRange,
      lowPriority: u !== null && u.builderPriorityLow === true,
      currentBuildTarget: u !== null && u.buildTargetId !== null && u.buildTargetId !== undefined
        ? u.buildTargetId
        : NO_ENTITY_ID,
    };
  }
  if (unitBlueprint !== undefined) {
    const spawnMount = unitBlueprint.turrets.find((m) => m.producedBlueprintId != null);
    if (spawnMount !== undefined && spawnMount.producedBlueprintId != null) {
      entity.factory = {
        selectedUnitBlueprintId: spawnMount.producedBlueprintId,
        lowPriority: false,
        carrierSpawnEnabled: u?.carrierSpawnEnabled !== false,
        moveState: 'maneuver',
        airIdleState: 'fly',
        repeatProduction: true,
        paused: false,
        productionQueue: [],
        productionQuotas: {},
        productionQuotaCounts: {},
        resumeRepeatUnitBlueprintId: null,
        currentShellId: null,
        currentBuildProgress: 0,
        defaultWaypoints: null,
        rallyX: x,
        rallyY: y,
        rallyZ: null,
        rallyType: REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
        guardTargetId: null,
        isProducing: u?.carrierSpawnEnabled !== false,
        energyRateFraction: 0,
        metalRateFraction: 0,
      };
    }
  }
  entity.transport = createTransportComponentForUnitBlueprint(unitBlueprintId);

  // Shell construction state — `required` is re-derived from the
  // blueprint COST_MULTIPLIER product. Host and client content versions
  // must match; snapshots only carry the dynamic paid counters.
  if (unitBuild !== null && !unitBuild.complete && unitBlueprint !== undefined) {
    entity.buildable = createBuildable(
      {
        energy: unitBlueprint.cost.energy * COST_MULTIPLIER,
        metal: unitBlueprint.cost.metal * COST_MULTIPLIER,
      },
      {
        paid: unitBuild.paid,
        isInterrupted: unitBuild.interrupted === true,
        healthBuildFraction: null,
      },
    );
    entity.buildable.healthBuildFraction = getBuildFraction(entity.buildable);
    initializeConstructionPieceHealth(entity);
  }

  return entity;
}

function createUnitFromTypedFullWireRow(
  source: EntitySnapshotWireSource,
  entityIndex: number,
): Entity | null {
  const rowIndex = source.rowIndices[entityIndex];
  if (rowIndex < 0 || rowIndex >= source.unitRows.count) return null;
  const values = source.unitRows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  if (values[base + 6] !== 0 || (values[base + 7] | 0) !== 0 || values[base + 13] === 0) {
    return null;
  }

  const unitBlueprintId = codeToUnitBlueprintId(values[base + 14]);
  if (unitBlueprintId === null) return null;

  let unitBlueprint: ReturnType<typeof getUnitBlueprint> | undefined;
  try {
    unitBlueprint = getUnitBlueprint(unitBlueprintId);
  } catch { /* unknown unit blueprint fallback handled by existing defaults */ }
  const blueprintRadius = unitBlueprint !== undefined && unitBlueprint.radius !== undefined
    ? unitBlueprint.radius
    : { other: 15, hitbox: 15, collision: 15 };
  const blueprintMass = unitBlueprint !== undefined && unitBlueprint.mass !== undefined
    ? unitBlueprint.mass
    : 25;
  // Typed full rows omit immutable radii; hydrate every radius, including
  // ARM, through the same blueprint fallback as DTO snapshots.
  const radius = readNetworkUnitRadius(null, blueprintRadius);
  const blueprintSupportPointOffsetZ = unitBlueprint !== undefined &&
    unitBlueprint.supportPointOffsetZ !== undefined
    ? unitBlueprint.supportPointOffsetZ
    : radius.collision;
  const rotation = deqRot(values[base + 4]);
  const entity: Entity = {
    ...createEmptyEntityComponentSlots(),
    id: values[base + 0] | 0,
    type: 'unit',
    transform: createTransform(
      deqEntityPos(values[base + 1]),
      deqEntityPos(values[base + 2]),
      deqEntityPos(values[base + 3]),
      rotation,
    ),
    ownership: { playerId: values[base + 5] | 0 },
    selectable: { selected: false },
    unit: {
      unitBlueprintId,
      hp: values[base + 8],
      maxHp: values[base + 9],
      radius,
      supportPointOffsetZ: blueprintSupportPointOffsetZ,
      supportSurface: cloneUnitSupportSurface(unitBlueprint?.supportSurface),
      locomotion: getUnitLocomotion(unitBlueprintId),
      mass: blueprintMass,
      actions: [],
      actionHash: 0,
      repeatQueue: values[base + 53] !== 0 && values[base + 54] !== 0,
      moveState: values[base + 59] !== 0
        ? unitMoveStateFromWireCode(values[base + 60] | 0)
        : values[base + 55] !== 0
          ? (values[base + 56] !== 0 ? 'holdPosition' : 'maneuver')
          : unitBlueprintBarDefaultMoveState(unitBlueprintId),
      wantCloak: values[base + 61] !== 0 && values[base + 62] >= 1,
      cloaked: values[base + 61] !== 0 && values[base + 62] >= 2,
      cloakRestoreFireState: null,
      patrolStartIndex: null,
      activePath: null,
      pathRequestLane: PATH_REQUEST_NONE,
      pathRequestForceLocal: false,
      flyingLoiterTargetX: null,
      flyingLoiterTargetY: null,
      flyingLoiterTargetZ: null,
      flyingLoiterTurnSign: null,
      velocityX: deqVel(values[base + 10]),
      velocityY: deqVel(values[base + 11]),
      velocityZ: deqVel(values[base + 12]),
      thrustDirX: 0,
      thrustDirY: 0,
      headingDirX: 0,
      headingDirY: 0,
      shieldPanels: [],
      shieldBoundRadius: 0,
      surfaceNormal: values[base + 23] !== 0
        ? {
            nx: deqNormal(values[base + 24]),
            ny: deqNormal(values[base + 25]),
            nz: deqNormal(values[base + 26]),
          }
        : { nx: 0, ny: 0, nz: 1 },
      suspension: createUnitSuspension(
        unitBlueprint !== undefined ? unitBlueprint.suspension : undefined,
      ),
      orientation: values[base + 27] !== 0
        ? { x: values[base + 28], y: values[base + 29], z: values[base + 30], w: values[base + 31] }
        : orientationFromYaw(rotation),
      angularVelocity3: values[base + 32] !== 0
        ? { x: values[base + 33], y: values[base + 34], z: values[base + 35] }
        : { x: 0, y: 0, z: 0 },
      stuckTicks: 0,
    },
  };

  if (values[base + 41] !== 0) {
    applyNetworkUnitActionWireRows(
      entity.unit!,
      source.actionRows.values,
      values[base + 50] | 0,
      values[base + 42] | 0,
      source.actionStrings,
      ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE,
    );
  } else {
    entity.unit!.actionHash = computeUnitActionHash(entity.unit!.actions);
  }

  if (values[base + 43] !== 0) {
    const turrets = createUnitTurretsFromWire(
      unitBlueprintId,
      entity.unit!.radius.other,
      source,
      values[base + 49] | 0,
      values[base + 44] | 0,
    );
    if (turrets === undefined) return null;
    const combat = createCombatComponent(turrets);
    const fireState = values[base + 51] !== 0
      ? unitFireStateFromWireCode(values[base + 52] | 0)
      : 'fireAtWill';
    combat.fireState = fireState;
    combat.fireEnabled = fireState !== 'holdFire';
    combat.trajectoryMode = values[base + 57] !== 0
      ? trajectoryModeFromWireCode(values[base + 58] | 0)
      : 'auto';
    entity.combat = combat;
  }

  try {
    const bp = unitBlueprint ?? getUnitBlueprint(entity.unit!.unitBlueprintId);
    entity.unit!.shieldBoundRadius = buildShieldPanelCache(
      bp, entity.unit!.shieldPanels,
    );
  } catch { /* */ }

  if (values[base + 37] !== 0) {
    if (unitBlueprint !== undefined && unitBlueprint.dgun !== undefined && unitBlueprint.dgun !== null) {
      const dgun = unitBlueprint.dgun;
      entity.commander = {
        isDGunActive: false,
        dgunEnergyCost: dgun.energyCost,
      };
    }
  }
  if (unitBlueprint !== undefined && unitBlueprint.builder !== undefined && unitBlueprint.builder !== null) {
    const builder = unitBlueprint.builder;
    entity.builder = {
      buildRange: builder.buildRange,
      lowPriority: values[base + 66] !== 0 && values[base + 67] !== 0,
      currentBuildTarget: values[base + 38] !== 0 && values[base + 39] === 0
        ? values[base + 40]
        : NO_ENTITY_ID,
    };
  }
  if (unitBlueprint !== undefined) {
    const spawnMount = unitBlueprint.turrets.find((m) => m.producedBlueprintId != null);
    if (spawnMount !== undefined && spawnMount.producedBlueprintId != null) {
      entity.factory = {
        selectedUnitBlueprintId: spawnMount.producedBlueprintId,
        lowPriority: false,
        carrierSpawnEnabled: values[base + 64] !== 0 ? values[base + 65] !== 0 : true,
        moveState: 'maneuver',
        airIdleState: 'fly',
        repeatProduction: true,
        paused: false,
        productionQueue: [],
        productionQuotas: {},
        productionQuotaCounts: {},
        resumeRepeatUnitBlueprintId: null,
        currentShellId: null,
        currentBuildProgress: 0,
        defaultWaypoints: null,
        rallyX: entity.transform.x,
        rallyY: entity.transform.y,
        rallyZ: null,
        rallyType: REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
        guardTargetId: null,
        isProducing: values[base + 64] !== 0 ? values[base + 65] !== 0 : true,
        energyRateFraction: 0,
        metalRateFraction: 0,
      };
    }
  }
  entity.transport = createTransportComponentForUnitBlueprint(unitBlueprintId);

  if (values[base + 45] !== 0 && values[base + 46] === 0 && unitBlueprint !== undefined) {
    entity.buildable = createBuildable(
      {
        energy: unitBlueprint.cost.energy * COST_MULTIPLIER,
        metal: unitBlueprint.cost.metal * COST_MULTIPLIER,
      },
      {
        paid: { energy: values[base + 47], metal: values[base + 48] },
        isInterrupted: values[base + 63] !== 0,
        healthBuildFraction: null,
      },
    );
    entity.buildable.healthBuildFraction = getBuildFraction(entity.buildable);
    initializeConstructionPieceHealth(entity);
  }

  return entity;
}

function createBuildingFromNetwork(
  netEntity: NetworkServerSnapshotEntity,
  id: number,
  x: number,
  y: number,
  z: number,
  rotation: number,
  playerId: number
): Entity | null {
  const b = netEntity.building;
  const buildingBlueprintId = decodeNetworkBuildingBlueprintId(
    b !== null ? b.buildingBlueprintCode : undefined,
  );
  if (!b || !buildingBlueprintId) return null;
  const buildingHp = b.hp;
  const buildingSolar = b.solar;

  // Static building facts are blueprint-derived on the client. The
  // snapshot overlays only dynamic state (hp, build progress, factory
  // queue, solar open state, extraction rate).
  const config = getBuildingConfig(buildingBlueprintId);
  const width = config.gridWidth * BUILD_GRID_CELL_SIZE;
  const height = config.gridHeight * BUILD_GRID_CELL_SIZE;
  const depth = config.gridDepth * BUILD_GRID_CELL_SIZE;
  const entity: Entity = {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'building',
    transform: createTransform(x, y, z, rotation),
    ownership: { playerId },
    selectable: { selected: false },
    building: {
      width,
      height,
      depth,
      supportSurface: cloneBuildingSupportSurface(config.supportSurface),
      placementType: config.placementType,
      hoveringType: config.hoveringType,
      hovering: config.hovering,
      hp: buildingHp !== null ? buildingHp.curr : config.hp,
      maxHp: buildingHp !== null ? buildingHp.max : config.hp,
      targetRadius: config.radius.hitbox,
      // The wire field `solar` carries the shared BuildingActiveState
      // open flag for every producer building (solar / wind / extractor
      // / radar / sonar / resourceConverter); map it back into the generic
      // `activeState` slot. Solar starts closed by default; the others
      // start in the host's authoritative initial pose, which the wire
      // ships as soon as the first snapshot for this entity arrives.
      activeState: (buildingBlueprintId === 'buildingSolar'
        || buildingBlueprintId === 'buildingWind'
        || isMetalExtractorBlueprintId(buildingBlueprintId)
        || buildingBlueprintId === 'buildingRadar'
        || buildingBlueprintId === 'buildingSonar'
        || buildingBlueprintId === 'buildingResourceConverter')
        ? {
            open: buildingSolar !== null ? buildingSolar.open : buildingBlueprintId !== 'buildingSolar',
            damageDelayMs: 0,
            reopenDelayMs: 0,
          }
        : null,
    },
    buildingBlueprintId,
    metalExtractionRate: isMetalExtractorBlueprintId(buildingBlueprintId)
      ? b.metalExtractionRate ?? 0
      : null,
  };

  if (b.build && !b.build.complete) {
    // required is re-derived from the local building config. It is a pure
    // function of buildingBlueprintId under the client/host content-version
    // contract, so snapshots only ship paid counters.
    entity.buildable = createBuildable(config.cost, {
      paid: b.build.paid,
      isInterrupted: b.build.interrupted === true,
      healthBuildFraction: null,
    });
    entity.buildable.healthBuildFraction = getBuildFraction(entity.buildable);
  }

  // Mirror the host's combat hydration. Building turret meshes are
  // mounted by BuildingEntityRenderer3D on the client side, and the
  // render turret slab is populated from entity.combat.turrets; without a
  // client-side combat component the turret root stays at default (0, 0, 0)
  // in building-local space, hiding the head inside the body slab. Beam
  // updates also reference the source's turret rig for client-side prediction
  // / aim smoothing.
  refreshBuildingTurretsFromNetwork(entity, buildingBlueprintId, b.turrets);
  if (entity.buildable !== null) initializeConstructionPieceHealth(entity);

  const f = b.factory;
  if (f) {
    const selectedUnitBlueprintId = f.selectedUnitBlueprintCode === null
      ? null
      : codeToUnitBlueprintId(f.selectedUnitBlueprintCode);
    let defaultWaypoints: FactoryDefaultWaypoint[] | null = null;
    if (f.route !== null && f.route !== undefined) {
      defaultWaypoints = new Array<FactoryDefaultWaypoint>(f.route.length);
      for (let i = 0; i < f.route.length; i++) {
        const waypoint = f.route[i];
        defaultWaypoints[i] = {
          x: waypoint.pos.x,
          y: waypoint.pos.y,
          z: waypoint.posZ,
          type: waypoint.type as 'move' | 'fight' | 'patrol',
        };
      }
    }
    entity.factory = {
      selectedUnitBlueprintId: selectedUnitBlueprintId ?? null,
      lowPriority: f.lowPriority === true,
      carrierSpawnEnabled: true,
      moveState: f.moveState ?? 'holdPosition',
      airIdleState: f.airIdleState ?? 'land',
      repeatProduction: f.repeat !== false,
      paused: f.paused === true,
      productionQueue: decodeFactoryProductionQueue(f.queue),
      productionQuotas: decodeFactoryProductionQuotas(f.quotas),
      productionQuotaCounts: decodeFactoryProductionQuotaCounts(f.quotaCounts),
      resumeRepeatUnitBlueprintId: null,
      // Client-side currentShellId stays null — the actual shell entity
      // is in the world separately. currentBuildProgress mirrors the
      // wire's avg-fill so the UI can draw the production progress
      // without looking up the shell.
      currentShellId: null,
      currentBuildProgress: f.progress ?? 0,
      // Visualization-only mirror of the server's multi-leg route so the
      // rally line can draw the fight leg + patrol loop produced units
      // follow. Null falls back to drawing the single rally point.
      defaultWaypoints,
      rallyX: f.rally.pos.x,
      rallyY: f.rally.pos.y,
      rallyZ: f.rally.posZ,
      rallyType: f.rally.type as 'move' | 'fight' | 'patrol',
      guardTargetId: f.guardTargetId ?? null,
      isProducing: f.producing ?? false,
      energyRateFraction: f.energyRate ?? 0,
      metalRateFraction: f.metalRate ?? 0,
    };
  }

  return entity;
}

function createBuildingFromTypedFullWireRow(
  source: EntitySnapshotWireSource,
  entityIndex: number,
): Entity | null {
  const rowIndex = source.rowIndices[entityIndex];
  if (rowIndex < 0 || rowIndex >= source.buildingRows.count) return null;
  const values = source.buildingRows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  if (values[base + 6] !== 0 || (values[base + 7] | 0) !== 0) return null;
  if (values[base + 8] === 0) return null;

  const buildingBlueprintId = decodeNetworkBuildingBlueprintId(values[base + 9]);
  if (buildingBlueprintId === null) return null;
  const config = getBuildingConfig(buildingBlueprintId);
  const width = config.gridWidth * BUILD_GRID_CELL_SIZE;
  const height = config.gridHeight * BUILD_GRID_CELL_SIZE;
  const depth = config.gridDepth * BUILD_GRID_CELL_SIZE;
  if (
    values[base + 10] !== 0 &&
    (values[base + 11] !== width || values[base + 12] !== height)
  ) {
    return null;
  }

  const hasActiveState = buildingBlueprintId === 'buildingSolar' ||
    buildingBlueprintId === 'buildingWind' ||
    isMetalExtractorBlueprintId(buildingBlueprintId) ||
    buildingBlueprintId === 'buildingRadar' ||
    buildingBlueprintId === 'buildingSonar' ||
    buildingBlueprintId === 'buildingResourceConverter';
  const entity: Entity = {
    ...createEmptyEntityComponentSlots(),
    id: values[base + 0] | 0,
    type: 'building',
    transform: createTransform(
      deqEntityPos(values[base + 1]),
      deqEntityPos(values[base + 2]),
      deqEntityPos(values[base + 3]),
      deqRot(values[base + 4]),
    ),
    ownership: { playerId: values[base + 5] | 0 },
    selectable: { selected: false },
    building: {
      width,
      height,
      depth,
      supportSurface: cloneBuildingSupportSurface(config.supportSurface),
      placementType: config.placementType,
      hoveringType: config.hoveringType,
      hovering: config.hovering,
      hp: values[base + 13],
      maxHp: values[base + 14],
      targetRadius: config.radius.hitbox,
      activeState: hasActiveState
        ? {
            open: values[base + 20] !== 0
              ? values[base + 21] !== 0
              : buildingBlueprintId !== 'buildingSolar',
            damageDelayMs: 0,
            reopenDelayMs: 0,
          }
        : null,
    },
    buildingBlueprintId,
    metalExtractionRate: isMetalExtractorBlueprintId(buildingBlueprintId)
      ? (values[base + 18] !== 0 ? values[base + 19] : 0)
      : null,
  };

  if (values[base + 15] === 0) {
    entity.buildable = createBuildable(config.cost, {
      paid: { energy: values[base + 16], metal: values[base + 17] },
      isInterrupted: values[base + 34] !== 0,
      healthBuildFraction: null,
    });
    entity.buildable.healthBuildFraction = getBuildFraction(entity.buildable);
  }

  if (values[base + 22] !== 0) {
    const turrets = createBuildingTurretsFromWire(
      buildingBlueprintId,
      source,
      values[base + 31] | 0,
      values[base + 23] | 0,
    );
    if (turrets === undefined) return null;
    entity.combat = createCombatComponent(turrets);
  }
  if (values[base + 24] !== 0) {
    const factoryRows = source.factorySelectedUnitRows.values;
    const selectedCount = values[base + 25] | 0;
    const selectedOffset = values[base + 32] | 0;
    let selectedUnitBlueprintId: string | null = null;
    if (selectedCount > 0) {
      if (
        selectedOffset < 0 ||
        selectedOffset + selectedCount > source.factorySelectedUnitRows.count
      ) {
        return null;
      }
      selectedUnitBlueprintId = codeToUnitBlueprintId(factoryRows[selectedOffset]) ?? null;
    }

    const queueCount = values[base + 39] | 0;
    const queueOffset = values[base + 38] | 0;
    if (queueCount > 0 && (
      queueOffset < 0 ||
      queueOffset + queueCount > source.factorySelectedUnitRows.count
    )) {
      return null;
    }

    const rallyCount = values[base + 30] | 0;
    const rallyOffset = values[base + 33] | 0;
    if (rallyCount <= 0) return null;
    const rally = readFactoryWaypointFromWire(source, rallyOffset);
    if (rally === null) return null;

    const routeCount = values[base + 41] | 0;
    const routeOffset = values[base + 40] | 0;
    let defaultWaypoints: FactoryDefaultWaypoint[] | null = null;
    if (routeCount >= 0) {
      if (
        routeCount > 0 &&
        (routeOffset < 0 || routeOffset + routeCount > source.waypointRows.count)
      ) {
        return null;
      }
      defaultWaypoints = new Array<FactoryDefaultWaypoint>(routeCount);
      for (let i = 0; i < routeCount; i++) {
        const waypoint = readFactoryWaypointFromWire(source, routeOffset + i);
        if (waypoint === null) return null;
        defaultWaypoints[i] = waypoint;
      }
    }

    const quotaOffset = values[base + 42] | 0;
    const quotaCount = values[base + 43] | 0;
    if (
      quotaCount > 0 &&
      (quotaOffset < 0 || quotaOffset + quotaCount > source.factorySelectedUnitRows.count)
    ) {
      return null;
    }
    const quotaCountOffset = values[base + 44] | 0;
    const quotaCountCount = values[base + 45] | 0;
    if (
      quotaCountCount > 0 &&
      (
        quotaCountOffset < 0 ||
        quotaCountOffset + quotaCountCount > source.factorySelectedUnitRows.count
      )
    ) {
      return null;
    }

    entity.factory = {
      selectedUnitBlueprintId,
      lowPriority: values[base + 46] !== 0,
      carrierSpawnEnabled: true,
      moveState: unitMoveStateFromWireCode(values[base + 48] | 0),
      airIdleState: values[base + 49] !== 0 ? 'fly' : 'land',
      repeatProduction: values[base + 37] !== 0,
      paused: values[base + 47] !== 0,
      productionQueue: queueCount > 0
        ? decodeFactoryProductionQueue(factoryRows.subarray(queueOffset, queueOffset + queueCount))
        : [],
      productionQuotas: quotaCount > 0
        ? decodeFactoryProductionQuotas(factoryRows.subarray(quotaOffset, quotaOffset + quotaCount))
        : {},
      productionQuotaCounts: quotaCountCount > 0
        ? decodeFactoryProductionQuotaCounts(
            factoryRows.subarray(quotaCountOffset, quotaCountOffset + quotaCountCount),
          )
        : {},
      resumeRepeatUnitBlueprintId: null,
      currentShellId: null,
      currentBuildProgress: values[base + 26],
      defaultWaypoints,
      rallyX: rally.x,
      rallyY: rally.y,
      rallyZ: rally.z,
      rallyType: rally.type === 'guard' ? 'move' : rally.type,
      guardTargetId: values[base + 35] !== 0
        ? (values[base + 36] | 0)
        : null,
      isProducing: values[base + 27] !== 0,
      energyRateFraction: values[base + 28],
      metalRateFraction: values[base + 29],
    };
  }
  if (entity.buildable !== null) initializeConstructionPieceHealth(entity);

  return entity;
}
