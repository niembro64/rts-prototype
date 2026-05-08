// Per-unit chassis-tilt EMA. The terrain mesh is piecewise-flat at
// the triangle level, so the raw surface normal returned by
// `getSurfaceNormal(x, y)` SNAPS each time a unit crosses a triangle
// edge. Without smoothing, that snap shows up as visible jitter on the
// rendered chassis AND as a discontinuous shift in the turret-world-
// mount math (which uses surfaceN to slope-tilt mounts). This system
// owns the single canonical smoothed normal per unit.
//
// Stateful storage: `unit.surfaceNormal: { nx, ny, nz }`. Initialized
// at spawn (in WorldState.createUnitBase) to the raw normal at the
// spawn position so the first post-spawn tick doesn't snap from the
// flat default to a tilted slope.
//
// Per-tick update: read raw normal at unit's current position, EMA-
// blend toward stored, renormalize to unit length, write back. The
// blend factor is frame-rate independent via halfLifeBlend so the
// tick-rate slider doesn't change the perceived smoothing.
//
// Sim consumers (`commandExecution`, `commanderAbilities`,
// `combatUtils.resolveWeaponWorldMount` callers) read
// `unit.unit.surfaceNormal` directly instead of querying the position
// cache. Renderer-side consumers eventually do the same once the wire
// payload ships the smoothed value (Phase 2).

import type { WorldState } from './WorldState';
import { magnitude3 } from '../math';
import { halfLifeBlend } from '../network/driftEma';
import { TILT_EMA_HALF_LIFE_SEC, TILT_EMA_MODE_DEFAULT, type TiltEmaMode } from '../../shellConfig';

let _activeMode: TiltEmaMode = TILT_EMA_MODE_DEFAULT;

/** Set the active tilt EMA mode. Wired to the HOST SERVER bar in
 *  Phase 3; until then this is a programmatic knob. */
export function setTiltEmaMode(mode: TiltEmaMode): void {
  _activeMode = mode;
}

export function getTiltEmaMode(): TiltEmaMode {
  return _activeMode;
}

export function getTiltEmaHalfLife(): number {
  return TILT_EMA_HALF_LIFE_SEC[_activeMode];
}

/** Update every unit's smoothed surface normal in place. Called once
 *  per sim tick from `Simulation.update()` BEFORE consumers (commander
 *  abilities, turret kinematics, locomotion) so this-tick reads see
 *  the freshly-blended value. */
export function updateUnitTilt(world: WorldState, dtMs: number): void {
  const halfLife = getTiltEmaHalfLife();
  const dtSec = dtMs / 1000;
  const alpha = halfLifeBlend(dtSec, halfLife);

  for (const entity of world.getUnits()) {
    const u = entity.unit;
    if (!u) continue;
    const raw = world.getCachedSurfaceNormal(entity.transform.x, entity.transform.y);
    const stored = u.surfaceNormal;

    if (alpha >= 1) {
      // SNAP mode (or first-tick on a fresh unit if alpha resolves to 1
      // via halfLife=0). Just copy — no need to renormalize, raw is
      // already unit length.
      stored.nx = raw.nx;
      stored.ny = raw.ny;
      stored.nz = raw.nz;
      continue;
    }

    // Linear blend in 3-space then renormalize. Lerping unit vectors
    // produces a sub-unit vector for non-collinear inputs; renormalize
    // so downstream consumers (quaternion math, slope-tilt mount math)
    // still get a unit normal.
    const nx = stored.nx + (raw.nx - stored.nx) * alpha;
    const ny = stored.ny + (raw.ny - stored.ny) * alpha;
    const nz = stored.nz + (raw.nz - stored.nz) * alpha;
    const len = magnitude3(nx, ny, nz);
    if (len > 1e-6) {
      const inv = 1 / len;
      stored.nx = nx * inv;
      stored.ny = ny * inv;
      stored.nz = nz * inv;
    } else {
      // Degenerate (anti-parallel inputs around the half-blend point —
      // shouldn't happen in practice for slope normals, but if it does,
      // snap to raw rather than zero out). Defensive only.
      stored.nx = raw.nx;
      stored.ny = raw.ny;
      stored.nz = raw.nz;
    }
  }
}
