import type { GraphicsConfig } from '@/types/graphics';
import {
  CANONICAL_LAND_CELL_SIZE,
  assertCanonicalLandGridSymmetry,
  landCellCenterForSize,
  landCellIndexForSize,
  landCellKeyForIndex,
} from '../landGrid';
import type { RenderViewLodState } from './Lod3D';
import {
  getRenderObjectLodShellDistances,
  type RenderObjectLodShellDistances,
  type RenderObjectLodTier,
} from './RenderObjectLod';

export class RenderLodGrid {
  private view: RenderViewLodState | null = null;
  private cellSize = 128;
  private shells: RenderObjectLodShellDistances = {
    rich: 0,
    simple: 0,
    mass: 0,
    impostor: 0,
  };
  private shellDistanceSq: RenderObjectLodShellDistances = {
    rich: 0,
    simple: 0,
    mass: 0,
    impostor: 0,
  };
  private cellTiers = new Map<number, RenderObjectLodTier>();
  private cellFrames = new Map<number, number>();
  private frameId = 0;
  private structuralKey = '';
  // PLAYER CLIENT "BASE" mode override. When the active GraphicsConfig
  // pins a tier, every cell returns it directly — distance + cache
  // lookups are skipped entirely.
  private forcedTier: RenderObjectLodTier | undefined;

  beginFrame(view: RenderViewLodState, gfx: GraphicsConfig): void {
    this.view = view;
    this.forcedTier = gfx.forcedObjectTier;
    assertCanonicalLandGridSymmetry(gfx.objectLodCellSize);
    this.cellSize = CANONICAL_LAND_CELL_SIZE;
    this.shells = getRenderObjectLodShellDistances(gfx);
    this.shellDistanceSq.rich = this.shells.rich * this.shells.rich;
    this.shellDistanceSq.simple = this.shells.simple * this.shells.simple;
    this.shellDistanceSq.mass = this.shells.mass * this.shells.mass;
    this.shellDistanceSq.impostor = this.shells.impostor * this.shells.impostor;
    // Forced tier folded into the structural key so a BASE-mode flip
    // (or a tier change while BASE is on) invalidates the per-frame
    // cell cache the same way a sphere-radius change does.
    const nextStructuralKey = [
      this.cellSize,
      this.shells.rich,
      this.shells.simple,
      this.shells.mass,
      this.shells.impostor,
      this.forcedTier ?? '-',
    ].join('|');
    if (nextStructuralKey !== this.structuralKey || this.frameId >= 0x3fffffff) {
      this.cellTiers.clear();
      this.cellFrames.clear();
      this.frameId = 0;
      this.structuralKey = nextStructuralKey;
    }
    this.frameId++;
  }

  resolve(worldX: number, _worldY: number, worldZ: number): RenderObjectLodTier {
    const size = this.cellSize;
    return this.resolveCell(
      landCellIndexForSize(worldX, size),
      landCellIndexForSize(worldZ, size),
    );
  }

  resolveCell(ix: number, iz: number): RenderObjectLodTier {
    if (this.forcedTier) return this.forcedTier;
    const view = this.view;
    if (!view) return 'marker';

    const size = this.cellSize;
    const key = landCellKeyForIndex(ix, iz);
    if (this.cellFrames.get(key) === this.frameId) {
      return this.cellTiers.get(key) ?? 'marker';
    }

    const cx = landCellCenterForSize(ix, size);
    const cz = landCellCenterForSize(iz, size);
    const dx = cx - view.cameraX;
    const dy = -view.cameraY;
    const dz = cz - view.cameraZ;
    const distanceSq = dx * dx + dy * dy + dz * dz;
    const shellSq = this.shellDistanceSq;
    let tier: RenderObjectLodTier = 'marker';
    if (shellSq.rich > 0 && distanceSq <= shellSq.rich) tier = 'rich';
    else if (shellSq.simple > 0 && distanceSq <= shellSq.simple) tier = 'simple';
    else if (shellSq.mass > 0 && distanceSq <= shellSq.mass) tier = 'mass';
    else if (shellSq.impostor > 0 && distanceSq <= shellSq.impostor) tier = 'impostor';
    this.cellTiers.set(key, tier);
    this.cellFrames.set(key, this.frameId);
    return tier;
  }
}
