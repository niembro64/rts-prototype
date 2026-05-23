// Per-unit ground normal EMA. The terrain mesh is piecewise-flat at
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
let _normalEntities: number[] = [];
let _normalStoredX = new Float64Array(0);
let _normalStoredY = new Float64Array(0);
let _normalStoredZ = new Float64Array(0);
let _normalRawX = new Float64Array(0);
let _normalRawY = new Float64Array(0);
let _normalRawZ = new Float64Array(0);
let _normalOutX = new Float64Array(0);
let _normalOutY = new Float64Array(0);
let _normalOutZ = new Float64Array(0);
let _normalDirty = new Uint8Array(0);

function ensureNormalCapacity(required: number): void {
  if (_normalStoredX.length >= required) return;
  const next = Math.max(required, _normalStoredX.length * 2, 128);
  _normalStoredX = new Float64Array(next);
  _normalStoredY = new Float64Array(next);
  _normalStoredZ = new Float64Array(next);
  _normalRawX = new Float64Array(next);
  _normalRawY = new Float64Array(next);
  _normalRawZ = new Float64Array(next);
  _normalOutX = new Float64Array(next);
  _normalOutY = new Float64Array(next);
  _normalOutZ = new Float64Array(next);
  _normalDirty = new Uint8Array(next);
}

/** Set the active unit ground normal EMA mode. Wired to the HOST SERVER bar in
 *  Phase 3; until then this is a programmatic knob. */
export function setUnitGroundNormalEmaMode(mode: UnitGroundNormalEmaMode): void {
  _activeMode = mode;
}

export function getUnitGroundNormalEmaMode(): UnitGroundNormalEmaMode {
  return _activeMode;
}

export function getUnitGroundNormalEmaHalfLife(): number {
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

  const units = world.getUnits();
  ensureNormalCapacity(units.length);
  let count = 0;
  for (let i = 0; i < units.length; i++) {
    const entity = units[i];
    const u = entity.unit;
    if (!u) continue;
    const raw = world.getCachedSurfaceNormal(entity.transform.x, entity.transform.y);
    const stored = u.surfaceNormal;
    _normalEntities[count] = entity.id;
    _normalStoredX[count] = stored.nx;
    _normalStoredY[count] = stored.ny;
    _normalStoredZ[count] = stored.nz;
    _normalRawX[count] = raw.nx;
    _normalRawY[count] = raw.ny;
    _normalRawZ[count] = raw.nz;
    count++;
  }
  if (count === 0) {
    _normalEntities.length = 0;
    return;
  }

  sim.unitGroundNormalStepBatch(
    _normalStoredX.subarray(0, count),
    _normalStoredY.subarray(0, count),
    _normalStoredZ.subarray(0, count),
    _normalRawX.subarray(0, count),
    _normalRawY.subarray(0, count),
    _normalRawZ.subarray(0, count),
    _normalOutX.subarray(0, count),
    _normalOutY.subarray(0, count),
    _normalOutZ.subarray(0, count),
    _normalDirty.subarray(0, count),
    alpha,
    SURFACE_NORMAL_DIRTY_EPSILON,
  );

  for (let i = 0; i < count; i++) {
    const entityId = _normalEntities[i];
    const entity = world.getEntity(entityId);
    const unit = entity !== undefined ? entity.unit : undefined;
    if (unit !== undefined) {
      const stored = unit.surfaceNormal;
      stored.nx = _normalOutX[i];
      stored.ny = _normalOutY[i];
      stored.nz = _normalOutZ[i];
      if (_normalDirty[i] !== 0) {
        world.markSnapshotDirty(entityId, ENTITY_CHANGED_NORMAL);
      }
    }
  }
  _normalEntities.length = 0;
}
