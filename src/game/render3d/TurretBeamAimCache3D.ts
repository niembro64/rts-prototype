import { getTransformCosSin } from '../math/MathHelpers';
import { getTurretWorldMount } from '../math/MountGeometry';
import { getRuntimeTurretMount } from '../sim/turretMounts';
import { getUnitGroundZ } from '../sim/unitGeometry';
import type { Entity, EntityId } from '../sim/types';

/** Last firing direction of a beam, in SIM world coordinates
 *  (x/y horizontal, z up). Unit length. */
export type TurretBeamDir = { x: number; y: number; z: number };
export type TurretBeamAimSourceResolver = (entityId: EntityId) => Entity | undefined;

const FLAT_SURFACE_NORMAL = { nx: 0, ny: 0, nz: 1 };
const _mountScratch = { x: 0, y: 0, z: 0 };

function packKey(entityId: number, turretIdx: number): number {
  return entityId * 256 + (turretIdx & 0xff);
}

function resolveCurrentTurretMount(
  source: Entity,
  turretIdx: number,
): { x: number; y: number; z: number } | null {
  const turret = source.combat?.turrets[turretIdx];
  if (!turret) return null;

  const { cos, sin } = getTransformCosSin(source.transform);
  const localMount = getRuntimeTurretMount(turret);
  const suspension = source.unit?.suspension ?? null;
  return getTurretWorldMount(
    source.transform.x,
    source.transform.y,
    getUnitGroundZ(source),
    cos,
    sin,
    localMount.x + (suspension !== null ? suspension.offsetX : 0),
    localMount.y + (suspension !== null ? suspension.offsetY : 0),
    localMount.z + (suspension !== null ? suspension.offsetZ : 0),
    source.unit?.surfaceNormal ?? FLAT_SURFACE_NORMAL,
    _mountScratch,
  );
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
  collectFromBeamProjectiles(
    beamProjectiles: readonly Entity[],
    resolveSource?: TurretBeamAimSourceResolver,
  ): void {
    for (const e of beamProjectiles) {
      const proj = e.projectile;
      if (proj === null) continue;
      const pts = proj.points;
      if (!pts || pts.length < 2) continue;
      const ti = proj.config.turretIndex ?? 0;
      const ss = proj.shotSource;
      const id0 = proj.sourceEntityId;
      const id1 = ss?.sourceHostEntityId;
      const id2 = ss?.sourceRootEntityId;
      let start: { x: number; y: number; z: number } = pts[0];
      if (resolveSource !== undefined) {
        const source =
          (id0 ? resolveSource(id0) : undefined) ??
          (id1 ? resolveSource(id1) : undefined) ??
          (id2 ? resolveSource(id2) : undefined);
        if (source !== undefined) {
          start = resolveCurrentTurretMount(source, ti) ?? start;
        }
      }
      let dx = pts[1].x - start.x;
      let dy = pts[1].y - start.y;
      let dz = pts[1].z - start.z;
      let len = Math.hypot(dx, dy, dz);
      if (len < 1e-5 && start !== pts[0]) {
        dx = pts[1].x - pts[0].x;
        dy = pts[1].y - pts[0].y;
        dz = pts[1].z - pts[0].z;
        len = Math.hypot(dx, dy, dz);
      }
      if (len < 1e-5) continue;
      const inv = 1 / len;
      const ux = dx * inv;
      const uy = dy * inv;
      const uz = dz * inv;
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
