import type { SimEvent } from '../sim/combat';
import type { Vec3 } from '../../types/vec2';
import type { NetworkServerSnapshotSimEvent } from './NetworkManager';
import {
  type SnapshotVisibility,
  VISIBILITY_CLASS_IN_VISION,
  VISIBILITY_CLASS_IN_EARSHOT,
} from './stateSerializerVisibility';
import {
  deleteSnapshotPoolForKey,
  getOrCreateSnapshotPool,
  getPooledItem,
  resolveSnapshotPoolKey,
  type SnapshotPool,
} from './snapshotPool';
import { definePooledScratchProperty } from './snapshotPooledScratch';
import {
  createFloat64WireRows,
  reserveFloat64WireRows,
  type Float64WireRows,
} from './snapshotWireRows';
import {
  quantizeNormal as qNormal,
  quantizeProjectilePosition as qPos,
  quantizeRotation as qRot,
  quantizeVelocity as qVel,
} from './snapshotQuantization';
import {
  AUDIO_EVENT_SOURCE_TYPE_CODES,
  AUDIO_EVENT_TYPE_CODES,
  DEATH_HAS_BASE_Z,
  DEATH_HAS_COLLISION_RADIUS,
  DEATH_HAS_ROTATION,
  DEATH_HAS_TURRET_POSES,
  DEATH_HAS_UNIT_TYPE,
  DEATH_HAS_VISUAL_RADIUS,
  EVENT_AUDIO_ONLY_VALUE,
  EVENT_HAS_AUDIO_ONLY,
  EVENT_HAS_DEATH_CONTEXT,
  EVENT_HAS_ENTITY_ID,
  EVENT_HAS_IMPACT_CONTEXT,
  EVENT_HAS_KILLER_PLAYER_ID,
  EVENT_HAS_PLAYER_ID,
  EVENT_HAS_SHIELD_IMPACT,
  EVENT_HAS_SOURCE_KEY,
  EVENT_HAS_SOURCE_TYPE,
  EVENT_HAS_VICTIM_PLAYER_ID,
  EVENT_HAS_WATER_SPLASH_CONTEXT,
} from './audioEventWireFormat';

type PooledSimEvent = NetworkServerSnapshotSimEvent & {
  _pos: Vec3;
};

export const AUDIO_EVENT_WIRE_STRIDE = 20;
export const AUDIO_DEATH_CONTEXT_WIRE_STRIDE = 16;
export const AUDIO_TURRET_POSE_WIRE_STRIDE = 2;
export const AUDIO_IMPACT_CONTEXT_WIRE_STRIDE = 11;

export type AudioEventWireSource = {
  eventRows: Float64WireRows;
  deathContextRows: Float64WireRows;
  turretPoseRows: Float64WireRows;
  impactContextRows: Float64WireRows;
  strings: string[];
};

/** Per-listener pool of pooled NetworkServerSnapshotSimEvent objects
 *  plus the snapshot's outbound buf (FOW-OPT-07). Keyed by
 *  the listener's tracking key so the returned array stays stable for
 *  any consumer that holds it across the publisher's listener loop;
 *  the shared snapshotPool.ts helper owns the get / advance / reset
 *  bookkeeping. */
const audioPools = new Map<string, SnapshotPool<NetworkServerSnapshotSimEvent>>();
const audioEventWireSources = new WeakMap<object, AudioEventWireSource>();
const directAudioEventWireSource: AudioEventWireSource = {
  eventRows: createFloat64WireRows(),
  deathContextRows: createFloat64WireRows(),
  turretPoseRows: createFloat64WireRows(),
  impactContextRows: createFloat64WireRows(),
  strings: [],
};
const directAudioStringSlots = new Map<string, number>();
const _attackAlertVictimPlayers = new Set<number>();

function createPooledSimEvent(): NetworkServerSnapshotSimEvent {
  const event: PooledSimEvent = {
    type: 'fire',
    turretBlueprintId: '',
    sourceType: null,
    sourceKey: null,
    pos: { x: 0, y: 0, z: 0 },
    playerId: null,
    entityId: null,
    deathContext: null,
    impactContext: null,
    waterSplash: null,
    shieldImpact: null,
    killerPlayerId: null,
    victimPlayerId: null,
    audioOnly: null,
  } as PooledSimEvent;
  definePooledScratchProperty(event, '_pos', { x: 0, y: 0, z: 0 });
  event.pos = event._pos;
  return event;
}

/** Event types whose audio carries beyond their visual through the
 *  FOW-09 earshot pad. ping / attackAlert / shieldImpact have no
 *  one-shot audio in playSimEventAudio, so out-of-vision earshot
 *  forwarding for them would be silent — drop them at the gate. */
function eventHasEarshotAudio(type: NetworkServerSnapshotSimEvent['type']): boolean {
  switch (type) {
    case 'fire':
    case 'hit':
    case 'projectileExpire':
    case 'death':
    case 'laserStart':
    case 'laserStop':
    case 'shieldStart':
    case 'shieldStop':
      return true;
    default:
      return false;
  }
}

/** Drop the pool for a tracking key — called from
 *  GameServer.removeSnapshotListener so per-listener pools don't
 *  accumulate forever across lobby joins / disconnects. Safe to call
 *  with an unknown key. */
export function resetAudioPoolForKey(key: string | number | undefined): void {
  deleteSnapshotPoolForKey(audioPools, key);
}

export function getAudioEventWireSource(
  events: readonly NetworkServerSnapshotSimEvent[],
): AudioEventWireSource | undefined {
  return audioEventWireSources.get(events);
}

function resetAudioEventWireSource(source: AudioEventWireSource): void {
  source.eventRows.count = 0;
  source.deathContextRows.count = 0;
  source.turretPoseRows.count = 0;
  source.impactContextRows.count = 0;
  source.strings.length = 0;
}

function getStringSlot(strings: string[], slots: Map<string, number>, value: string): number {
  const existing = slots.get(value);
  if (existing !== undefined) return existing;
  const next = strings.length;
  strings.push(value);
  slots.set(value, next);
  return next;
}

function getAudioVisibilityDecision(
  source: SimEvent,
  visibility: SnapshotVisibility | undefined,
): { audioOnly: boolean } | undefined {
  let audioOnly = false;
  if (source.type === 'attackAlert') {
    if (!visibility || !visibility.isAuthoredByRecipient(source.victimPlayerId)) return undefined;
    const victimPlayerId = source.victimPlayerId;
    if (victimPlayerId !== undefined) {
      if (_attackAlertVictimPlayers.has(victimPlayerId)) return undefined;
      _attackAlertVictimPlayers.add(victimPlayerId);
    }
  } else if (visibility) {
    const visClass = visibility.classifyPointVisibility(source.pos.x, source.pos.y);
    if (visClass !== VISIBILITY_CLASS_IN_VISION) {
      const authoredByRecipient =
        (source.type === 'death' && visibility.isAuthoredByRecipient(source.killerPlayerId)) ||
        (source.type === 'ping' && visibility.isAuthoredByRecipient(source.playerId));
      if (!authoredByRecipient) {
        if (
          visClass === VISIBILITY_CLASS_IN_EARSHOT &&
          eventHasEarshotAudio(source.type)
        ) {
          audioOnly = true;
        } else {
          return undefined;
        }
      }
    }
  }
  return { audioOnly };
}

function appendDeathContextWireRow(
  wire: AudioEventWireSource,
  context: NonNullable<NetworkServerSnapshotSimEvent['deathContext']>,
  stringSlots: Map<string, number>,
): void {
  let flags = 0;
  if (context.visualRadius !== undefined) flags |= DEATH_HAS_VISUAL_RADIUS;
  if (context.collisionRadius !== undefined) flags |= DEATH_HAS_COLLISION_RADIUS;
  if (context.baseZ !== undefined) flags |= DEATH_HAS_BASE_Z;
  if (context.unitBlueprintId !== undefined) flags |= DEATH_HAS_UNIT_TYPE;
  if (context.rotation !== undefined) flags |= DEATH_HAS_ROTATION;
  if (context.turretPoses !== undefined) flags |= DEATH_HAS_TURRET_POSES;

  const rowIndex = reserveFloat64WireRows(wire.deathContextRows, 1, AUDIO_DEATH_CONTEXT_WIRE_STRIDE);
  const values = wire.deathContextRows.values;
  const base = rowIndex * AUDIO_DEATH_CONTEXT_WIRE_STRIDE;
  values[base + 0] = flags;
  values[base + 1] = qVel(context.unitVel.x);
  values[base + 2] = qVel(context.unitVel.y);
  values[base + 3] = qNormal(context.hitDir.x);
  values[base + 4] = qNormal(context.hitDir.y);
  values[base + 5] = qVel(context.projectileVel.x);
  values[base + 6] = qVel(context.projectileVel.y);
  values[base + 7] = context.attackMagnitude;
  values[base + 8] = qPos(context.radius);
  values[base + 9] = context.color;
  values[base + 10] = context.visualRadius !== undefined ? qPos(context.visualRadius) : 0;
  values[base + 11] = context.collisionRadius !== undefined ? qPos(context.collisionRadius) : 0;
  values[base + 12] = context.baseZ !== undefined ? qPos(context.baseZ) : 0;
  values[base + 13] = context.unitBlueprintId !== undefined
    ? getStringSlot(wire.strings, stringSlots, context.unitBlueprintId)
    : 0;
  values[base + 14] = context.rotation !== undefined ? qRot(context.rotation) : 0;
  const turretPoses = context.turretPoses;
  values[base + 15] = turretPoses !== undefined ? turretPoses.length : 0;

  if (turretPoses !== undefined) {
    for (let i = 0; i < turretPoses.length; i++) {
      const pose = turretPoses[i];
      const poseIndex = reserveFloat64WireRows(wire.turretPoseRows, 1, AUDIO_TURRET_POSE_WIRE_STRIDE);
      const poseBase = poseIndex * AUDIO_TURRET_POSE_WIRE_STRIDE;
      wire.turretPoseRows.values[poseBase + 0] = qRot(pose.rotation);
      wire.turretPoseRows.values[poseBase + 1] = qRot(pose.pitch);
    }
  }
}

function appendImpactContextWireRow(
  wire: AudioEventWireSource,
  context: NonNullable<NetworkServerSnapshotSimEvent['impactContext']>,
): void {
  const rowIndex = reserveFloat64WireRows(wire.impactContextRows, 1, AUDIO_IMPACT_CONTEXT_WIRE_STRIDE);
  const values = wire.impactContextRows.values;
  const base = rowIndex * AUDIO_IMPACT_CONTEXT_WIRE_STRIDE;
  values[base + 0] = qPos(context.radiusCollision);
  values[base + 1] = qPos(context.deathExplosionRadius);
  values[base + 2] = qPos(context.projectile.pos.x);
  values[base + 3] = qPos(context.projectile.pos.y);
  values[base + 4] = qVel(context.projectile.vel.x);
  values[base + 5] = qVel(context.projectile.vel.y);
  values[base + 6] = qVel(context.entity.vel.x);
  values[base + 7] = qVel(context.entity.vel.y);
  values[base + 8] = qPos(context.entity.radiusCollision);
  values[base + 9] = qNormal(context.penetrationDir.x);
  values[base + 10] = qNormal(context.penetrationDir.y);
}

function appendAudioEventWireRow(
  wire: AudioEventWireSource,
  source: SimEvent,
  audioOnly: boolean,
  stringSlots: Map<string, number>,
): boolean {
  const typeCode = AUDIO_EVENT_TYPE_CODES[source.type];
  if (typeCode === undefined) return false;

  const sourceType = source.sourceType ?? null;
  const sourceTypeCode = sourceType !== null ? AUDIO_EVENT_SOURCE_TYPE_CODES[sourceType] : 0;
  if (sourceType !== null && sourceTypeCode === undefined) return false;

  const sourceKey = source.sourceKey ?? null;
  const playerId = shouldForwardAudioEventPlayerId(source.type) ? source.playerId ?? null : null;
  const entityId = source.entityId ?? null;
  const deathContext = source.deathContext ?? null;
  const impactContext = source.impactContext ?? null;
  const waterSplash = source.waterSplash ?? null;
  const shieldImpact = source.shieldImpact ?? null;
  const killerPlayerId = source.killerPlayerId ?? null;
  const victimPlayerId = source.victimPlayerId ?? null;

  let flags = 0;
  if (sourceType !== null) flags |= EVENT_HAS_SOURCE_TYPE;
  if (sourceKey !== null) flags |= EVENT_HAS_SOURCE_KEY;
  if (playerId !== null) flags |= EVENT_HAS_PLAYER_ID;
  if (entityId !== null) flags |= EVENT_HAS_ENTITY_ID;
  if (shieldImpact !== null) flags |= EVENT_HAS_SHIELD_IMPACT;
  if (killerPlayerId !== null) flags |= EVENT_HAS_KILLER_PLAYER_ID;
  if (victimPlayerId !== null) flags |= EVENT_HAS_VICTIM_PLAYER_ID;
  if (audioOnly) flags |= EVENT_HAS_AUDIO_ONLY | EVENT_AUDIO_ONLY_VALUE;
  if (deathContext !== null) flags |= EVENT_HAS_DEATH_CONTEXT;
  if (impactContext !== null) flags |= EVENT_HAS_IMPACT_CONTEXT;
  if (waterSplash !== null) flags |= EVENT_HAS_WATER_SPLASH_CONTEXT;

  const rowIndex = reserveFloat64WireRows(wire.eventRows, 1, AUDIO_EVENT_WIRE_STRIDE);
  const values = wire.eventRows.values;
  const base = rowIndex * AUDIO_EVENT_WIRE_STRIDE;
  values[base + 0] = typeCode;
  values[base + 1] = qPos(source.pos.x);
  values[base + 2] = qPos(source.pos.y);
  values[base + 3] = qPos(source.pos.z);
  values[base + 4] = playerId ?? 0;
  values[base + 5] = entityId ?? 0;
  values[base + 6] = killerPlayerId ?? 0;
  values[base + 7] = victimPlayerId ?? 0;
  values[base + 8] = shieldImpact !== null ? qNormal(shieldImpact.normal.x) : 0;
  values[base + 9] = shieldImpact !== null ? qNormal(shieldImpact.normal.y) : 0;
  values[base + 10] = shieldImpact !== null ? qNormal(shieldImpact.normal.z) : 0;
  values[base + 11] = shieldImpact !== null ? shieldImpact.playerId : 0;
  values[base + 12] = sourceTypeCode ?? 0;
  values[base + 13] = getStringSlot(wire.strings, stringSlots, source.turretBlueprintId);
  values[base + 14] = sourceKey !== null
    ? getStringSlot(wire.strings, stringSlots, sourceKey)
    : 0;
  values[base + 15] = flags;
  values[base + 16] = waterSplash !== null ? qVel(waterSplash.velocity.x) : 0;
  values[base + 17] = waterSplash !== null ? qVel(waterSplash.velocity.y) : 0;
  values[base + 18] = waterSplash !== null ? qVel(waterSplash.velocity.z) : 0;
  values[base + 19] = waterSplash !== null ? waterSplash.mass : 0;

  if (deathContext !== null) appendDeathContextWireRow(wire, deathContext, stringSlots);
  if (impactContext !== null) appendImpactContextWireRow(wire, impactContext);
  return true;
}

export function writeAudioEventWireRowsDirect(
  audioEvents: SimEvent[] | undefined = undefined,
  visibility: SnapshotVisibility | undefined = undefined,
  eventsOut: NetworkServerSnapshotSimEvent[],
): NetworkServerSnapshotSimEvent[] | undefined {
  eventsOut.length = 0;
  resetAudioEventWireSource(directAudioEventWireSource);
  directAudioStringSlots.clear();
  audioEventWireSources.set(eventsOut, directAudioEventWireSource);
  _attackAlertVictimPlayers.clear();
  if (!audioEvents || audioEvents.length === 0) return undefined;

  for (let i = 0; i < audioEvents.length; i++) {
    const source = audioEvents[i];
    const decision = getAudioVisibilityDecision(source, visibility);
    if (decision === undefined) continue;
    appendAudioEventWireRow(
      directAudioEventWireSource,
      source,
      decision.audioOnly,
      directAudioStringSlots,
    );
  }

  const count = directAudioEventWireSource.eventRows.count;
  if (count === 0) return undefined;
  eventsOut.length = count;
  return eventsOut;
}

export function serializeAudioEvents(
  audioEvents: SimEvent[] | undefined = undefined,
  visibility: SnapshotVisibility | undefined = undefined,
  trackingKey: string | number | undefined = undefined,
): NetworkServerSnapshotSimEvent[] | undefined {
  const state = getOrCreateSnapshotPool(audioPools, resolveSnapshotPoolKey(trackingKey));
  state.index = 0;
  _attackAlertVictimPlayers.clear();
  if (!audioEvents || audioEvents.length === 0) return undefined;

  const audioBuf = state.buf;
  audioBuf.length = 0;
  for (let i = 0; i < audioEvents.length; i++) {
    const source = audioEvents[i];
    const decision = getAudioVisibilityDecision(source, visibility);
    if (decision === undefined) continue;
    const out = getPooledItem(state, createPooledSimEvent) as PooledSimEvent;
    out.type = source.type;
    out.turretBlueprintId = source.turretBlueprintId;
    out.sourceType = source.sourceType ?? null;
    out.sourceKey = source.sourceKey ?? null;
    out._pos.x = source.pos.x;
    out._pos.y = source.pos.y;
    out._pos.z = source.pos.z;
    out.playerId = shouldForwardAudioEventPlayerId(source.type) ? source.playerId ?? null : null;
    out.entityId = source.entityId ?? null;
    out.deathContext = source.deathContext ?? null;
    out.impactContext = source.impactContext ?? null;
    out.waterSplash = source.waterSplash ?? null;
    out.shieldImpact = source.shieldImpact ?? null;
    out.killerPlayerId = source.killerPlayerId ?? null;
    out.victimPlayerId = source.victimPlayerId ?? null;
    out.audioOnly = decision.audioOnly ? true : null;
    audioBuf.push(out);
  }
  return audioBuf.length > 0 ? audioBuf : undefined;
}

function shouldForwardAudioEventPlayerId(type: SimEvent['type']): boolean {
  return type === 'ping' || type === 'attackAlert';
}
