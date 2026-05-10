import type { SprayTarget } from '../sim/commanderAbilities';
import type { NetworkServerSnapshotSprayTarget } from './NetworkManager';
import { createSprayDto } from './snapshotDtoCopy';

const sprayBuf: NetworkServerSnapshotSprayTarget[] = [];
const sprayPool: NetworkServerSnapshotSprayTarget[] = [];
let sprayPoolIndex = 0;

function getPooledSprayTarget(): NetworkServerSnapshotSprayTarget {
  let spray = sprayPool[sprayPoolIndex];
  if (!spray) {
    spray = createSprayDto();
    sprayPool[sprayPoolIndex] = spray;
  }
  sprayPoolIndex++;
  return spray;
}

export function serializeSprayTargets(
  sprayTargets?: SprayTarget[],
): NetworkServerSnapshotSprayTarget[] | undefined {
  sprayPoolIndex = 0;
  if (!sprayTargets || sprayTargets.length === 0) return undefined;

  sprayBuf.length = 0;
  for (let i = 0; i < sprayTargets.length; i++) {
    const source = sprayTargets[i];
    const out = getPooledSprayTarget();
    out.source.id = source.source.id;
    out.source.pos.x = source.source.pos.x;
    out.source.pos.y = source.source.pos.y;
    out.source.z = source.source.z;
    out.source.playerId = source.source.playerId;
    out.target.id = source.target.id;
    out.target.pos.x = source.target.pos.x;
    out.target.pos.y = source.target.pos.y;
    out.target.z = source.target.z;
    if (source.target.dim) {
      if (!out.target.dim) out.target.dim = { x: 0, y: 0 };
      out.target.dim.x = source.target.dim.x;
      out.target.dim.y = source.target.dim.y;
    } else {
      out.target.dim = undefined;
    }
    out.target.radius = source.target.radius;
    out.type = source.type;
    out.intensity = source.intensity;
    out.speed = source.speed;
    out.particleRadius = source.particleRadius;
    sprayBuf.push(out);
  }
  return sprayBuf.length > 0 ? sprayBuf : undefined;
}
