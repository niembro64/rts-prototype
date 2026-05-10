import type { SimEvent } from '../sim/combat';
import type { Vec3 } from '../../types/vec2';
import type { NetworkServerSnapshotSimEvent } from './NetworkManager';

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
    entityId: undefined,
    deathContext: undefined,
    impactContext: undefined,
    forceFieldImpact: undefined,
    _pos: { x: 0, y: 0, z: 0 },
  };
  event.pos = event._pos;
  return event;
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
): NetworkServerSnapshotSimEvent[] | undefined {
  audioPoolIndex = 0;
  if (!audioEvents || audioEvents.length === 0) return undefined;

  audioBuf.length = 0;
  for (let i = 0; i < audioEvents.length; i++) {
    const source = audioEvents[i];
    const out = getPooledSimEvent();
    out.type = source.type;
    out.turretId = source.turretId;
    out.sourceType = source.sourceType;
    out.sourceKey = source.sourceKey;
    out._pos.x = source.pos.x;
    out._pos.y = source.pos.y;
    out._pos.z = source.pos.z;
    out.entityId = source.entityId;
    out.deathContext = source.deathContext;
    out.impactContext = source.impactContext;
    out.forceFieldImpact = source.forceFieldImpact;
    audioBuf.push(out);
  }
  return audioBuf.length > 0 ? audioBuf : undefined;
}
