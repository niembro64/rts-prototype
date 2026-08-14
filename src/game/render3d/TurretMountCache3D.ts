import type { EntityId } from '../sim/types';

export type TurretMountEntry = {
  x: number;
  y: number;
  z: number;
  /** Current rendered barrel direction in simulation coordinates. */
  forwardX: number;
  forwardY: number;
  forwardZ: number;
  hasForward: boolean;
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

function packTurretEmissionKey(entityId: number, turretIdx: number, laneIdx: number): number {
  return entityId * 65536 + ((turretIdx & 0xff) << 8) + (laneIdx & 0xff);
}

export class TurretMountCache3D {
  private readonly current = new Map<number, TurretMountEntry>();
  private readonly previous = new Map<number, PreviousTurretMountEntry>();
  private readonly pool: TurretMountEntry[] = [];
  private readonly emissionCurrent = new Map<number, TurretMountEntry>();
  private readonly emissionPrevious = new Map<number, PreviousTurretMountEntry>();
  private readonly emissionPool: TurretMountEntry[] = [];
  private poolIndex = 0;
  private emissionPoolIndex = 0;
  private dtSec = 0;
  private frame = 0;

  reset(dtMs: number): void {
    this.current.clear();
    this.emissionCurrent.clear();
    this.poolIndex = 0;
    this.emissionPoolIndex = 0;
    this.dtSec = dtMs > 0 ? dtMs / 1000 : 0;
    this.frame++;
  }

  write(entityId: EntityId, turretIdx: number, x: number, y: number, z: number): void {
    const key = packTurretMountKey(entityId, turretIdx);
    const prev = this.previous.get(key);
    const entry = this.pool[this.poolIndex]
      ?? (this.pool[this.poolIndex] = {
        x: 0, y: 0, z: 0,
        forwardX: 1, forwardY: 0, forwardZ: 0,
        hasForward: false,
        vx: 0, vy: 0, vz: 0,
        ax: 0, ay: 0, az: 0,
      });
    this.poolIndex++;

    entry.x = x;
    entry.y = y;
    entry.z = z;
    entry.forwardX = 1;
    entry.forwardY = 0;
    entry.forwardZ = 0;
    entry.hasForward = false;
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

  /** Add the rendered barrel direction after the head/mount row has been
   * written. Per-lane emission positions are stored separately below. */
  writeForward(
    entityId: EntityId,
    turretIdx: number,
    forwardX: number,
    forwardY: number,
    forwardZ: number,
  ): void {
    const entry = this.current.get(packTurretMountKey(entityId, turretIdx));
    if (entry === undefined) return;
    entry.forwardX = forwardX;
    entry.forwardY = forwardY;
    entry.forwardZ = forwardZ;
    entry.hasForward = true;
  }

  /** Write one rendered QueryWeapon origin. Barrel matrices are resolved after
   * the host piece chain, so this cache is the presentation counterpart of the
   * sim's per-lane authoritative socket query. Projectile weapons normally use
   * a muzzle tip; beam pilot lights use their broad base at the turret origin. */
  writeEmission(
    entityId: EntityId,
    turretIdx: number,
    laneIdx: number,
    x: number,
    y: number,
    z: number,
    forwardX: number,
    forwardY: number,
    forwardZ: number,
  ): void {
    const key = packTurretEmissionKey(entityId, turretIdx, laneIdx);
    const prev = this.emissionPrevious.get(key);
    const entry = this.emissionPool[this.emissionPoolIndex]
      ?? (this.emissionPool[this.emissionPoolIndex] = {
        x: 0, y: 0, z: 0,
        forwardX: 1, forwardY: 0, forwardZ: 0,
        hasForward: true,
        vx: 0, vy: 0, vz: 0,
        ax: 0, ay: 0, az: 0,
      });
    this.emissionPoolIndex++;
    entry.x = x;
    entry.y = y;
    entry.z = z;
    entry.forwardX = forwardX;
    entry.forwardY = forwardY;
    entry.forwardZ = forwardZ;
    entry.hasForward = true;
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
    this.emissionCurrent.set(key, entry);
    const previous = this.emissionPrevious.get(key)
      ?? { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, frame: 0 };
    previous.x = x;
    previous.y = y;
    previous.z = z;
    previous.vx = entry.vx;
    previous.vy = entry.vy;
    previous.vz = entry.vz;
    previous.frame = this.frame;
    this.emissionPrevious.set(key, previous);
  }

  get(entityId: EntityId, turretIdx: number): TurretMountEntry | null {
    return this.current.get(packTurretMountKey(entityId, turretIdx)) ?? null;
  }

  getEmission(entityId: EntityId, turretIdx: number, laneIdx: number): TurretMountEntry | null {
    return this.emissionCurrent.get(
      packTurretEmissionKey(entityId, turretIdx, laneIdx),
    ) ?? null;
  }

  delete(entityId: EntityId): void {
    for (let turretIdx = 0; turretIdx < 256; turretIdx++) {
      const key = packTurretMountKey(entityId, turretIdx);
      this.current.delete(key);
      this.previous.delete(key);
    }
    for (const key of this.emissionCurrent.keys()) {
      if (Math.floor(key / 65536) === entityId) this.emissionCurrent.delete(key);
    }
    for (const key of this.emissionPrevious.keys()) {
      if (Math.floor(key / 65536) === entityId) this.emissionPrevious.delete(key);
    }
  }
}
