import type { GraphicsConfig } from '@/types/graphics';
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
  private cells = new Map<number, Map<number, Map<number, LodCellRecord>>>();

  beginFrame(view: RenderViewLodState, gfx: GraphicsConfig): void {
    this.frameId = (this.frameId + 1) & 0x3fffffff;
    if (this.frameId === 0) {
      this.cells.clear();
      this.frameId = 1;
    }
    this.view = view;
    this.cellSize = Math.max(16, gfx.objectLodCellSize);
    this.shells = getRenderObjectLodShellDistances(gfx);
    if ((this.frameId & 63) === 0) this.pruneStaleCells();
  }

  resolve(worldX: number, worldY: number, worldZ: number): RenderObjectLodTier {
    const view = this.view;
    if (!view) return 'hidden';

    const size = this.cellSize;
    const ix = Math.floor(worldX / size);
    const iy = Math.floor(worldY / size);
    const iz = Math.floor(worldZ / size);
    const cached = this.getCell(ix, iy, iz);
    if (cached?.frameId === this.frameId) return cached.tier;

    const cx = (ix + 0.5) * size;
    const cy = (iy + 0.5) * size;
    const cz = (iz + 0.5) * size;
    const dx = cx - view.cameraX;
    const dy = cy - view.cameraY;
    const dz = cz - view.cameraZ;
    const tier = resolveRenderObjectLodForDistanceSq(dx * dx + dy * dy + dz * dz, this.shells);
    this.setCell(ix, iy, iz, { frameId: this.frameId, tier });
    return tier;
  }

  private getCell(ix: number, iy: number, iz: number): LodCellRecord | undefined {
    return this.cells.get(ix)?.get(iy)?.get(iz);
  }

  private setCell(ix: number, iy: number, iz: number, record: LodCellRecord): void {
    let yCells = this.cells.get(ix);
    if (!yCells) {
      yCells = new Map();
      this.cells.set(ix, yCells);
    }
    let zCells = yCells.get(iy);
    if (!zCells) {
      zCells = new Map();
      yCells.set(iy, zCells);
    }
    zCells.set(iz, record);
  }

  private pruneStaleCells(): void {
    const frameId = this.frameId;
    for (const [ix, yCells] of this.cells) {
      for (const [iy, zCells] of yCells) {
        for (const [iz, cell] of zCells) {
          if (cell.frameId !== frameId) zCells.delete(iz);
        }
        if (zCells.size === 0) yCells.delete(iy);
      }
      if (yCells.size === 0) this.cells.delete(ix);
    }
  }
}
