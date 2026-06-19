// Per-unit ground normal EMA. The terrain mesh is piecewise-flat at
// the triangle level, so the raw surface normal returned by
// `getSurfaceNormal(x, y)` SNAPS each time a unit crosses a triangle
// edge. Without smoothing, that snap shows up as visible jitter on the
// rendered chassis AND as a discontinuous shift in the turret-world-
// mount math (which uses surfaceN to slope-tilt mounts). This system
// owns the single canonical smoothed normal per unit.
//
// Stateful storage: WASM BodyPool surface-normal SoA, keyed by the
// unit physics body slot. `unit.surfaceNormal` is replaced with a
// BodyPool-backed view when the physics body is created, so existing
// readers still see a `{ nx, ny, nz }` shape without this system
// scattering values back onto JS unit objects every tick.
//
// Per-tick update: Rust walks occupied unit body slots, reads body
// positions from the BodyPool, samples the installed terrain mesh,
// EMA-blends toward the raw normal, renormalizes to unit length, and
// writes the BodyPool SoA in place. The blend factor is frame-rate
// independent via halfLifeBlend so the tick-rate slider doesn't
// change the perceived smoothing.
//
// Sim consumers (`commandExecution`, `commanderAbilities`,
// `combatUtils.resolveWeaponWorldMount` callers) read
// `unit.unit.surfaceNormal` directly instead of querying the position
// cache. On the host that object is a WASM-backed view; on clients it
// remains the plain snapshot-owned object populated from the wire.

import type { WorldState } from './WorldState';
import { halfLifeBlend } from '../network/driftEma';
import { getSimWasm } from '../sim-wasm/init';
import {
  UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC,
  UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT,
  type UnitGroundNormalEmaMode,
} from '../../shellConfig';
import { ENTITY_CHANGED_NORMAL } from '../../types/network';

let _activeMode: UnitGroundNormalEmaMode = UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT;
const SURFACE_NORMAL_DIRTY_EPSILON = 1e-6;
let _normalDirtyEntityIds = new Uint32Array(0);

function ensureNormalCapacity(required: number): void {
  if (_normalDirtyEntityIds.length >= required) return;
  _normalDirtyEntityIds = new Uint32Array(required);
}

/** Set the active unit ground normal EMA mode. Wired to the BATTLE bar and
 *  applied through the normal command path. */
export function setUnitGroundNormalEmaMode(mode: UnitGroundNormalEmaMode): void {
  _activeMode = mode;
}

export function getUnitGroundNormalEmaMode(): UnitGroundNormalEmaMode {
  return _activeMode;
}

function getUnitGroundNormalEmaHalfLife(): number {
  return UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC[_activeMode];
}

/** Update every unit's smoothed surface normal in place. Called once
 *  per sim tick from `Simulation.update()` BEFORE consumers (commander
 *  abilities, turret kinematics, locomotion) so this-tick reads see
 *  the freshly-blended value. */
export function updateUnitGroundNormal(world: WorldState, dtMs: number): void {
  const halfLife = getUnitGroundNormalEmaHalfLife();
  const dtSec = dtMs / 1000;
  const alpha = halfLifeBlend(dtSec, halfLife);
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('updateUnitGroundNormal: sim-wasm is not initialized');
  }

  ensureNormalCapacity(sim.pool.capacity);
  const dirtyCount = sim.unitGroundNormalStepPool(
    _normalDirtyEntityIds,
    alpha,
    SURFACE_NORMAL_DIRTY_EPSILON,
  );

  for (let i = 0; i < dirtyCount; i++) {
    world.markSnapshotDirty(_normalDirtyEntityIds[i], ENTITY_CHANGED_NORMAL);
  }
}
