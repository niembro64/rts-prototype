import type { Entity, EntityId } from '../sim/types';

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
 * The entity renderer records the live firing direction of every active
 * beam each frame from its first segment; the turret-pose pass reads it back
 * to aim beam-directed barrels (`turretBarrelFollowsBeam`). Unlike
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

  /** Populate from active beam line-projectiles before unit/building turret
   *  pose passes read this frame's directed barrel aim. */
  collectFromBeamProjectiles(beamProjectiles: readonly Entity[]): void {
    for (const e of beamProjectiles) {
      const proj = e.projectile;
      if (proj === null) continue;
      const pts = proj.points;
      if (!pts || pts.length < 2) continue;
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const dz = pts[1].z - pts[0].z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-5) continue;
      const inv = 1 / len;
      const ux = dx * inv;
      const uy = dy * inv;
      const uz = dz * inv;
      const ti = proj.config.turretIndex ?? 0;
      const ss = proj.shotSource;
      const id0 = proj.sourceEntityId;
      const id1 = ss?.sourceHostEntityId;
      const id2 = ss?.sourceRootEntityId;
      if (id0) this.record(id0, ti, ux, uy, uz);
      if (id1 && id1 !== id0) this.record(id1, ti, ux, uy, uz);
      if (id2 && id2 !== id0 && id2 !== id1) this.record(id2, ti, ux, uy, uz);
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
