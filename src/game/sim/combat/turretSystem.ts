// Turret rotation system - acceleration-based physics for weapon turrets
// Phase 4: WASM batch processing when available, JS fallback otherwise.

import type { WorldState } from '../WorldState';
import type { Turret } from '../types';
import { normalizeAngle, getMovementAngle, resolveWeaponWorldPos } from './combatUtils';
import { getTransformCosSin } from '../../math';
import { TURRET_RETURN_TO_FORWARD } from '../../../config';
import { getWasmEngine, getWasmMemory } from '../../server/WasmBatch';

// Cache for drag factors (JS fallback path)
const _dragFactorCache = new Map<number, number>();

// Reusable array for collecting turret references (avoids allocation per frame)
let _turretRefs: Turret[] = [];
let _targetAngles: number[] = [];
let _hasTargets: number[] = [];

export function updateTurretRotation(world: WorldState, dtMs: number): void {
  const wasmEngine = getWasmEngine();
  const wasmMemory = getWasmMemory();

  if (wasmEngine && wasmMemory) {
    updateTurretRotationWasm(world, dtMs, wasmEngine, wasmMemory);
  } else {
    updateTurretRotationJS(world, dtMs);
  }
}

// WASM batch path: JS computes target angles, WASM does integration
function updateTurretRotationWasm(
  world: WorldState,
  dtMs: number,
  wasmEngine: NonNullable<ReturnType<typeof getWasmEngine>>,
  wasmMemory: WebAssembly.Memory,
): void {
  const dtSec = dtMs / 1000;

  // Pass 1: collect turrets and compute target angles (requires entity lookups)
  _turretRefs.length = 0;
  _targetAngles.length = 0;
  _hasTargets.length = 0;

  for (const unit of world.getUnits()) {
    if (!unit.unit || !unit.ownership || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const { cos, sin } = getTransformCosSin(unit.transform);

    for (const weapon of unit.turrets) {
      let targetAngle = 0;
      let hasTarget = 0;

      if (weapon.target !== null) {
        const target = world.getEntity(weapon.target);
        if (target) {
          const wp = resolveWeaponWorldPos(weapon, unit.transform.x, unit.transform.y, cos, sin);
          const dx = target.transform.x - wp.x;
          const dy = target.transform.y - wp.y;
          targetAngle = Math.atan2(dy, dx);
          hasTarget = 1;
        }
      }

      if (!hasTarget) {
        if (TURRET_RETURN_TO_FORWARD) {
          targetAngle = getMovementAngle(unit);
          hasTarget = 1;
        }
        // else hasTarget stays 0 — WASM will just apply drag
      }

      _turretRefs.push(weapon);
      _targetAngles.push(targetAngle);
      _hasTargets.push(hasTarget);
    }
  }

  const count = _turretRefs.length;
  if (count === 0) return;

  // Pass 2: pack data into WASM input buffer
  const inPtr = wasmEngine.turret_in_alloc(count);
  const inBuf = new Float64Array(wasmMemory.buffer, inPtr, count * 6);

  for (let i = 0; i < count; i++) {
    const w = _turretRefs[i];
    const base = i * 6;
    inBuf[base] = w.rotation;
    inBuf[base + 1] = w.angularVelocity;
    inBuf[base + 2] = w.turnAccel;
    inBuf[base + 3] = w.drag;
    inBuf[base + 4] = _targetAngles[i];
    inBuf[base + 5] = _hasTargets[i];
  }

  // Pass 3: run WASM batch update (one boundary crossing for all turrets)
  const outPtr = wasmEngine.turret_update(count, dtSec);
  const outBuf = new Float64Array(wasmMemory.buffer, outPtr, count * 2);

  // Pass 4: write results back to turret objects
  for (let i = 0; i < count; i++) {
    const base = i * 2;
    _turretRefs[i].rotation = outBuf[base];
    _turretRefs[i].angularVelocity = outBuf[base + 1];
  }
}

// JS fallback path (original implementation)
function updateTurretRotationJS(world: WorldState, dtMs: number): void {
  const dtSec = dtMs / 1000;
  const dtFrames = dtSec * 60;
  _dragFactorCache.clear();

  for (const unit of world.getUnits()) {
    if (!unit.unit || !unit.ownership || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const { cos, sin } = getTransformCosSin(unit.transform);

    for (const weapon of unit.turrets) {
      let targetAngle: number | null = null;
      let hasActiveTarget = false;

      if (weapon.target !== null) {
        const target = world.getEntity(weapon.target);
        if (target) {
          const wp = resolveWeaponWorldPos(weapon, unit.transform.x, unit.transform.y, cos, sin);
          const weaponX = wp.x, weaponY = wp.y;
          const dx = target.transform.x - weaponX;
          const dy = target.transform.y - weaponY;
          targetAngle = Math.atan2(dy, dx);
          hasActiveTarget = true;
        }
      }

      let dragFactor = _dragFactorCache.get(weapon.drag);
      if (dragFactor === undefined) {
        dragFactor = Math.pow(1 - weapon.drag, dtFrames);
        _dragFactorCache.set(weapon.drag, dragFactor);
      }

      if (!hasActiveTarget) {
        if (TURRET_RETURN_TO_FORWARD) {
          targetAngle = getMovementAngle(unit);
        } else {
          weapon.angularVelocity *= dragFactor;
          weapon.rotation += weapon.angularVelocity * dtSec;
          weapon.rotation = normalizeAngle(weapon.rotation);
          continue;
        }
      }

      const angleDiff = normalizeAngle(targetAngle! - weapon.rotation);
      const accelDirection = Math.sign(angleDiff);
      weapon.angularVelocity += accelDirection * weapon.turnAccel * dtSec;
      weapon.angularVelocity *= dragFactor;
      weapon.rotation += weapon.angularVelocity * dtSec;
      weapon.rotation = normalizeAngle(weapon.rotation);
    }
  }
}
