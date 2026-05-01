import type { GraphicsConfig } from '@/types/graphics';
import {
  lodCellCenter,
  lodCellIndex,
  normalizeLodCellSize,
} from '../lodGridMath';
import type { RenderViewLodState } from './Lod3D';
import {
  getRenderObjectLodShellDistances,
  resolveRenderObjectLodForDistanceSq,
  type RenderObjectLodShellDistances,
  type RenderObjectLodTier,
} from './RenderObjectLod';

type LodCellRecord = {
  frameId: number;
  tier: RenderObjectLodTier;
};

type LodCellKey = number | string;

const CELL_KEY_BITS = 17;
const CELL_KEY_BASE = 2 ** CELL_KEY_BITS;
const CELL_KEY_BIAS = 2 ** (CELL_KEY_BITS - 1);
const CELL_KEY_MAX = CELL_KEY_BASE - 1;

function packLodCellKey(ix: number, iy: number, iz: number): LodCellKey {
  const x = ix + CELL_KEY_BIAS;
  const y = iy + CELL_KEY_BIAS;
  const z = iz + CELL_KEY_BIAS;
  if (
    x >= 0 && x <= CELL_KEY_MAX &&
    y >= 0 && y <= CELL_KEY_MAX &&
    z >= 0 && z <= CELL_KEY_MAX
  ) {
    return (x * CELL_KEY_BASE + y) * CELL_KEY_BASE + z;
  }
  return `${ix},${iy},${iz}`;
}

export class RenderLodGrid {
  private frameId = 0;
  private view: RenderViewLodState | null = null;
  private cellSize = 128;
  private shells: RenderObjectLodShellDistances = {
    rich: 0,
    simple: 0,
    mass: 0,
    impostor: 0,
  };
  private cells = new Map<LodCellKey, LodCellRecord>();

  beginFrame(view: RenderViewLodState, gfx: GraphicsConfig): void {
    this.frameId = (this.frameId + 1) & 0x3fffffff;
    if (this.frameId === 0) {
      this.cells.clear();
      this.frameId = 1;
    }
    this.view = view;
    this.cellSize = normalizeLodCellSize(gfx.objectLodCellSize);
    this.shells = getRenderObjectLodShellDistances(gfx);
    if ((this.frameId & 63) === 0) this.pruneStaleCells();
  }

  resolve(worldX: number, worldY: number, worldZ: number): RenderObjectLodTier {
    const view = this.view;
    if (!view) return 'marker';

    const size = this.cellSize;
    const ix = lodCellIndex(worldX, size);
    const iy = lodCellIndex(worldY, size);
    const iz = lodCellIndex(worldZ, size);
    const key = packLodCellKey(ix, iy, iz);
    const cached = this.cells.get(key);
    if (cached?.frameId === this.frameId) return cached.tier;

    const cx = lodCellCenter(ix, size);
    const cy = lodCellCenter(iy, size);
    const cz = lodCellCenter(iz, size);
    const dx = cx - view.cameraX;
    const dy = cy - view.cameraY;
    const dz = cz - view.cameraZ;
    const tier = resolveRenderObjectLodForDistanceSq(dx * dx + dy * dy + dz * dz, this.shells);
    this.cells.set(key, { frameId: this.frameId, tier });
    return tier;
  }

  private pruneStaleCells(): void {
    const frameId = this.frameId;
    for (const [key, cell] of this.cells) {
      if (cell.frameId !== frameId) this.cells.delete(key);
    }
  }
}
