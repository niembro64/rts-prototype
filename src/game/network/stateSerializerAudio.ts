import type { SimEvent } from '../sim/combat';
import type { Vec3 } from '../../types/vec2';
import type { NetworkServerSnapshotSimEvent } from './NetworkManager';
import type { SnapshotVisibility } from './stateSerializerVisibility';

type PooledSimEvent = NetworkServerSnapshotSimEvent & {
  _pos: Vec3;
};

const audioBuf: NetworkServerSnapshotSimEvent[] = [];
const audioPool: NetworkServerSnapshotSimEvent[] = [];
let audioPoolIndex = 0;

function createPooledSimEvent(): NetworkServerSnapshotSimEvent {
  const event: PooledSimEvent = {
    type: 'fire',
    turretId: '',
    sourceType: undefined,
    sourceKey: undefined,
    pos: { x: 0, y: 0, z: 0 },
    playerId: undefined,
    entityId: undefined,
    deathContext: undefined,
    impactContext: undefined,
    forceFieldImpact: undefined,
    killerPlayerId: undefined,
    victimPlayerId: undefined,
    audioOnly: undefined,
    _pos: { x: 0, y: 0, z: 0 },
  };
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

function getPooledSimEvent(): PooledSimEvent {
  let event = audioPool[audioPoolIndex] as PooledSimEvent | undefined;
  if (!event) {
    event = createPooledSimEvent() as PooledSimEvent;
    audioPool[audioPoolIndex] = event;
  }
  audioPoolIndex++;
  return event;
}

export function serializeAudioEvents(
  audioEvents?: SimEvent[],
  visibility?: SnapshotVisibility,
): NetworkServerSnapshotSimEvent[] | undefined {
  audioPoolIndex = 0;
  if (!audioEvents || audioEvents.length === 0) return undefined;

  audioBuf.length = 0;
  for (let i = 0; i < audioEvents.length; i++) {
    const source = audioEvents[i];
    let audioOnly = false;
    // attackAlert is strictly victim-routed: it never flows on
    // vision, only when the recipient owns the victim. Skip the
    // visibility gate entirely and decide solely on victimPlayerId.
    if (source.type === 'attackAlert') {
      if (!visibility || !visibility.isAuthoredByRecipient(source.victimPlayerId)) continue;
    } else if (visibility && !visibility.isPointVisible(source.pos.x, source.pos.y)) {
      // FOW-17: forward death events to the killer's recipient (they
      // still hear the kill confirmation even when the corpse is in
      // fog). Also forward own pings: a player pinging a fog point
      // must see their own marker — without this the audio gate
      // silently drops it.
      const authoredByRecipient =
        (source.type === 'death' && visibility.isAuthoredByRecipient(source.killerPlayerId)) ||
        (source.type === 'ping' && visibility.isAuthoredByRecipient(source.playerId));
      if (!authoredByRecipient) {
        // FOW-09: distant-gunfire reveal. Audible event types
        // outside vision but inside the earshot pad ride along with
        // audioOnly=true; the client plays the sound but skips every
        // visual branch. Inaudible types (ping, attackAlert,
        // forceFieldImpact) fall through and stay dropped — no point
        // forwarding a silent event past its visual gate.
        if (
          eventHasEarshotAudio(source.type) &&
          visibility.isPointWithinEarshot(source.pos.x, source.pos.y)
        ) {
          audioOnly = true;
        } else {
          continue;
        }
      }
    }
    const out = getPooledSimEvent();
    out.type = source.type;
    out.turretId = source.turretId;
    out.sourceType = source.sourceType;
    out.sourceKey = source.sourceKey;
    out._pos.x = source.pos.x;
    out._pos.y = source.pos.y;
    out._pos.z = source.pos.z;
    out.playerId = source.playerId;
    out.entityId = source.entityId;
    out.deathContext = source.deathContext;
    out.impactContext = source.impactContext;
    out.forceFieldImpact = source.forceFieldImpact;
    out.killerPlayerId = source.killerPlayerId;
    out.victimPlayerId = source.victimPlayerId;
    out.audioOnly = audioOnly ? true : undefined;
    audioBuf.push(out);
  }
  return audioBuf.length > 0 ? audioBuf : undefined;
}
