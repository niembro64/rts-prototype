// Network entity creation helpers

import type { Entity, BuildingBlueprintId, Turret } from '../../sim/types';
import { isTowerBuildingBlueprintId } from '../../../types/buildingTypes';
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
import { getBuildingBlueprint, getUnitBlueprint, getUnitLocomotion } from '../../sim/blueprints';
import { getBuildingConfig } from '../../sim/buildConfigs';
import { BUILD_GRID_CELL_SIZE } from '../../sim/buildGrid';
import { COST_MULTIPLIER } from '../../../config';
import { buildForceFieldPanelCache } from '../../sim/forceFieldPanelCache';
import {
  createBuildingRuntimeTurrets,
  createUnitRuntimeTurrets,
} from '../../sim/runtimeTurrets';
import { createBuildable, getBuildFraction } from '../../sim/buildableHelpers';
import { isFiniteNumber } from '../../math';
import { createUnitSuspension } from '../../sim/unitSuspension';
import { computeUnitActionHash } from '../../sim/unitActions';
import { applyEntitySensorBlueprint } from '../../sim/cloakDetection';
import {
  dequantizeEntityPosition as deqEntityPos,
  dequantizeRotation as deqRot,
} from '../snapshotQuantization';
import {
  decodeNetworkUnitActions,
  decodeNetworkUnitBlueprintId,
  readNetworkUnitBodyCenterHeight,
  readNetworkUnitMass,
  readNetworkUnitRadius,
  readNetworkUnitSurfaceNormal,
  readNetworkUnitVelocity,
} from '../unitSnapshotFields';

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
  const forceField = turret.forceField;
  turret.forceField = nw.currentForceFieldRange !== undefined && nw.currentForceFieldRange !== null
    ? { range: nw.currentForceFieldRange, transition: forceField !== undefined ? forceField.transition : 0 }
    : undefined;
}

export function applyNetworkTurretNonVisualState(
  entity: Entity,
  netTurrets: NetworkServerSnapshotTurret[] | undefined | null,
): void {
  if (!Array.isArray(netTurrets) || netTurrets.length === 0 || !entity.combat) return;
  const turrets = entity.combat.turrets;
  for (let i = 0; i < netTurrets.length && i < turrets.length; i++) {
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
      const prev = previous[i];
      const next = turrets[i];
      next.pitchVelocity = prev.pitchVelocity;
      next.barrelFireIndex = prev.barrelFireIndex;
      if (next.forceField && prev.forceField) {
        next.forceField.transition = prev.forceField.transition;
      }
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

  if (type === 'building' || type === 'tower') {
    return createBuildingFromNetwork(netEntity, id, x, y, z, rot, playerId);
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
  const unitBuild = u !== null ? u.build : null;
  const unitOrientation = u !== null ? u.orientation : null;
  const unitAngularVelocity3 = u !== null ? u.angularVelocity3 : null;
  const unitTurrets = u !== null ? u.turrets : null;
  const actions = decodeNetworkUnitActions(u !== null ? u.actions : null);
  const velocity = readNetworkUnitVelocity(u);
  const surfaceNormal = readNetworkUnitSurfaceNormal(u);
  let unitBlueprint: ReturnType<typeof getUnitBlueprint> | undefined;
  try {
    unitBlueprint = getUnitBlueprint(unitBlueprintId);
  } catch { /* unknown unit blueprint fallback handled by existing defaults */ }
  const blueprintRadius = unitBlueprint !== undefined && unitBlueprint.radius !== undefined
    ? unitBlueprint.radius
    : { body: 15, shot: 15, push: 15 };
  const blueprintMass = unitBlueprint !== undefined && unitBlueprint.mass !== undefined
    ? unitBlueprint.mass
    : 25;
  const radius = readNetworkUnitRadius(
    u,
    blueprintRadius,
  );
  const blueprintBodyCenterHeight = unitBlueprint !== undefined &&
    unitBlueprint.bodyCenterHeight !== undefined
    ? unitBlueprint.bodyCenterHeight
    : radius.push;
  const fullVisionRadius = unitBlueprint !== undefined &&
    unitBlueprint.fullVisionRadius !== undefined
    ? unitBlueprint.fullVisionRadius
    : 1200;
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
      bodyCenterHeight: readNetworkUnitBodyCenterHeight(
        u,
        blueprintBodyCenterHeight,
      ),
      fullVisionRadius,
      locomotion: getUnitLocomotion(unitBlueprintId),
      mass: readNetworkUnitMass(u, blueprintMass),
      actions,
      actionHash: computeUnitActionHash(actions),
      patrolStartIndex: null,
      flyingLoiterTargetX: null,
      flyingLoiterTargetY: null,
      flyingLoiterTargetZ: null,
      flyingLoiterTurnSign: null,
      velocityX: velocity.x,
      velocityY: velocity.y,
      velocityZ: velocity.z,
      // movementAccelX/Y/Z are server-side force inputs. The client
      // does not receive them and integrates position from velocity.
      movementAccelX: 0,
      movementAccelY: 0,
      movementAccelZ: 0,
      thrustDirX: 0,
      thrustDirY: 0,
      forceFieldPanels: [],
      forceFieldBoundRadius: 0,
      // Smoothed surface normal: hydrated from the wire when present
      // (full keyframes always carry it, deltas ship it on
      // ENTITY_CHANGED_NORMAL). Defaults to flat-up so non-keyframe
      // creations or pre-unit-ground-normal-EMA snapshots don't leave a zero normal
      // for downstream consumers.
      surfaceNormal,
      suspension: createUnitSuspension(
        unitBlueprint !== undefined ? unitBlueprint.suspension : undefined,
      ),
      // 3-DOF orientation triad — hydrated from the wire for hover-style
      // units that need roll. Ground units have no orientation field on
      // the wire, so these stay null.
      orientation: unitOrientation !== null
        ? { x: unitOrientation.x, y: unitOrientation.y, z: unitOrientation.z, w: unitOrientation.w }
        : null,
      angularVelocity3: unitAngularVelocity3 !== null
        ? { x: unitAngularVelocity3.x, y: unitAngularVelocity3.y, z: unitAngularVelocity3.z }
        : (unitOrientation !== null ? { x: 0, y: 0, z: 0 } : null),
      // angularAcceleration3 is sim-only and not on the wire.
      angularAcceleration3: unitOrientation !== null ? { x: 0, y: 0, z: 0 } : null,
      hoverHeightUpwardForceSmoothed: null,
      stuckTicks: 0,
    },
  };
  if (unitBlueprint) applyEntitySensorBlueprint(entity, unitBlueprint);

  const turrets = createTurretsFromNetwork(unitBlueprintId, entity.unit!.radius.body, unitTurrets);
  if (turrets) {
    const combat = createCombatComponent(turrets);
    combat.fireEnabled = u === null || u.fireEnabled !== false;
    entity.combat = combat;
  }
  // Cache force-field panels for fast beam collision checks. Same helper
  // runs on the host (WorldState.createUnitFromBlueprint) so the
  // hydrated client and the authoritative sim share one rectangle.
  try {
    const bp = unitBlueprint ?? getUnitBlueprint(entity.unit!.unitBlueprintId);
    entity.unit!.forceFieldBoundRadius = buildForceFieldPanelCache(
      bp, entity.unit!.forceFieldPanels,
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
      constructionRate: builder.constructionRate,
      currentBuildTarget: u !== null && u.buildTargetId !== null ? u.buildTargetId : NO_ENTITY_ID,
    };
  }

  // Shell construction state — `required` is re-derived from the
  // blueprint COST_MULTIPLIER product, identical to the server.
  if (unitBuild !== null && !unitBuild.complete && unitBlueprint !== undefined) {
    entity.buildable = createBuildable(
      {
        energy: unitBlueprint.cost.energy * COST_MULTIPLIER,
        metal: unitBlueprint.cost.metal * COST_MULTIPLIER,
      },
      {
        paid: unitBuild.paid,
        isGhost: null,
        healthBuildFraction: null,
      },
    );
    entity.buildable.healthBuildFraction = getBuildFraction(entity.buildable);
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
  // Towers ride the building wire flag but carry entity.type === 'tower'
  // so the client UI / selection / dispatch code can match on the same
  // discriminator the server stamps in spawn.ts.
  const entity: Entity = {
    ...createEmptyEntityComponentSlots(),
    id,
    type: isTowerBuildingBlueprintId(buildingBlueprintId) ? 'tower' : 'building',
    transform: createTransform(x, y, z, rotation),
    ownership: { playerId },
    selectable: { selected: false },
    building: {
      width,
      height,
      depth,
      hp: buildingHp !== null ? buildingHp.curr : config.hp,
      maxHp: buildingHp !== null ? buildingHp.max : config.hp,
      targetRadius: Math.sqrt(width * width + height * height) / 2,
      // The wire field `solar` carries the shared BuildingActiveState
      // open flag for every producer building (solar / wind / extractor
      // / radar / resourceConverter); map it back into the generic
      // `activeState` slot. Solar starts closed by default; the others
      // start in the host's authoritative initial pose, which the wire
      // ships as soon as the first snapshot for this entity arrives.
      activeState: (buildingBlueprintId === 'buildingSolar'
        || buildingBlueprintId === 'buildingWind'
        || buildingBlueprintId === 'buildingExtractor'
        || buildingBlueprintId === 'buildingRadar'
        || buildingBlueprintId === 'buildingResourceConverter')
        ? {
            open: buildingSolar !== null ? buildingSolar.open : buildingBlueprintId !== 'buildingSolar',
            damageDelayMs: 0,
            reopenDelayMs: 0,
          }
        : null,
    },
    buildingBlueprintId,
    metalExtractionRate: buildingBlueprintId === 'buildingExtractor'
      ? b.metalExtractionRate ?? 0
      : null,
  };
  applyEntitySensorBlueprint(entity, getBuildingBlueprint(buildingBlueprintId));

  if (b.build && !b.build.complete) {
    // required is re-derived from the local building config — it's a
    // pure function of buildingBlueprintId and never changes after spawn, so
    // no need to ship it on the wire.
    entity.buildable = createBuildable(config.cost, {
      paid: b.build.paid,
      isGhost: null,
      healthBuildFraction: null,
    });
    entity.buildable.healthBuildFraction = getBuildFraction(entity.buildable);
  }

  // Mirror the host's combat hydration. Building turret meshes are
  // mounted by BuildingEntityRenderer3D on the client side, and the
  // per-frame writer positions / aims them from entity.combat.turrets — without
  // a client-side combat component the turret root stays at default
  // (0, 0, 0) in building-local space, hiding the head inside the
  // body slab. Beam updates also reference the source's turret rig
  // for client-side prediction / aim smoothing.
  refreshBuildingTurretsFromNetwork(entity, buildingBlueprintId, b.turrets);

  const f = b.factory;
  if (f) {
    // waypoints[0] = rally point, rest = user-set waypoints
    const wps = f.waypoints;
    const rally = wps[0];
    const waypoints: { x: number; y: number; z: number | undefined; type: 'move' | 'fight' | 'patrol' }[] = [];
    for (let i = 1; i < wps.length; i++) {
      const wp = wps[i];
      waypoints.push({
        x: wp.pos.x,
        y: wp.pos.y,
        z: wp.posZ ?? undefined,
        type: wp.type as 'move' | 'fight' | 'patrol',
      });
    }
    const buildQueue: string[] = [];
    for (let i = 0; i < f.queue.length; i++) {
      const unitBlueprintId = codeToUnitBlueprintId(f.queue[i]);
      if (unitBlueprintId) buildQueue.push(unitBlueprintId);
    }
    entity.factory = {
      buildQueue,
      // Client-side currentShellId stays null — the actual shell entity
      // is in the world separately. currentBuildProgress mirrors the
      // wire's avg-fill so the UI can draw the build-queue strip
      // without looking up the shell.
      currentShellId: null,
      currentBuildProgress: f.progress ?? 0,
      rallyX: rally !== undefined ? rally.pos.x : x,
      rallyY: rally !== undefined ? rally.pos.y : y + 100,
      isProducing: f.producing ?? false,
      waypoints,
      energyRateFraction: f.energyRate ?? 0,
      metalRateFraction: f.metalRate ?? 0,
    };
  }

  return entity;
}
