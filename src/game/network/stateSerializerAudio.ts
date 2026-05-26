import type { SimEvent } from '../sim/combat';
import type { Vec3 } from '../../types/vec2';
import type { NetworkServerSnapshotSimEvent } from './NetworkManager';
import { SNAPSHOT_CONFIG } from '../../config';
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

type PooledSimEvent = NetworkServerSnapshotSimEvent & {
  _pos: Vec3;
};

export type SerializeAudioEventsOptions = {
  unitCount: number;
  snapshotSequence: number;
};

/** Per-listener pool of pooled NetworkServerSnapshotSimEvent objects
 *  plus the snapshot's outbound buf (FOW-OPT-07). Keyed by
 *  the listener's tracking key so the returned array stays stable for
 *  any consumer that holds it across the publisher's listener loop;
 *  the shared snapshotPool.ts helper owns the get / advance / reset
 *  bookkeeping. */
const audioPools = new Map<string, SnapshotPool<NetworkServerSnapshotSimEvent>>();
const _attackAlertVictimPlayers = new Set<number>();

function createPooledSimEvent(): NetworkServerSnapshotSimEvent {
  const event: PooledSimEvent = {
    type: 'fire',
    turretId: '',
    sourceType: null,
    sourceKey: null,
    pos: { x: 0, y: 0, z: 0 },
    playerId: null,
    entityId: null,
    deathContext: null,
    impactContext: null,
    forceFieldImpact: null,
    killerPlayerId: null,
    victimPlayerId: null,
    audioOnly: null,
  } as PooledSimEvent;
  definePooledScratchProperty(event, '_pos', { x: 0, y: 0, z: 0 });
  event.pos = event._pos;
  return event;
}

/** Event types whose audio carries beyond their visual through the
 *  FOW-09 earshot pad. ping / attackAlert / forceFieldImpact have no
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
    case 'forceFieldStart':
    case 'forceFieldStop':
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

export function serializeAudioEvents(
  audioEvents: SimEvent[] | undefined = undefined,
  visibility: SnapshotVisibility | undefined = undefined,
  trackingKey: string | number | undefined = undefined,
  options: SerializeAudioEventsOptions | undefined = undefined,
): NetworkServerSnapshotSimEvent[] | undefined {
  const state = getOrCreateSnapshotPool(audioPools, resolveSnapshotPoolKey(trackingKey));
  state.index = 0;
  _attackAlertVictimPlayers.clear();
  if (!audioEvents || audioEvents.length === 0) return undefined;

  const audioBuf = state.buf;
  audioBuf.length = 0;
  for (let i = 0; i < audioEvents.length; i++) {
    const source = audioEvents[i];
    let audioOnly = false;
    // attackAlert is strictly victim-routed: it never flows on
    // vision, only when the recipient owns the victim. Skip the
    // visibility gate entirely and decide solely on victimPlayerId.
    if (source.type === 'attackAlert') {
      if (!visibility || !visibility.isAuthoredByRecipient(source.victimPlayerId)) continue;
      const victimPlayerId = source.victimPlayerId;
      if (victimPlayerId !== undefined) {
        if (_attackAlertVictimPlayers.has(victimPlayerId)) continue;
        _attackAlertVictimPlayers.add(victimPlayerId);
      }
    } else if (visibility) {
      // FOW-OPT-08: one bucket walk for both the vision and earshot
      // checks. Previously this was a sequential
      // isPointVisible()/isPointWithinEarshot() pair on the same
      // cell. classifyPointVisibility short-circuits to IN_VISION
      // on the first source that covers the point and only checks
      // the earshot radius once no source has full coverage.
      const visClass = visibility.classifyPointVisibility(source.pos.x, source.pos.y);
      if (visClass !== VISIBILITY_CLASS_IN_VISION) {
        // FOW-17: forward death events to the killer's recipient
        // (they still hear the kill confirmation even when the
        // corpse is in fog). Also forward own pings: a player
        // pinging a fog point must see their own marker — without
        // this the audio gate silently drops it.
        const authoredByRecipient =
          (source.type === 'death' && visibility.isAuthoredByRecipient(source.killerPlayerId)) ||
          (source.type === 'ping' && visibility.isAuthoredByRecipient(source.playerId));
        if (!authoredByRecipient) {
          // FOW-09: distant-gunfire reveal. Audible event types
          // outside vision but inside the earshot pad ride along
          // with audioOnly=true; the client plays the sound but
          // skips every visual branch. Inaudible types (ping,
          // attackAlert, forceFieldImpact) fall through and stay
          // dropped — no point forwarding a silent event past its
          // visual gate.
          if (
            visClass === VISIBILITY_CLASS_IN_EARSHOT &&
            eventHasEarshotAudio(source.type)
          ) {
            audioOnly = true;
          } else {
            continue;
          }
        }
      }
    }
    if (shouldDeferForeignHighCountAudioEvent(source, visibility, options)) continue;
    const out = getPooledItem(state, createPooledSimEvent) as PooledSimEvent;
    out.type = source.type;
    out.turretId = source.turretId;
    out.sourceType = source.sourceType ?? null;
    out.sourceKey = source.sourceKey ?? null;
    out._pos.x = source.pos.x;
    out._pos.y = source.pos.y;
    out._pos.z = source.pos.z;
    out.playerId = shouldForwardAudioEventPlayerId(source.type) ? source.playerId ?? null : null;
    out.entityId = source.entityId ?? null;
    out.deathContext = source.deathContext ?? null;
    out.impactContext = source.impactContext ?? null;
    out.forceFieldImpact = source.forceFieldImpact ?? null;
    out.killerPlayerId = source.killerPlayerId ?? null;
    out.victimPlayerId = source.victimPlayerId ?? null;
    out.audioOnly = audioOnly ? true : null;
    audioBuf.push(out);
  }
  return audioBuf.length > 0 ? audioBuf : undefined;
}

function shouldDeferForeignHighCountAudioEvent(
  event: SimEvent,
  visibility: SnapshotVisibility | undefined,
  options: SerializeAudioEventsOptions | undefined,
): boolean {
  if (options === undefined) return false;
  if (options.unitCount < SNAPSHOT_CONFIG.highCountEntityLodUnitThreshold) return false;
  if (visibility === undefined || !visibility.hasRecipient) return false;
  if (!isHighCountThrottledAudioType(event.type)) return false;
  if (event.playerId === undefined) return false;
  if (visibility.isOwnedByRecipientOrAlly(event.playerId)) return false;

  const cadence = Math.max(
    1,
    Math.floor(SNAPSHOT_CONFIG.highCountForeignAudioSnapshotCadence),
  );
  if (cadence <= 1) return false;
  return ((audioEventStableId(event) + options.snapshotSequence) % cadence) !== 0;
}

function isHighCountThrottledAudioType(type: SimEvent['type']): boolean {
  switch (type) {
    case 'fire':
    case 'hit':
    case 'projectileExpire':
    case 'forceFieldImpact':
    case 'laserStart':
    case 'forceFieldStart':
      return true;
    default:
      return false;
  }
}

function shouldForwardAudioEventPlayerId(type: SimEvent['type']): boolean {
  return type === 'ping' || type === 'attackAlert';
}

function audioEventStableId(event: SimEvent): number {
  if (event.entityId !== undefined) return event.entityId;
  let hash = 2166136261;
  hash = hashString(hash, event.type);
  hash = hashString(hash, event.turretId);
  hash = Math.imul(hash ^ Math.round(event.pos.x), 16777619);
  hash = Math.imul(hash ^ Math.round(event.pos.y), 16777619);
  return hash >>> 0;
}

function hashString(hash: number, value: string): number {
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  }
  return hash;
}
