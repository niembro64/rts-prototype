// Shield weapon system - spherical projectile shield boundary

import type { WorldState } from '../WorldState';
import type { ShieldConfig } from '../types';
import type { ShieldReflectionMode } from '../../../types/shotTypes';
import { getTransformCosSin } from '../../math';
import { CT_TURRET_STATE_ENGAGED } from '../../sim-wasm/init';
import { updateWeaponWorldKinematics } from './combatUtils';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from './targetingInputStamping';
import { getUnitGroundZ } from '../unitGeometry';

const _shieldMount = { x: 0, y: 0, z: 0 };
const _shieldHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, playerId: 0, entityId: 0 };
const _shieldFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_ENGAGED,
  targetId: -1,
};

// Compact list of shield weapons with progress > 0, built by
// updateShieldState() and consumed by projectile collision and the
// targeting LOS clearance check.
export type ActiveShieldRef = {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  reflectionMode: ShieldReflectionMode;
  playerId: number;
  entityId: number;
};
const _activeShields: ActiveShieldRef[] = [];

// Reset module-level buffers (call between game sessions)
export function resetShieldBuffers(): void {
  _activeShields.length = 0;
}

/** Read-only view of the active shield list maintained by
 *  updateShieldState. The targeting system reads this once per tick
 *  to gate lock-on against shield boundaries. Cached from the previous
 *  tick (shield update runs after targeting in Simulation.ts), so
 *  there is at most a one-tick lag when a field first forms or decays —
 *  imperceptible at 60 TPS. */
export function getActiveShields(): readonly ActiveShieldRef[] {
  return _activeShields;
}

// Update shield state (transition progress 0→1). The transition is
// host-owned because progress > 0 gates whether the barrier exists for
// projectile reflection / obstruction. The snapshot wire ships the same
// value as currentShieldRange so clients correct to server progress
// rather than running an independent visual-only timer.
export function updateShieldState(world: WorldState, dtMs: number): void {
  _activeShields.length = 0;

  for (const unit of world.getShieldUnits()) {
    const turrets = unit.combat!.turrets;
    for (let weaponIndex = 0; weaponIndex < turrets.length; weaponIndex++) {
      const weapon = turrets[weaponIndex];
      const config = weapon.config;
      const shot = config.shot;
      if (shot === undefined || shot.type !== 'shield') continue;
      const fieldShot = shot as ShieldConfig;

      const transitionTime = fieldShot.transitionTime;

      // Initialize
      if (weapon.shield === undefined) {
        weapon.shield = { transition: 0, range: 0 };
      }

      // Move progress toward target based on engaged state
      const engaged = readCombatTargetingTurretFsmInto(unit, weaponIndex, _shieldFsm)
        ? _shieldFsm.stateCode === CT_TURRET_STATE_ENGAGED
        : weapon.state === 'engaged';
      const targetProgress = engaged ? 1 : 0;
      const progressDelta = dtMs / transitionTime;

      if (weapon.shield.transition < targetProgress) {
        weapon.shield.transition = Math.min(weapon.shield.transition + progressDelta, 1);
      } else if (weapon.shield.transition > targetProgress) {
        weapon.shield.transition = Math.max(weapon.shield.transition - progressDelta, 0);
      }

      // Serialize authoritative barrier activation progress as
      // shield.range (0→1).
      weapon.shield.range = weapon.shield.transition;

      if (
        weapon.shield.transition > 0 &&
        unit.unit &&
        unit.unit.hp > 0 &&
        fieldShot.barrier !== undefined
      ) {
        const barrier = fieldShot.barrier;
        const radius = barrier.outerRange;
        if (radius <= 0) continue;
        const { cos: unitCos, sin: unitSin } = getTransformCosSin(unit.transform);
        const mount = updateWeaponWorldKinematics(
          unit, weapon, weaponIndex,
          unitCos, unitSin,
          {
            currentTick: world.getTick(),
            dtMs: 0,
            unitGroundZ: getUnitGroundZ(unit),
            surfaceN: unit.unit.surfaceNormal,
          },
          _shieldMount,
        );
        const originOffsetZ = barrier.originOffsetZ;
        const playerId = unit.ownership !== null ? unit.ownership.playerId : 0;
        _activeShields.push({
          centerX: mount.x,
          centerY: mount.y,
          centerZ: mount.z - originOffsetZ,
          radius,
          reflectionMode: fieldShot.material.reflection.mode,
          playerId,
          entityId: unit.id,
        });
      }
    }
  }
}

export type ShieldProjectileIntersection = {
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  playerId: number;
  entityId: number;
};

function shieldModeAllowsCrossing(
  mode: ShieldReflectionMode,
  radialVelocity: number,
): boolean {
  const eps = 1e-6;
  if (radialVelocity < -eps) return mode === 'outside-in' || mode === 'both';
  if (radialVelocity > eps) return mode === 'inside-out' || mode === 'both';
  return false;
}

export function encodeShieldReflectionMode(mode: ShieldReflectionMode): number {
  switch (mode) {
    case 'outside-in':
      return 0;
    case 'inside-out':
      return 1;
    case 'both':
      return 2;
  }
  return 2;
}

function intersectShieldSphere(
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  radius: number,
  reflectionMode: ShieldReflectionMode,
): number | null {
  const sx = startX - centerX;
  const sy = startY - centerY;
  const sz = startZ - centerZ;

  if (
    Math.max(startX, endX) < centerX - radius ||
    Math.min(startX, endX) > centerX + radius ||
    Math.max(startY, endY) < centerY - radius ||
    Math.min(startY, endY) > centerY + radius ||
    Math.max(startZ, endZ) < centerZ - radius ||
    Math.min(startZ, endZ) > centerZ + radius
  ) {
    return null;
  }

  const dx = endX - startX;
  const dy = endY - startY;
  const dz = endZ - startZ;
  const a = dx * dx + dy * dy + dz * dz;
  if (a <= 1e-9) return null;

  const radiusSq = radius * radius;
  const startDistSq = sx * sx + sy * sy + sz * sz;
  const startDotVelocity = sx * dx + sy * dy + sz * dz;
  const b = 2 * startDotVelocity;
  const c = startDistSq - radiusSq;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const invDenom = 1 / (2 * a);
  const t0 = (-b - sqrtDisc) * invDenom;
  const t1 = (-b + sqrtDisc) * invDenom;

  const firstT = Math.min(t0, t1);
  const secondT = Math.max(t0, t1);

  if (firstT > 1e-6 && firstT <= 1) {
    const hitX = startX + dx * firstT - centerX;
    const hitY = startY + dy * firstT - centerY;
    const hitZ = startZ + dz * firstT - centerZ;
    const radialVelocity = dx * hitX + dy * hitY + dz * hitZ;
    if (shieldModeAllowsCrossing(reflectionMode, radialVelocity)) return firstT;
  }

  if (secondT > 1e-6 && secondT <= 1 && secondT !== firstT) {
    const t = secondT;
    const hitX = startX + dx * t - centerX;
    const hitY = startY + dy * t - centerY;
    const hitZ = startZ + dz * t - centerZ;
    const radialVelocity = dx * hitX + dy * hitY + dz * hitZ;
    if (shieldModeAllowsCrossing(reflectionMode, radialVelocity)) return t;
  }
  return null;
}

export function findShieldSegmentIntersection(
  _world: WorldState,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
): ShieldProjectileIntersection | null {
  // Intentionally no projectile-owner/player filter here: a shield
  // barrier is material-owned. The surface material decides whether it
  // reflects incoming, outgoing, or both boundary crossings.
  const activeFields = _activeShields;
  if (activeFields.length === 0) return null;
  let bestT = Infinity;
  let bestX = 0;
  let bestY = 0;
  let bestZ = 0;
  let bestNx = 0;
  let bestNy = 0;
  let bestNz = 0;
  let bestPlayerId = 0;
  let bestEntityId = 0;

  for (let activeOrdinal = 0; activeOrdinal < activeFields.length; activeOrdinal++) {
    const active = activeFields[activeOrdinal];
    const t = intersectShieldSphere(
      startX, startY, startZ,
      endX, endY, endZ,
      active.centerX, active.centerY, active.centerZ,
      active.radius,
      active.reflectionMode,
    );
    if (t === null || t >= bestT) continue;

    const hitX = startX + (endX - startX) * t;
    const hitY = startY + (endY - startY) * t;
    const hitZ = startZ + (endZ - startZ) * t;
    const nx = hitX - active.centerX;
    const ny = hitY - active.centerY;
    const nz = hitZ - active.centerZ;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    bestT = t;
    bestX = hitX;
    bestY = hitY;
    bestZ = hitZ;
    bestNx = nx / nLen;
    bestNy = ny / nLen;
    bestNz = nz / nLen;
    bestPlayerId = active.playerId;
    bestEntityId = active.entityId;
  }

  if (bestT === Infinity) return null;
  _shieldHit.t = bestT;
  _shieldHit.x = bestX;
  _shieldHit.y = bestY;
  _shieldHit.z = bestZ;
  _shieldHit.nx = bestNx;
  _shieldHit.ny = bestNy;
  _shieldHit.nz = bestNz;
  _shieldHit.playerId = bestPlayerId;
  _shieldHit.entityId = bestEntityId;
  return _shieldHit;
}
