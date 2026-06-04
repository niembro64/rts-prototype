import type { EntityId } from '../sim/types';

/** Last firing direction of a beam, in SIM world coordinates
 *  (x/y horizontal, z up). Unit length. */
export type TurretBeamDir = { x: number; y: number; z: number };

function packKey(entityId: number, turretIdx: number): number {
  return entityId * 256 + (turretIdx & 0xff);
}

/**
 * Persistent per-turret cache of the last beam-firing direction, the
 * channel by which a beam tells its turret where to point.
 *
 * The beam renderer records the live firing direction of every active
 * beam each frame (see `BeamRenderer3D`); the turret-pose pass reads it
 * back to aim beam-directed barrels (`turretBarrelFollowsBeam`). Unlike
 * `TurretMountCache3D`, entries are NOT cleared per frame: when a beam
 * stops, the last direction persists so the barrel freezes pointing
 * wherever it last fired instead of snapping back to forward. Entries
 * are dropped only when their host entity is removed.
 */
export class TurretBeamAimCache3D {
  private readonly dirs = new Map<number, TurretBeamDir>();

  /** Record a turret's current beam direction (sim world coords, unit length). */
  record(entityId: EntityId, turretIdx: number, x: number, y: number, z: number): void {
    const key = packKey(entityId, turretIdx);
    const entry = this.dirs.get(key);
    if (entry) {
      entry.x = x;
      entry.y = y;
      entry.z = z;
    } else {
      this.dirs.set(key, { x, y, z });
    }
  }

  /** Last recorded beam direction, or null if this turret never fired. */
  get(entityId: EntityId, turretIdx: number): TurretBeamDir | null {
    return this.dirs.get(packKey(entityId, turretIdx)) ?? null;
  }

  /** Drop every turret entry for a removed entity. Keys pack
   *  entityId * 256 + turretIdx, so sweep the small id range that could
   *  collide. Called on precise entity removal (unit + building paths)
   *  rather than via a per-frame seen-set, because the cache is shared
   *  across unit- and tower-mounted beam turrets. */
  delete(entityId: EntityId): void {
    for (let turretIdx = 0; turretIdx < 256; turretIdx++) {
      this.dirs.delete(packKey(entityId, turretIdx));
    }
  }

  clear(): void {
    this.dirs.clear();
  }
}
