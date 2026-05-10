// Network entity creation helpers

import type { Entity, BuildingType, Turret, UnitAction } from '../../sim/types';
import type { NetworkServerSnapshotEntity, NetworkServerSnapshotTurret } from '../NetworkManager';
import {
  codeToActionType,
  codeToTurretState,
  codeToUnitType,
  codeToBuildingType,
  buildingTypeToCode,
  codeToTurretId,
} from '../../../types/network';
import { getUnitBlueprint, getUnitLocomotion } from '../../sim/blueprints';
import { getBuildingConfig } from '../../sim/buildConfigs';
import { BUILD_GRID_CELL_SIZE } from '../../sim/buildGrid';
import { COST_MULTIPLIER } from '../../../config';
import { buildMirrorPanelCache } from '../../sim/mirrorPanelCache';
import {
  createBuildingRuntimeTurrets,
  createUnitRuntimeTurrets,
} from '../../sim/runtimeTurrets';
import { updateCombatActivityFlags } from '../../sim/combat/combatActivity';
import { createBuildable, getBuildFraction } from '../../sim/buildableHelpers';
import { isFiniteNumber } from '../../math';
import { createUnitSuspension } from '../../sim/unitSuspension';
import { createUnitJump } from '../../sim/unitJump';
import { computeUnitActionHash } from '../../sim/unitActions';

function decodeNetworkUnitType(unitType: unknown): string | null {
  return isFiniteNumber(unitType) ? codeToUnitType(unitType) : null;
}

function decodeNetworkBuildingType(buildingType: unknown): BuildingType | null {
  if (!isFiniteNumber(buildingType)) return null;
  const decoded = codeToBuildingType(buildingType);
  if (!decoded) return null;
  return buildingTypeToCode(decoded) === buildingType ? decoded as BuildingType : null;
}

function applyNetworkTurretState(turret: Turret, nw: NetworkServerSnapshotTurret): void {
  const wire = nw.turret;
  const wireTurretId = codeToTurretId(wire.id);
  if (wireTurretId !== turret.config.id) return;
  turret.target = nw.targetId ?? null;
  turret.state = codeToTurretState(nw.state);
  turret.rotation = wire.angular.rot;
  turret.pitch = wire.angular.pitch;
  turret.angularVelocity = wire.angular.vel;
  turret.pitchVelocity = 0;
  turret.forceField = nw.currentForceFieldRange !== undefined && nw.currentForceFieldRange !== null
    ? { range: nw.currentForceFieldRange, transition: turret.forceField?.transition ?? 0 }
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
  updateCombatActivityFlags(entity.combat);
}

export function applyNetworkSuspensionState(
  entity: Entity,
  suspension: NonNullable<NetworkServerSnapshotEntity['unit']>['suspension'] | undefined | null,
): void {
  const state = entity.unit?.suspension;
  if (!state || !suspension) return;
  state.offsetX = suspension.offset.x;
  state.offsetY = suspension.offset.y;
  state.offsetZ = suspension.offset.z;
  state.velocityX = suspension.velocity.x;
  state.velocityY = suspension.velocity.y;
  state.velocityZ = suspension.velocity.z;
  state.legContact = suspension.legContact === true;
}

export function applyNetworkJumpState(
  entity: Entity,
  jump: NonNullable<NetworkServerSnapshotEntity['unit']>['jump'] | undefined | null,
): boolean {
  const state = entity.unit?.jump;
  if (!state || !jump) return false;
  const prevLaunchSeq = state.launchSeq;
  state.active = jump.active === true;
  if (isFiniteNumber(jump.launchSeq)) {
    state.launchSeq = jump.launchSeq;
  }
  return state.launchSeq !== prevLaunchSeq;
}

function createTurretsFromNetwork(
  unitType: string,
  unitBodyRadius: number,
  netTurrets: NetworkServerSnapshotTurret[] | undefined | null,
): Turret[] | undefined {
  if (!Array.isArray(netTurrets) || netTurrets.length === 0) return undefined;

  try {
    const canonical = createUnitRuntimeTurrets(unitType, unitBodyRadius);
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
  unitType: string,
  unitBodyRadius: number,
  netTurrets: NetworkServerSnapshotTurret[] | undefined | null,
): void {
  const previous = entity.combat?.turrets;
  const turrets = createTurretsFromNetwork(unitType, unitBodyRadius, netTurrets);
  if (!turrets) {
    entity.combat = undefined;
    return;
  }

  if (previous) {
    for (let i = 0; i < turrets.length && i < previous.length; i++) {
      const prev = previous[i];
      const next = turrets[i];
      next.cooldown = prev.cooldown;
      next.pitchVelocity = prev.pitchVelocity;
      next.barrelFireIndex = prev.barrelFireIndex;
      if (next.forceField && prev.forceField) {
        next.forceField.transition = prev.forceField.transition;
      }
    }
  }
  entity.combat = entity.combat
    ? { ...entity.combat, turrets }
    : { turrets, hasActiveCombat: false, activeTurretMask: 0, firingTurretMask: 0 };
  updateCombatActivityFlags(entity.combat);
}

export function refreshBuildingTurretsFromNetwork(
  entity: Entity,
  buildingType: BuildingType,
  netTurrets: NetworkServerSnapshotTurret[] | undefined | null,
): void {
  let turrets: Turret[];
  try {
    turrets = createBuildingRuntimeTurrets(buildingType);
  } catch {
    entity.combat = undefined;
    return;
  }

  if (turrets.length === 0) {
    entity.combat = undefined;
    return;
  }

  if (Array.isArray(netTurrets)) {
    for (let i = 0; i < netTurrets.length && i < turrets.length; i++) {
      applyNetworkTurretState(turrets[i], netTurrets[i]);
    }
  }

  entity.combat = entity.combat
    ? { ...entity.combat, turrets }
    : { turrets, hasActiveCombat: false, activeTurretMask: 0, firingTurretMask: 0 };
  updateCombatActivityFlags(entity.combat);
}

/**
 * Create an Entity from NetworkServerSnapshotEntity data. Projectiles
 * are out of scope here — they hydrate from `ClientProjectileStore`
 * spawn events, not entity snapshots.
 */
export function createEntityFromNetwork(netEntity: NetworkServerSnapshotEntity): Entity | null {
  const { id, type, pos, rotation, playerId } = netEntity;

  if (type === 'unit') {
    return createUnitFromNetwork(netEntity, id, pos.x, pos.y, rotation, playerId);
  }

  if (type === 'building') {
    return createBuildingFromNetwork(netEntity, id, pos.x, pos.y, rotation, playerId);
  }

  return null;
}

function createUnitFromNetwork(
  netEntity: NetworkServerSnapshotEntity,
  id: number,
  x: number,
  y: number,
  rotation: number,
  playerId: number
): Entity | null {
  const u = netEntity.unit;

  const actions: UnitAction[] = [];
  if (u?.actions) {
    for (let i = 0; i < u.actions.length; i++) {
      const na = u.actions[i];
      if (!na.pos) continue;
      actions.push({
        type: codeToActionType(na.type) as 'move' | 'patrol' | 'fight' | 'build' | 'repair' | 'attack',
        x: na.pos.x,
        y: na.pos.y,
        z: na.posZ,
        isPathExpansion: na.pathExp,
        targetId: na.targetId,
        buildingType: na.buildingType as BuildingType | undefined,
        gridX: na.grid?.x,
        gridY: na.grid?.y,
        buildingId: na.buildingId,
      });
    }
  }

  const defaultRadius = 15;
  const unitType = decodeNetworkUnitType(u?.unitType);
  if (!unitType) return null;
  let unitBlueprint: ReturnType<typeof getUnitBlueprint> | undefined;
  try {
    unitBlueprint = getUnitBlueprint(unitType);
  } catch { /* unknown unit type fallback handled by existing defaults */ }
  const entity: Entity = {
    id,
    type: 'unit',
    transform: { x, y, z: netEntity.pos.z, rotation },
    ownership: { playerId },
    selectable: { selected: false },
    unit: {
      unitType,
      hp: u?.hp.curr ?? 100,
      maxHp: u?.hp.max ?? 100,
      radius: {
        body: u?.radius?.body ?? defaultRadius,
        shot: u?.radius?.shot ?? defaultRadius,
        push: u?.radius?.push ?? defaultRadius,
      },
      bodyCenterHeight: u?.bodyCenterHeight ?? u?.radius?.push ?? defaultRadius,
      locomotion: getUnitLocomotion(unitType),
      mass: u?.mass ?? 25,
      actions,
      actionHash: computeUnitActionHash(actions),
      patrolStartIndex: null,
      velocityX: u?.velocity?.x ?? 0,
      velocityY: u?.velocity?.y ?? 0,
      velocityZ: u?.velocity?.z ?? 0,
      movementAccelX: u?.movementAccel?.x ?? 0,
      movementAccelY: u?.movementAccel?.y ?? 0,
      movementAccelZ: u?.movementAccel?.z ?? 0,
      jump: createUnitJump(unitBlueprint?.locomotion.physics.jump),
      mirrorPanels: [],
      mirrorBoundRadius: 0,
      // Smoothed surface normal: hydrated from the wire when present
      // (full keyframes always carry it, per-tick deltas ship it on
      // ENTITY_CHANGED_POS). Defaults to flat-up so non-keyframe
      // creations or pre-tilt-EMA snapshots don't leave a zero normal
      // for downstream consumers.
      surfaceNormal: u?.surfaceNormal
        ? { nx: u.surfaceNormal.nx, ny: u.surfaceNormal.ny, nz: u.surfaceNormal.nz }
        : { nx: 0, ny: 0, nz: 1 },
      suspension: createUnitSuspension(unitBlueprint?.suspension),
    },
  };

  const turrets = createTurretsFromNetwork(unitType, entity.unit!.radius.body, u?.turrets);
  if (turrets) {
    entity.combat = {
      turrets,
      hasActiveCombat: false,
      activeTurretMask: 0,
      firingTurretMask: 0,
    };
    updateCombatActivityFlags(entity.combat);
  }
  applyNetworkSuspensionState(entity, u?.suspension);
  applyNetworkJumpState(entity, u?.jump);

  // Cache mirror panels for fast beam collision checks. Same helper
  // runs on the host (WorldState.createUnitFromBlueprint) so the
  // hydrated client and the authoritative sim share one rectangle.
  try {
    const bp = unitBlueprint ?? getUnitBlueprint(entity.unit!.unitType);
    entity.unit!.mirrorBoundRadius = buildMirrorPanelCache(
      bp, entity.unit!.mirrorPanels,
    );
  } catch { /* */ }

  if (u?.isCommander) {
    if (unitBlueprint?.dgun) {
      entity.commander = {
        isDGunActive: false,
        dgunEnergyCost: unitBlueprint.dgun.energyCost,
      };
    }
    if (unitBlueprint?.builder) {
      entity.builder = {
        buildRange: unitBlueprint.builder.buildRange,
        constructionRate: unitBlueprint.builder.constructionRate,
        currentBuildTarget: u.buildTargetId ?? null,
      };
    }
  }

  // Shell construction state — `required` is re-derived from the
  // blueprint COST_MULTIPLIER product, identical to the server.
  if (u?.build && !u.build.complete && unitBlueprint) {
    entity.buildable = createBuildable(
      {
        energy: unitBlueprint.cost.energy * COST_MULTIPLIER,
        mana: unitBlueprint.cost.mana * COST_MULTIPLIER,
        metal: unitBlueprint.cost.metal * COST_MULTIPLIER,
      },
      { paid: u.build.paid },
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
  rotation: number,
  playerId: number
): Entity | null {
  const b = netEntity.building;
  const buildingType = decodeNetworkBuildingType(b?.type);
  if (!b || !buildingType) return null;

  // Static building facts are blueprint-derived on the client. The
  // snapshot overlays only dynamic state (hp, build progress, factory
  // queue, solar open state, extraction rate).
  const config = getBuildingConfig(buildingType);
  const width = config.gridWidth * BUILD_GRID_CELL_SIZE;
  const height = config.gridHeight * BUILD_GRID_CELL_SIZE;
  const depth = config.gridDepth * BUILD_GRID_CELL_SIZE;
  const entity: Entity = {
    id,
    type: 'building',
    transform: { x, y, z: netEntity.pos.z, rotation },
    ownership: { playerId },
    selectable: { selected: false },
    building: {
      width,
      height,
      depth,
      hp: b.hp?.curr ?? config.hp,
      maxHp: b.hp?.max ?? config.hp,
      targetRadius: Math.sqrt(width * width + height * height) / 2,
      solar: buildingType === 'solar'
        ? { open: b.solar?.open ?? false, producing: false, reopenDelayMs: 0 }
        : undefined,
    },
    buildingType,
    metalExtractionRate: buildingType === 'extractor'
      ? b.metalExtractionRate ?? 0
      : undefined,
  };

  if (b.build && !b.build.complete) {
    // required is re-derived from the local building config — it's a
    // pure function of buildingType and never changes after spawn, so
    // no need to ship it on the wire.
    entity.buildable = createBuildable(config.cost, { paid: b.build.paid });
    entity.buildable.healthBuildFraction = getBuildFraction(entity.buildable);
  }

  // Mirror the host's combat hydration. Building turret meshes are
  // mounted by BuildingEntityRenderer3D on the client side, and the
  // per-frame writer positions / aims them from entity.combat.turrets — without
  // a client-side combat component the turret root stays at default
  // (0, 0, 0) in building-local space, hiding the head inside the
  // body slab. Beam updates also reference the source's turret rig
  // for client-side prediction / aim smoothing.
  refreshBuildingTurretsFromNetwork(entity, buildingType, b.turrets);

  const f = b?.factory;
  if (f) {
    // waypoints[0] = rally point, rest = user-set waypoints
    const wps = f.waypoints;
    const rally = wps[0];
    const waypoints: { x: number; y: number; z?: number; type: 'move' | 'fight' | 'patrol' }[] = [];
    for (let i = 1; i < wps.length; i++) {
      const wp = wps[i];
      waypoints.push({ x: wp.pos.x, y: wp.pos.y, z: wp.posZ, type: wp.type as 'move' | 'fight' | 'patrol' });
    }
    const buildQueue: string[] = [];
    for (let i = 0; i < f.queue.length; i++) {
      const unitType = codeToUnitType(f.queue[i]);
      if (unitType) buildQueue.push(unitType);
    }
    entity.factory = {
      buildQueue,
      // Client-side currentShellId stays null — the actual shell entity
      // is in the world separately. currentBuildProgress mirrors the
      // wire's avg-fill so the UI can draw the build-queue strip
      // without looking up the shell.
      currentShellId: null,
      currentBuildProgress: f.progress ?? 0,
      rallyX: rally?.pos.x ?? x,
      rallyY: rally?.pos.y ?? y + 100,
      isProducing: f.producing ?? false,
      waypoints,
      energyRateFraction: f.energyRate ?? 0,
      manaRateFraction: f.manaRate ?? 0,
      metalRateFraction: f.metalRate ?? 0,
    };
  }

  return entity;
}
