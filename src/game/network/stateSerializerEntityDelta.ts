import type { WorldState } from '../sim/WorldState';
import type { Entity, EntityId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import { getBuildFraction } from '../sim/buildableHelpers';
import { assertUnitActionHashSynced } from '../sim/unitActions';
import { SNAPSHOT_CONFIG } from '../../config';
import { spatialGrid } from '../sim/SpatialGrid';
import {
  CT_TURRET_STATE_ENGAGED,
  ENTITY_META_BLUEPRINT_KIND_BUILDING,
  ENTITY_META_BLUEPRINT_KIND_LOCOMOTION,
  ENTITY_META_BLUEPRINT_KIND_TOWER,
  ENTITY_META_BLUEPRINT_KIND_TURRET,
  ENTITY_META_BLUEPRINT_KIND_UNIT,
  ENTITY_META_KIND_BUILDING,
  ENTITY_META_KIND_LOCOMOTION,
  ENTITY_META_KIND_TOWER,
  ENTITY_META_KIND_TURRET,
  ENTITY_META_KIND_UNIT,
  ENTITY_META_STORAGE_COMBAT_TURRETS,
  ENTITY_META_STORAGE_ENTITIES,
  ENTITY_META_STORAGE_UNIT_LOCOMOTION,
  getSimWasm,
  type SimWasm,
  SNAPSHOT_DIFF_KIND_UNIT,
  SNAPSHOT_DIFF_KIND_BUILDING,
  SNAPSHOT_DIFF_KIND_TOWER,
} from '../sim-wasm/init';
import {
  snapshotPositionDeltaExceeded,
  snapshotPositionThresholdWorldUnits,
  snapshotRotationDeltaExceeded,
  snapshotRotationThresholdRadians,
  snapshotVectorVelocityDeltaExceeded,
} from '../snapshotDeltaThresholds';
import {
  encodeCombatTargetingTurretState,
  readCombatTargetingTurretFsmFromSimInto,
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from '../sim/combat/targetingInputStamping';
import { turretAimMotionIsSnapshotVisible } from './turretSnapshotFields';

import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_COMBAT_MODE,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
  buildingBlueprintIdToCode,
  turretBlueprintIdToCode,
  unitBlueprintIdToCode,
} from '../../types/network';

const MAX_WEAPONS_PER_ENTITY = 8;
const DEFAULT_TRACKING_KEY = 'default';
const NORMAL_THRESHOLD = 0.001;
const _deltaTurretFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_ENGAGED,
  targetId: -1,
};

export type PrevEntityState = {
  x: number;
  y: number;
  z: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  hp: number;
  actionCount: number;
  actionHash: number;
  isEngagedBits: number;
  targetBits: number;
  weaponCount: number;
  turretRots: number[];
  turretAngVels: number[];
  turretPitches: number[];
  // Per-turret pitch velocity. Tracked separately from yaw velocity so
  // pitch-only changes (and zero-edge transitions on a freshly stopped
  // pitch axis) dirty the turret. Client prediction integrates pitch
  // from this channel, so missing updates leave the client integrating
  // a stale derivative across snapshot gaps.
  turretPitchVels: number[];
  // Per-turret exact target ID (or -1 when null). Replaces the
  // targetBits aggregate as the source of truth for "target switched":
  // a same-presence switch from A→B with both non-null is invisible to
  // the bitmask but must still dirty the turret so the client tracks
  // the new lock.
  turretTargetIds: number[];
  forceFieldRanges: number[];
  normalX: number;
  normalY: number;
  normalZ: number;
  buildProgress: number;
  solarOpen: number;
  factoryProgress: number;
  isProducing: number;
  factorySelectedUnitCode: number;
};

export type GhostedBuildingPosition = {
  x: number;
  y: number;
};

export type DeltaTrackingState = {
  prevStates: Map<number, PrevEntityState>;
  prevEntityIds: Set<number>;
  currentEntityIds: Set<number>;
  prevStatePool: PrevEntityState[];
  prevStatePoolIndex: number;
  /** Detail fields suppressed on a non-detail delta. Kept per recipient so
   *  a one-shot visual dirty bit still ships on the next detail-cadence
   *  snapshot instead of being drained from WorldState and lost. */
  deferredDetailFields: Map<EntityId, number>;
  /** Per-recipient last-seen positions for enemy buildings the client
   *  has as ghosts (FOW-02b). Populated when a building
   *  exits the recipient's vision or dies out-of-vision; cleared when
   *  the recipient's vision later confirms the position (either the
   *  building is still there → normal delta resumes, or it's gone →
   *  removal emitted so the ghost cleans up on the client). */
  ghostedBuildingPositions: Map<EntityId, GhostedBuildingPosition>;
};

export const removedEntityIdsBuf: number[] = [];
export const dirtyEntityIdsBuf: EntityId[] = [];
export const dirtyEntityFieldsBuf: number[] = [];

// Turret dirty marks are candidate triggers; the threshold diff decides
// whether aim motion is actually worth sending on this delta.
export const SNAPSHOT_DIRTY_FORCE_FIELDS =
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_ACTIONS |
  ENTITY_CHANGED_BUILDING |
  ENTITY_CHANGED_FACTORY |
  ENTITY_CHANGED_COMBAT_MODE;

export const SNAPSHOT_DETAIL_THROTTLED_FIELDS =
  ENTITY_CHANGED_NORMAL |
  ENTITY_CHANGED_BUILDING |
  ENTITY_CHANGED_FACTORY;

const trackingStates = new Map<string, DeltaTrackingState>();
const capturedNextStates = new Map<EntityId, PrevEntityState>();
const capturedNextStatePool: PrevEntityState[] = [];
let capturedNextStatePoolIndex = 0;

function createPrevEntityState(): PrevEntityState {
  const turretRots: number[] = [];
  const turretAngVels: number[] = [];
  const turretPitches: number[] = [];
  const turretPitchVels: number[] = [];
  const turretTargetIds: number[] = [];
  const forceFieldRanges: number[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) {
    turretRots.push(0);
    turretAngVels.push(0);
    turretPitches.push(0);
    turretPitchVels.push(0);
    turretTargetIds.push(-1);
    forceFieldRanges.push(0);
  }
  return {
    x: 0, y: 0, z: 0, rotation: 0,
    velocityX: 0, velocityY: 0, velocityZ: 0,
    hp: 0, actionCount: 0, actionHash: 0,
    isEngagedBits: 0, targetBits: 0,
    weaponCount: 0,
    turretRots, turretAngVels, turretPitches,
    turretPitchVels, turretTargetIds,
    forceFieldRanges,
    normalX: 0, normalY: 0, normalZ: 1,
    buildProgress: 0, solarOpen: 0, factoryProgress: 0, isProducing: 0, factorySelectedUnitCode: -1,
  };
}

function createDeltaTrackingState(): DeltaTrackingState {
  return {
    prevStates: new Map<number, PrevEntityState>(),
    prevEntityIds: new Set<number>(),
    currentEntityIds: new Set<number>(),
    prevStatePool: [],
    prevStatePoolIndex: 0,
    deferredDetailFields: new Map<EntityId, number>(),
    ghostedBuildingPositions: new Map<EntityId, GhostedBuildingPosition>(),
  };
}

function getTrackingKey(key: string | number | undefined): string {
  return key === undefined ? DEFAULT_TRACKING_KEY : String(key);
}

function acquireCapturedNextState(): PrevEntityState {
  if (capturedNextStatePoolIndex >= capturedNextStatePool.length) {
    capturedNextStatePool.push(createPrevEntityState());
  }
  return capturedNextStatePool[capturedNextStatePoolIndex++];
}

export function getDeltaTrackingState(key: string | number | undefined): DeltaTrackingState {
  const trackingKey = getTrackingKey(key);
  let tracking = trackingStates.get(trackingKey);
  if (!tracking) {
    tracking = createDeltaTrackingState();
    trackingStates.set(trackingKey, tracking);
  }
  return tracking;
}

export function getPrevState(tracking: DeltaTrackingState, entityId: number): PrevEntityState {
  let prev = tracking.prevStates.get(entityId);
  if (!prev) {
    if (tracking.prevStatePoolIndex < tracking.prevStatePool.length) {
      prev = tracking.prevStatePool[tracking.prevStatePoolIndex++];
    } else {
      prev = createPrevEntityState();
      tracking.prevStatePool.push(prev);
      tracking.prevStatePoolIndex++;
    }
    tracking.prevStates.set(entityId, prev);
  }
  return prev;
}

export function getEntityDeltaChangedFields(
  entity: Entity,
  prev: PrevEntityState,
  next: PrevEntityState,
  world: WorldState,
): number {
  const positionThresholdWorldUnits = snapshotPositionThresholdWorldUnits(
    SNAPSHOT_CONFIG.movementPositionThreshold,
    world.mapWidth,
    world.mapHeight,
  );
  const movementVelocityMagnitudeThresholdRatio = SNAPSHOT_CONFIG.movementVelocityMagnitudeThreshold;
  const movementVelocityDirectionThresholdRadians = snapshotRotationThresholdRadians(
    SNAPSHOT_CONFIG.movementVelocityDirectionThreshold,
  );
  const rotationPositionThresholdRadians = snapshotRotationThresholdRadians(
    SNAPSHOT_CONFIG.rotationPositionThreshold,
  );
  const rotationVelocityMagnitudeThresholdRatio = SNAPSHOT_CONFIG.rotationVelocityMagnitudeThreshold;
  const rotationVelocityDirectionThresholdRadians = snapshotRotationThresholdRadians(
    SNAPSHOT_CONFIG.rotationVelocityDirectionThreshold,
  );

  let mask = 0;

  if (snapshotPositionDeltaExceeded(
    next.x, next.y, next.z,
    prev.x, prev.y, prev.z,
    positionThresholdWorldUnits,
  )) {
    mask |= ENTITY_CHANGED_POS;
  }
  if (snapshotRotationDeltaExceeded(
    next.rotation,
    prev.rotation,
    rotationPositionThresholdRadians,
  )) {
    mask |= ENTITY_CHANGED_ROT;
  }

  if (entity.unit) {
    if (snapshotVectorVelocityDeltaExceeded(
      next.velocityX, next.velocityY, next.velocityZ,
      prev.velocityX, prev.velocityY, prev.velocityZ,
      movementVelocityMagnitudeThresholdRatio,
      movementVelocityDirectionThresholdRadians,
    )) {
      mask |= ENTITY_CHANGED_VEL;
    }
    if (next.hp !== prev.hp) {
      mask |= ENTITY_CHANGED_HP;
    }
    if (next.actionCount !== prev.actionCount || next.actionHash !== prev.actionHash) {
      mask |= ENTITY_CHANGED_ACTIONS;
    }
    if (Math.abs(next.normalX - prev.normalX) > NORMAL_THRESHOLD ||
        Math.abs(next.normalY - prev.normalY) > NORMAL_THRESHOLD ||
        Math.abs(next.normalZ - prev.normalZ) > NORMAL_THRESHOLD) {
      mask |= ENTITY_CHANGED_NORMAL;
    }
    if (entity.buildable && next.buildProgress !== prev.buildProgress) {
      mask |= ENTITY_CHANGED_BUILDING;
    }
  }

  if (entity.combat) {
    if (next.weaponCount !== prev.weaponCount) {
      mask |= ENTITY_CHANGED_TURRETS;
    } else {
      let turretsAlreadyChanged = false;
      // Head-only turrets have rotation/pitch/velocity pre-zeroed by
      // captureEntityState, so the threshold checks here naturally compare
      // 0 vs 0 and never fire. Non-head-only force-field-panel hosts still
      // ship aim because their authored panel emitter rotates visibly.
      for (let i = 0; i < next.weaponCount; i++) {
        if (!turretsAlreadyChanged) {
          const turretRotationChanged = snapshotRotationDeltaExceeded(
            next.turretRots[i],
            prev.turretRots[i],
            rotationPositionThresholdRadians,
          );
          const turretAngularVelocityChanged = snapshotVectorVelocityDeltaExceeded(
            next.turretAngVels[i],
            next.turretPitchVels[i],
            0,
            prev.turretAngVels[i],
            prev.turretPitchVels[i],
            0,
            rotationVelocityMagnitudeThresholdRatio,
            rotationVelocityDirectionThresholdRadians,
          );
          const turretPitchChanged = snapshotRotationDeltaExceeded(
            next.turretPitches[i],
            prev.turretPitches[i],
            rotationPositionThresholdRadians,
          );
          if (turretRotationChanged ||
              turretAngularVelocityChanged ||
              turretPitchChanged ||
              next.turretTargetIds[i] !== prev.turretTargetIds[i] ||
              Math.abs(next.forceFieldRanges[i] - prev.forceFieldRanges[i]) > 0.001) {
            mask |= ENTITY_CHANGED_TURRETS;
            turretsAlreadyChanged = true;
          }
        }
      }
      if (next.isEngagedBits !== prev.isEngagedBits || next.targetBits !== prev.targetBits) {
        mask |= ENTITY_CHANGED_TURRETS;
      }
    }
  }

  if (entity.building) {
    if (next.hp !== prev.hp) {
      mask |= ENTITY_CHANGED_HP;
    }
    if (next.buildProgress !== prev.buildProgress || next.solarOpen !== prev.solarOpen) {
      mask |= ENTITY_CHANGED_BUILDING;
    }
    if (entity.factory) {
      if (next.factoryProgress !== prev.factoryProgress ||
          next.isProducing !== prev.isProducing ||
          next.factorySelectedUnitCode !== prev.factorySelectedUnitCode) {
        mask |= ENTITY_CHANGED_FACTORY;
      }
    }
  }

  return mask;
}

export function captureEntityState(entity: Entity, prev: PrevEntityState): void {
  prev.x = entity.transform.x;
  prev.y = entity.transform.y;
  prev.z = entity.transform.z;
  prev.rotation = entity.transform.rotation;
  const unit = entity.unit;
  const building = entity.building;
  prev.velocityX = unit !== null ? unit.velocityX : 0;
  prev.velocityY = unit !== null ? unit.velocityY : 0;
  prev.velocityZ = unit !== null ? unit.velocityZ : 0;
  prev.hp = unit !== null ? unit.hp : building !== null ? building.hp : 0;
  if (unit !== null) {
    assertUnitActionHashSynced(unit, `captureEntityState(${entity.id})`);
    prev.actionCount = unit.actions.length;
    prev.actionHash = unit.actionHash;
  } else {
    prev.actionCount = 0;
    prev.actionHash = 0;
  }

  prev.isEngagedBits = 0;
  prev.targetBits = 0;
  const combat = entity.combat;
  const combatTurrets = combat !== null ? combat.turrets : null;
  prev.weaponCount = combatTurrets !== null ? combatTurrets.length : 0;
  if (combatTurrets !== null) {
    while (prev.turretRots.length < combatTurrets.length) {
      prev.turretRots.push(0);
      prev.turretAngVels.push(0);
      prev.turretPitches.push(0);
      prev.turretPitchVels.push(0);
      prev.turretTargetIds.push(-1);
      prev.forceFieldRanges.push(0);
    }
    for (let i = 0; i < combatTurrets.length; i++) {
      const w = combatTurrets[i];
      const hasTargetingFsm = readCombatTargetingTurretFsmInto(entity, i, _deltaTurretFsm);
      const stateCode = hasTargetingFsm
        ? _deltaTurretFsm.stateCode
        : encodeCombatTargetingTurretState(w.state);
      const targetId = hasTargetingFsm ? _deltaTurretFsm.targetId : (w.target ?? -1);
      if (stateCode === CT_TURRET_STATE_ENGAGED) prev.isEngagedBits |= (1 << i);
      if (targetId !== -1) prev.targetBits |= (1 << i);
      // Head-only turrets hide their motion from the wire — sim keeps the
      // values for fire direction but the snapshot contract is "0 always".
      // Beam/laser paths are serialized through projectile beam updates.
      const snapshotAimMotion = turretAimMotionIsSnapshotVisible(w);
      prev.turretRots[i] = snapshotAimMotion ? w.rotation : 0;
      prev.turretAngVels[i] = snapshotAimMotion ? w.angularVelocity : 0;
      prev.turretPitches[i] = snapshotAimMotion ? w.pitch : 0;
      prev.turretPitchVels[i] = snapshotAimMotion ? w.pitchVelocity : 0;
      prev.turretTargetIds[i] = targetId;
      prev.forceFieldRanges[i] = w.forceField !== undefined ? w.forceField.range : 0;
    }
  }

  prev.buildProgress = entity.buildable ? getBuildFraction(entity.buildable) : 0;
  const activeState = building !== null ? building.activeState : null;
  prev.solarOpen = activeState !== null && activeState.open === false ? 0 : 1;
  const factory = entity.factory;
  prev.factoryProgress = factory !== null ? factory.currentBuildProgress : 0;
  prev.isProducing = factory !== null && factory.isProducing ? 1 : 0;
  prev.factorySelectedUnitCode = factory !== null && factory.selectedUnitBlueprintId !== null
    ? unitBlueprintIdToCode(factory.selectedUnitBlueprintId)
    : -1;
  const sn = unit !== null ? unit.surfaceNormal : null;
  prev.normalX = sn !== null ? sn.nx : 0;
  prev.normalY = sn !== null ? sn.ny : 0;
  prev.normalZ = sn !== null ? sn.nz : 1;
}

/** Phase 10 D.3g — compute the Rust-side diff mask for one entity.
 *  Returns `undefined` only when the Rust baseline path is unavailable
 *  for this entity/listener, allowing callers to fall back to the
 *  legacy TS diff during startup or non-WASM operation. */
export function getRustEntityDeltaChangedFields(
  entity: Entity,
  next: PrevEntityState,
  baselineHandle: number,
  world: WorldState,
): number | undefined {
  const sim = getSimWasm();
  if (sim === undefined) return undefined;
  const slot = spatialGrid.getSlot(entity.id);
  if (slot < 0) return undefined;
  if (sim.snapshotBaseline.slotUsed(baselineHandle, slot) === 0) return undefined;

  const positionThresholdWorldUnits = snapshotPositionThresholdWorldUnits(
    SNAPSHOT_CONFIG.movementPositionThreshold,
    world.mapWidth,
    world.mapHeight,
  );
  const movementVelocityMagnitudeThresholdRatio = SNAPSHOT_CONFIG.movementVelocityMagnitudeThreshold;
  const movementVelocityDirectionThresholdRadians = snapshotRotationThresholdRadians(
    SNAPSHOT_CONFIG.movementVelocityDirectionThreshold,
  );
  const rotationPositionThresholdRadians = snapshotRotationThresholdRadians(
    SNAPSHOT_CONFIG.rotationPositionThreshold,
  );
  const rotationVelocityMagnitudeThresholdRatio = SNAPSHOT_CONFIG.rotationVelocityMagnitudeThreshold;
  const rotationVelocityDirectionThresholdRadians = snapshotRotationThresholdRadians(
    SNAPSHOT_CONFIG.rotationVelocityDirectionThreshold,
  );

  // 3-way dispatch: unit / building / tower. TOWER and BUILDING diff
  // through the same kernel path today (their wire shape matches), but
  // the kind is distinct so future wire-format divergence has a place
  // to land without churning every caller.
  const kind = entity.type === 'unit'
    ? SNAPSHOT_DIFF_KIND_UNIT
    : entity.type === 'tower'
      ? SNAPSHOT_DIFF_KIND_TOWER
      : SNAPSHOT_DIFF_KIND_BUILDING;
  return sim.snapshotBaseline.diffSlot(
    baselineHandle, slot, kind,
    next.x, next.y, next.z, next.rotation,
    next.velocityX, next.velocityY, next.velocityZ,
    next.normalX, next.normalY, next.normalZ,
    next.actionCount, next.actionHash,
    next.isEngagedBits, next.targetBits,
    positionThresholdWorldUnits,
    rotationPositionThresholdRadians,
    movementVelocityMagnitudeThresholdRatio,
    movementVelocityDirectionThresholdRadians,
    rotationVelocityMagnitudeThresholdRatio,
    rotationVelocityDirectionThresholdRadians,
    entity.buildable ? 1 : 0,
    entity.combat ? 1 : 0,
    entity.factory ? 1 : 0,
  );
}

export function copyPrevState(from: PrevEntityState, to: PrevEntityState): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.rotation = from.rotation;
  to.velocityX = from.velocityX;
  to.velocityY = from.velocityY;
  to.velocityZ = from.velocityZ;
  to.hp = from.hp;
  to.actionCount = from.actionCount;
  to.actionHash = from.actionHash;
  to.isEngagedBits = from.isEngagedBits;
  to.targetBits = from.targetBits;
  to.weaponCount = from.weaponCount;
  while (to.turretRots.length < from.weaponCount) {
    to.turretRots.push(0);
    to.turretAngVels.push(0);
    to.turretPitches.push(0);
    to.turretPitchVels.push(0);
    to.turretTargetIds.push(-1);
    to.forceFieldRanges.push(0);
  }
  for (let i = 0; i < from.weaponCount; i++) {
    to.turretRots[i] = from.turretRots[i];
    to.turretAngVels[i] = from.turretAngVels[i];
    to.turretPitches[i] = from.turretPitches[i];
    to.turretPitchVels[i] = from.turretPitchVels[i];
    to.turretTargetIds[i] = from.turretTargetIds[i];
    to.forceFieldRanges[i] = from.forceFieldRanges[i];
  }
  // Shrink to the actual weapon count so entities that briefly carried
  // extra turrets (or that load a higher-weapon profile during one snap
  // and a lower one the next) don't keep stale trailing slots alive.
  if (to.turretRots.length > from.weaponCount) {
    to.turretRots.length = from.weaponCount;
    to.turretAngVels.length = from.weaponCount;
    to.turretPitches.length = from.weaponCount;
    to.turretPitchVels.length = from.weaponCount;
    to.turretTargetIds.length = from.weaponCount;
    to.forceFieldRanges.length = from.weaponCount;
  }
  to.buildProgress = from.buildProgress;
  to.solarOpen = from.solarOpen;
  to.factoryProgress = from.factoryProgress;
  to.isProducing = from.isProducing;
  to.factorySelectedUnitCode = from.factorySelectedUnitCode;
  to.normalX = from.normalX;
  to.normalY = from.normalY;
  to.normalZ = from.normalZ;
}

export function copySentPrevState(
  from: PrevEntityState,
  to: PrevEntityState,
  changedFields: number | undefined,
): void {
  if (changedFields === undefined) {
    copyPrevState(from, to);
    return;
  }

  if (changedFields & ENTITY_CHANGED_POS) {
    to.x = from.x;
    to.y = from.y;
    to.z = from.z;
  }
  if (changedFields & ENTITY_CHANGED_ROT) {
    to.rotation = from.rotation;
  }
  if (changedFields & ENTITY_CHANGED_VEL) {
    to.velocityX = from.velocityX;
    to.velocityY = from.velocityY;
    to.velocityZ = from.velocityZ;
  }
  if (changedFields & ENTITY_CHANGED_HP) {
    to.hp = from.hp;
  }
  if (changedFields & ENTITY_CHANGED_ACTIONS) {
    to.actionCount = from.actionCount;
    to.actionHash = from.actionHash;
  }
  if (changedFields & ENTITY_CHANGED_TURRETS) {
    to.isEngagedBits = from.isEngagedBits;
    to.targetBits = from.targetBits;
    to.weaponCount = from.weaponCount;
    while (to.turretRots.length < from.weaponCount) {
      to.turretRots.push(0);
      to.turretAngVels.push(0);
      to.turretPitches.push(0);
      to.turretPitchVels.push(0);
      to.turretTargetIds.push(-1);
      to.forceFieldRanges.push(0);
    }
    for (let i = 0; i < from.weaponCount; i++) {
      to.turretRots[i] = from.turretRots[i];
      to.turretAngVels[i] = from.turretAngVels[i];
      to.turretPitches[i] = from.turretPitches[i];
      to.turretPitchVels[i] = from.turretPitchVels[i];
      to.turretTargetIds[i] = from.turretTargetIds[i];
      to.forceFieldRanges[i] = from.forceFieldRanges[i];
    }
    if (to.turretRots.length > from.weaponCount) {
      to.turretRots.length = from.weaponCount;
      to.turretAngVels.length = from.weaponCount;
      to.turretPitches.length = from.weaponCount;
      to.turretPitchVels.length = from.weaponCount;
      to.turretTargetIds.length = from.weaponCount;
      to.forceFieldRanges.length = from.weaponCount;
    }
  }
  if (changedFields & ENTITY_CHANGED_BUILDING) {
    to.buildProgress = from.buildProgress;
    to.solarOpen = from.solarOpen;
  }
  if (changedFields & ENTITY_CHANGED_FACTORY) {
    to.factoryProgress = from.factoryProgress;
    to.isProducing = from.isProducing;
    to.factorySelectedUnitCode = from.factorySelectedUnitCode;
  }
  if (changedFields & ENTITY_CHANGED_NORMAL) {
    to.normalX = from.normalX;
    to.normalY = from.normalY;
    to.normalZ = from.normalZ;
  }
}

export function getNextEntityState(entity: Entity): PrevEntityState {
  let next = capturedNextStates.get(entity.id);
  if (!next) {
    // Cache miss path. captureSnapshotEntityStates seeds the cache
    // with dirty entities; visibility re-entry (a non-dirty entity
    // crossing back into a recipient's vision) lands here. Promote
    // the miss into a pooled slot so the next recipient in the same
    // emit reuses our work instead of recapturing the same fields.
    next = acquireCapturedNextState();
    captureEntityState(entity, next);
    capturedNextStates.set(entity.id, next);
  }
  return next;
}

function entityMetaKindCode(e: Entity): number {
  if (e.type === 'unit') return ENTITY_META_KIND_UNIT;
  if (e.type === 'tower') return ENTITY_META_KIND_TOWER;
  return ENTITY_META_KIND_BUILDING;
}

function entityMetaBlueprintKindCode(e: Entity): number {
  if (e.type === 'unit') return ENTITY_META_BLUEPRINT_KIND_UNIT;
  if (e.type === 'tower') return ENTITY_META_BLUEPRINT_KIND_TOWER;
  return ENTITY_META_BLUEPRINT_KIND_BUILDING;
}

function entityMetaBlueprintCode(e: Entity): number {
  if (e.unit !== null) return unitBlueprintIdToCode(e.unit.unitBlueprintId);
  if (e.buildingBlueprintId !== null) return buildingBlueprintIdToCode(e.buildingBlueprintId);
  return 0xff;
}

/** Phase 10 D.3a — mirror the snapshot-relevant scalars + per-turret
 *  state of one entity into the WASM-side entity-meta + turret pools.
 *  Turret pool population runs for ALL entities with combat (units
 *  AND defense-turret buildings) so the Rust diff sees fresh weapon
 *  state for either category. */
function syncEntityMetaPools(world: WorldState, e: Entity, sim: SimWasm): void {
  const slot = spatialGrid.getSlot(e.id);
  if (slot < 0) return;
  const ownership = e.ownership;
  const playerId = ownership !== null ? ownership.playerId : 0;
  const teamId = ownership !== null ? world.getTeamId(ownership.playerId) : -1;
  sim.entityMeta.register(
    e.id,
    entityMetaKindCode(e),
    entityMetaBlueprintKindCode(e),
    entityMetaBlueprintCode(e),
    ownership !== null ? ownership.playerId : -1,
    teamId,
    NO_ENTITY_ID,
    e.id,
    -1,
    ENTITY_META_STORAGE_ENTITIES,
    slot,
    e.type === 'unit' || e.type === 'tower' || e.type === 'building' ? 1 : 0,
  );

  const locomotion = e.unit?.locomotion;
  if (locomotion !== undefined && locomotion.id !== NO_ENTITY_ID) {
    sim.entityMeta.register(
      locomotion.id,
      ENTITY_META_KIND_LOCOMOTION,
      ENTITY_META_BLUEPRINT_KIND_LOCOMOTION,
      0xff,
      ownership !== null ? ownership.playerId : -1,
      teamId,
      locomotion.parentId,
      locomotion.rootHostId,
      locomotion.mountIndex,
      ENTITY_META_STORAGE_UNIT_LOCOMOTION,
      slot,
      0,
    );
  }

  if (e.unit) {
    const u = e.unit;
    const buildable = e.buildable;
    const combat = e.combat;
    const builder = e.builder;
    sim.entityMeta.setUnit(
      slot,
      playerId,
      u.hp, u.maxHp,
      combat !== null && combat.fireEnabled === false ? 0 : 1,
      e.commander ? 1 : 0,
      buildable && !buildable.isComplete ? 0 : 1,
      buildable !== null ? buildable.paid.energy : 0,
      buildable !== null ? buildable.paid.metal : 0,
      builder !== null ? builder.currentBuildTarget : NO_ENTITY_ID,
      0,
      0,
      buildable ? getBuildFraction(buildable) : 0,
    );
  } else if (e.building) {
    const b = e.building;
    const f = e.factory;
    const setStatic = e.type === 'tower' ? sim.entityMeta.setTower : sim.entityMeta.setBuilding;
    setStatic(
      slot,
      playerId,
      b.hp, b.maxHp,
      f !== null && f.isProducing ? 1 : 0,
      f !== null && f.selectedUnitBlueprintId !== null ? 1 : 0,
      f !== null ? f.currentBuildProgress : 0,
      b.activeState !== null && b.activeState.open === false ? 0 : 1,
      e.buildable ? getBuildFraction(e.buildable) : 1,
    );
  }

  const combat = e.combat;
  const turrets = combat !== null ? combat.turrets : null;
  const turretCount = turrets !== null ? turrets.length : 0;
  sim.turretPool.setCount(slot, turretCount);
  for (let t = 0; t < turretCount; t++) {
    const w = turrets![t];
    const hasTargetingFsm = readCombatTargetingTurretFsmFromSimInto(sim, e, t, _deltaTurretFsm);
    const targetId = hasTargetingFsm ? _deltaTurretFsm.targetId : (w.target ?? -1);
    // Mirror the snapshot contract on the Rust diff side: head-only turrets
    // pass 0 for aim motion. Beam/laser paths are serialized separately.
    const snapshotAimMotion = turretAimMotionIsSnapshotVisible(w);
    sim.entityMeta.register(
      w.id,
      ENTITY_META_KIND_TURRET,
      ENTITY_META_BLUEPRINT_KIND_TURRET,
      turretBlueprintIdToCode(w.config.turretBlueprintId),
      ownership !== null ? ownership.playerId : -1,
      teamId,
      w.parentId,
      w.rootHostId,
      w.mountIndex,
      ENTITY_META_STORAGE_COMBAT_TURRETS,
      slot * MAX_WEAPONS_PER_ENTITY + t,
      w.config.visualOnly ? 0 : 1,
    );
    sim.turretPool.setTurret(
      slot, t,
      w.id,
      w.parentId,
      w.rootHostId,
      w.mountIndex,
      snapshotAimMotion ? w.rotation : 0,
      snapshotAimMotion ? w.angularVelocity : 0,
      snapshotAimMotion ? w.angularAcceleration : 0,
      snapshotAimMotion ? w.pitch : 0,
      snapshotAimMotion ? w.pitchVelocity : 0,
      snapshotAimMotion ? w.pitchAcceleration : 0,
      w.forceField !== undefined ? w.forceField.range : 0,
      targetId,
    );
  }
}

export function captureSnapshotEntityStates(
  world: WorldState,
  isDelta: boolean,
  dirtyEntityIds: readonly EntityId[] | undefined = undefined,
): void {
  capturedNextStates.clear();
  capturedNextStatePoolIndex = 0;

  const accepts = (e: Entity): boolean =>
    e.type === 'unit' || e.type === 'building' || e.type === 'tower';

  const sim = getSimWasm();

  // Phase 10 D.3f — Pool sync runs over ALL entities every emit so
  // the Rust-side snapshot baseline (per-recipient) can read fresh
  // hp / build / factory / solar / turret state even for entities
  // that aren't in this tick's dirty set (e.g. a non-dirty entity
  // re-entering a recipient's vision still needs an up-to-date
  // pool view). Map population below stays dirty-only on delta.
  const allSources: ReadonlyArray<readonly Entity[]> = [
    world.getUnits(),
    world.getBuildings(),
  ];
  if (sim !== undefined) {
    for (let s = 0; s < allSources.length; s++) {
      const src = allSources[s];
      for (let i = 0; i < src.length; i++) {
        const e = src[i];
        if (!accepts(e)) continue;
        syncEntityMetaPools(world, e, sim);
      }
    }
  }

  if (isDelta && SNAPSHOT_CONFIG.deltaEnabled) {
    if (!dirtyEntityIds) return;
    for (let i = 0; i < dirtyEntityIds.length; i++) {
      const e = world.getEntity(dirtyEntityIds[i]);
      if (!e || !accepts(e)) continue;
      const captured = acquireCapturedNextState();
      captureEntityState(e, captured);
      capturedNextStates.set(e.id, captured);
    }
    return;
  }

  for (let s = 0; s < allSources.length; s++) {
    const src = allSources[s];
    for (let i = 0; i < src.length; i++) {
      const e = src[i];
      if (!accepts(e)) continue;
      const captured = acquireCapturedNextState();
      captureEntityState(e, captured);
      capturedNextStates.set(e.id, captured);
    }
  }
}

export function resetDeltaTracking(): void {
  trackingStates.clear();
}

export function resetDeltaTrackingForKey(key: string | number | undefined): void {
  trackingStates.delete(getTrackingKey(key));
}
