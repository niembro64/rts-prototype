import type { EntityId } from '../sim/types';

export type TurretMountEntry = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
};

type PreviousTurretMountEntry = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  frame: number;
};

function packTurretMountKey(entityId: number, turretIdx: number): number {
  return entityId * 256 + (turretIdx & 0xff);
}

export class TurretMountCache3D {
  private readonly current = new Map<number, TurretMountEntry>();
  private readonly previous = new Map<number, PreviousTurretMountEntry>();
  private readonly pool: TurretMountEntry[] = [];
  private poolIndex = 0;
  private dtSec = 0;
  private frame = 0;

  reset(dtMs: number): void {
    this.current.clear();
    this.poolIndex = 0;
    this.dtSec = dtMs > 0 ? dtMs / 1000 : 0;
    this.frame++;
  }

  write(entityId: EntityId, turretIdx: number, x: number, y: number, z: number): void {
    const key = packTurretMountKey(entityId, turretIdx);
    const prev = this.previous.get(key);
    const entry = this.pool[this.poolIndex]
      ?? (this.pool[this.poolIndex] = {
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        ax: 0, ay: 0, az: 0,
      });
    this.poolIndex++;

    entry.x = x;
    entry.y = y;
    entry.z = z;
    if (prev && prev.frame === this.frame - 1 && this.dtSec > 0) {
      const inv = 1 / this.dtSec;
      entry.vx = (x - prev.x) * inv;
      entry.vy = (y - prev.y) * inv;
      entry.vz = (z - prev.z) * inv;
      entry.ax = (entry.vx - prev.vx) * inv;
      entry.ay = (entry.vy - prev.vy) * inv;
      entry.az = (entry.vz - prev.vz) * inv;
    } else {
      entry.vx = 0;
      entry.vy = 0;
      entry.vz = 0;
      entry.ax = 0;
      entry.ay = 0;
      entry.az = 0;
    }
    this.current.set(key, entry);

    const previous = this.previous.get(key)
      ?? { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, frame: 0 };
    previous.x = x;
    previous.y = y;
    previous.z = z;
    previous.vx = entry.vx;
    previous.vy = entry.vy;
    previous.vz = entry.vz;
    previous.frame = this.frame;
    this.previous.set(key, previous);
  }

  get(entityId: EntityId, turretIdx: number): TurretMountEntry | null {
    return this.current.get(packTurretMountKey(entityId, turretIdx)) ?? null;
  }
}
