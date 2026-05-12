import type { WorldState } from '../sim/WorldState';
import type { Entity, EntityId } from '../sim/types';
import type { SnapshotVisibility } from './stateSerializerVisibility';
import { getBuildFraction } from '../sim/buildableHelpers';
import { assertUnitActionHashSynced } from '../sim/unitActions';
import { SNAPSHOT_CONFIG } from '../../config';
import type { SnapshotDeltaResolutionConfig } from '../../types/config';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_COMBAT_MODE,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_JUMP,
  ENTITY_CHANGED_MOVEMENT_ACCEL,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_SUSPENSION,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
} from '../../types/network';

const MAX_WEAPONS_PER_ENTITY = 8;
const DEFAULT_TRACKING_KEY = 'default';
const NORMAL_THRESHOLD = 0.001;

export type PrevEntityState = {
  x: number;
  y: number;
  z: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  movementAccelX: number;
  movementAccelY: number;
  movementAccelZ: number;
  hp: number;
  actionCount: number;
  actionHash: number;
  isEngagedBits: number;
  targetBits: number;
  weaponCount: number;
  turretRots: number[];
  turretAngVels: number[];
  turretPitches: number[];
  forceFieldRanges: number[];
  normalX: number;
  normalY: number;
  normalZ: number;
  buildProgress: number;
  solarOpen: number;
  factoryProgress: number;
  isProducing: number;
  buildQueueLen: number;
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
  /** Per-recipient last-seen positions for enemy buildings the client
   *  has as ghosts (issues.txt FOW-02b). Populated when a building
   *  exits the recipient's vision or dies out-of-vision; cleared when
   *  the recipient's vision later confirms the position (either the
   *  building is still there → normal delta resumes, or it's gone →
   *  removal emitted so the ghost cleans up on the client). */
  ghostedBuildingPositions: Map<EntityId, GhostedBuildingPosition>;
};

export const removedEntityIdsBuf: number[] = [];
export const dirtyEntityIdsBuf: EntityId[] = [];
export const dirtyEntityFieldsBuf: number[] = [];
export const aoiRemovedEntityIdsBuf: EntityId[] = [];

export const SNAPSHOT_DIRTY_FORCE_FIELDS =
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_ACTIONS |
  ENTITY_CHANGED_TURRETS |
  ENTITY_CHANGED_BUILDING |
  ENTITY_CHANGED_FACTORY |
  ENTITY_CHANGED_COMBAT_MODE |
  ENTITY_CHANGED_SUSPENSION |
  ENTITY_CHANGED_JUMP;

const trackingStates = new Map<string, DeltaTrackingState>();
const nextStateScratch = createPrevEntityState();
const capturedNextStates = new Map<EntityId, PrevEntityState>();
const capturedNextStatePool: PrevEntityState[] = [];
let capturedNextStatePoolIndex = 0;

function createPrevEntityState(): PrevEntityState {
  const turretRots: number[] = [];
  const turretAngVels: number[] = [];
  const turretPitches: number[] = [];
  const forceFieldRanges: number[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) {
    turretRots.push(0);
    turretAngVels.push(0);
    turretPitches.push(0);
    forceFieldRanges.push(0);
  }
  return {
    x: 0, y: 0, z: 0, rotation: 0,
    velocityX: 0, velocityY: 0, velocityZ: 0,
    movementAccelX: 0, movementAccelY: 0, movementAccelZ: 0,
    hp: 0, actionCount: 0, actionHash: 0,
    isEngagedBits: 0, targetBits: 0,
    weaponCount: 0, turretRots, turretAngVels, turretPitches, forceFieldRanges,
    normalX: 0, normalY: 0, normalZ: 1,
    buildProgress: 0, solarOpen: 0, factoryProgress: 0, isProducing: 0, buildQueueLen: 0,
  };
}

function createDeltaTrackingState(): DeltaTrackingState {
  return {
    prevStates: new Map<number, PrevEntityState>(),
    prevEntityIds: new Set<number>(),
    currentEntityIds: new Set<number>(),
    prevStatePool: [],
    prevStatePoolIndex: 0,
    ghostedBuildingPositions: new Map<EntityId, GhostedBuildingPosition>(),
  };
}

function getTrackingKey(key: string | number | undefined): string {
  return key === undefined ? DEFAULT_TRACKING_KEY : String(key);
}

function getDeltaResolution(
  entity: Entity,
  visibility: SnapshotVisibility | undefined,
): SnapshotDeltaResolutionConfig {
  // No recipient at all (admin / global observer) treats every entity
  // as owned so deltas stay at full precision — matches the original
  // recipientPlayerId === undefined branch. We check hasRecipient
  // rather than isFiltered so the fog-off-but-recipient-set path
  // (demo battle's local player view with fog disabled) still picks
  // owned-vs-observed correctly: the player wants full precision on
  // their own units and coarser updates for the enemies they happen
  // to see, regardless of whether the fog overlay is up.
  // FOW-06: allies share full-precision deltas the same as the
  // recipient's own entities, so teammates' units don't smear during
  // shared-camera plays.
  if (!visibility || !visibility.hasRecipient) return SNAPSHOT_CONFIG.ownedEntityDelta;
  return visibility.isOwnedByRecipientOrAlly(entity.ownership?.playerId)
    ? SNAPSHOT_CONFIG.ownedEntityDelta
    : SNAPSHOT_CONFIG.observedEntityDelta;
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
  visibility: SnapshotVisibility | undefined,
): number {
  const resolution = getDeltaResolution(entity, visibility);
  const posTh = SNAPSHOT_CONFIG.positionThreshold * resolution.positionThresholdMultiplier;
  const velTh = SNAPSHOT_CONFIG.velocityThreshold * resolution.velocityThresholdMultiplier;
  const rotPosTh = SNAPSHOT_CONFIG.rotationPositionThreshold * resolution.rotationPositionThresholdMultiplier;
  const rotVelTh = SNAPSHOT_CONFIG.rotationVelocityThreshold * resolution.rotationVelocityThresholdMultiplier;

  let mask = 0;

  if (Math.abs(next.x - prev.x) > posTh ||
      Math.abs(next.y - prev.y) > posTh ||
      Math.abs(next.z - prev.z) > posTh) {
    mask |= ENTITY_CHANGED_POS;
  }
  if (Math.abs(next.rotation - prev.rotation) > rotPosTh) {
    mask |= ENTITY_CHANGED_ROT;
  }

  if (entity.unit) {
    if (Math.abs(next.velocityX - prev.velocityX) > velTh ||
        Math.abs(next.velocityY - prev.velocityY) > velTh ||
        Math.abs(next.velocityZ - prev.velocityZ) > velTh) {
      mask |= ENTITY_CHANGED_VEL;
    }
    if (Math.abs(next.movementAccelX - prev.movementAccelX) > velTh ||
        Math.abs(next.movementAccelY - prev.movementAccelY) > velTh ||
        Math.abs(next.movementAccelZ - prev.movementAccelZ) > velTh) {
      mask |= ENTITY_CHANGED_MOVEMENT_ACCEL;
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
      for (let i = 0; i < next.weaponCount; i++) {
        if (!turretsAlreadyChanged) {
          if (Math.abs(next.turretRots[i] - prev.turretRots[i]) > rotPosTh ||
              Math.abs(next.turretAngVels[i] - prev.turretAngVels[i]) > rotVelTh ||
              Math.abs(next.turretPitches[i] - prev.turretPitches[i]) > rotPosTh ||
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
          next.buildQueueLen !== prev.buildQueueLen) {
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
  prev.velocityX = entity.unit?.velocityX ?? 0;
  prev.velocityY = entity.unit?.velocityY ?? 0;
  prev.velocityZ = entity.unit?.velocityZ ?? 0;
  prev.movementAccelX = entity.unit?.movementAccelX ?? 0;
  prev.movementAccelY = entity.unit?.movementAccelY ?? 0;
  prev.movementAccelZ = entity.unit?.movementAccelZ ?? 0;
  prev.hp = entity.unit?.hp ?? entity.building?.hp ?? 0;
  if (entity.unit) {
    assertUnitActionHashSynced(entity.unit, `captureEntityState(${entity.id})`);
    prev.actionCount = entity.unit.actions.length;
    prev.actionHash = entity.unit.actionHash;
  } else {
    prev.actionCount = 0;
    prev.actionHash = 0;
  }

  prev.isEngagedBits = 0;
  prev.targetBits = 0;
  const combatTurrets = entity.combat?.turrets;
  prev.weaponCount = combatTurrets?.length ?? 0;
  if (combatTurrets) {
    while (prev.turretRots.length < combatTurrets.length) {
      prev.turretRots.push(0);
      prev.turretAngVels.push(0);
      prev.turretPitches.push(0);
      prev.forceFieldRanges.push(0);
    }
    for (let i = 0; i < combatTurrets.length; i++) {
      const w = combatTurrets[i];
      if (w.state === 'engaged') prev.isEngagedBits |= (1 << i);
      if (w.target) prev.targetBits |= (1 << i);
      prev.turretRots[i] = w.rotation;
      prev.turretAngVels[i] = w.angularVelocity;
      prev.turretPitches[i] = w.pitch;
      prev.forceFieldRanges[i] = w.forceField?.range ?? 0;
    }
  }

  prev.buildProgress = entity.buildable ? getBuildFraction(entity.buildable) : 0;
  prev.solarOpen = entity.building?.solar?.open === false ? 0 : 1;
  prev.factoryProgress = entity.factory?.currentBuildProgress ?? 0;
  prev.isProducing = entity.factory?.isProducing ? 1 : 0;
  prev.buildQueueLen = entity.factory?.buildQueue.length ?? 0;
  const sn = entity.unit?.surfaceNormal;
  prev.normalX = sn?.nx ?? 0;
  prev.normalY = sn?.ny ?? 0;
  prev.normalZ = sn?.nz ?? 1;
}

export function copyPrevState(from: PrevEntityState, to: PrevEntityState): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.rotation = from.rotation;
  to.velocityX = from.velocityX;
  to.velocityY = from.velocityY;
  to.velocityZ = from.velocityZ;
  to.movementAccelX = from.movementAccelX;
  to.movementAccelY = from.movementAccelY;
  to.movementAccelZ = from.movementAccelZ;
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
    to.forceFieldRanges.push(0);
  }
  for (let i = 0; i < from.weaponCount; i++) {
    to.turretRots[i] = from.turretRots[i];
    to.turretAngVels[i] = from.turretAngVels[i];
    to.turretPitches[i] = from.turretPitches[i];
    to.forceFieldRanges[i] = from.forceFieldRanges[i];
  }
  to.buildProgress = from.buildProgress;
  to.solarOpen = from.solarOpen;
  to.factoryProgress = from.factoryProgress;
  to.isProducing = from.isProducing;
  to.buildQueueLen = from.buildQueueLen;
  to.normalX = from.normalX;
  to.normalY = from.normalY;
  to.normalZ = from.normalZ;
}

export function getNextEntityState(entity: Entity): PrevEntityState {
  let next = capturedNextStates.get(entity.id);
  if (!next) {
    captureEntityState(entity, nextStateScratch);
    next = nextStateScratch;
  }
  return next;
}

export function captureSnapshotEntityStates(
  world: WorldState,
  isDelta: boolean,
  dirtyEntityIds?: readonly EntityId[],
): void {
  capturedNextStates.clear();
  capturedNextStatePoolIndex = 0;

  const accepts = (e: Entity): boolean =>
    e.type === 'unit' || e.type === 'building';

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

  const sources: ReadonlyArray<readonly Entity[]> = [
    world.getUnits(),
    world.getBuildings(),
  ];
  for (let s = 0; s < sources.length; s++) {
    const src = sources[s];
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
