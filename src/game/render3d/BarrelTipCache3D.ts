import * as THREE from 'three';
import type { EntityId } from '../sim/types';

/** Barrel tip in sim/world coordinates: x/y ground plane, z height. */
export type BarrelTipEntry = { x: number; y: number; z: number };

const BARREL_TIP_LOCAL = new THREE.Vector3(0, 0.5, 0);

/** Pack `(entityId, turretIdx, barrelIdx)` into a single number safely
 *  within JS's 53-bit integer range. Caps: entityId fits in the top
 *  bits, 16 turret slots, 16 barrel slots. */
function packBarrelTipKey(entityId: number, turretIdx: number, barrelIdx: number): number {
  return entityId * 256 + (turretIdx & 0xf) * 16 + (barrelIdx & 0xf);
}

export class BarrelTipCache3D {
  private readonly cache = new Map<number, BarrelTipEntry>();
  private readonly pool: BarrelTipEntry[] = [];
  private poolIndex = 0;
  private readonly scratch = new THREE.Vector3();

  reset(): void {
    this.cache.clear();
    this.poolIndex = 0;
  }

  write(
    entityId: EntityId,
    turretIdx: number,
    barrelIdx: number,
    worldMatrix: THREE.Matrix4,
  ): void {
    this.scratch
      .copy(BARREL_TIP_LOCAL)
      .applyMatrix4(worldMatrix);
    const tipEntry = this.pool[this.poolIndex]
      ?? (this.pool[this.poolIndex] = { x: 0, y: 0, z: 0 });
    tipEntry.x = this.scratch.x;
    tipEntry.y = this.scratch.z;
    tipEntry.z = this.scratch.y;
    this.poolIndex++;
    this.cache.set(packBarrelTipKey(entityId, turretIdx, barrelIdx), tipEntry);
  }

  get(entityId: EntityId, turretIdx: number, barrelIdx: number): BarrelTipEntry | null {
    return this.cache.get(packBarrelTipKey(entityId, turretIdx, barrelIdx)) ?? null;
  }
}
