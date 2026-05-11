// Force field weapon system - spherical projectile shield boundary

import type { WorldState } from '../WorldState';
import type { ForceShot } from '../types';
import type { ForceFieldReflectionMode } from '../../../types/shotTypes';
import { getTransformCosSin } from '../../math';
import { updateWeaponWorldKinematics } from './combatUtils';
import { getUnitGroundZ } from '../unitGeometry';

const _forceFieldMount = { x: 0, y: 0, z: 0 };
const _forceFieldHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, playerId: 0, entityId: 0 };

// Compact list of force field weapons with progress > 0, built by
// updateForceFieldState() and consumed by projectile collision.
type ActiveForceFieldRef = {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  playerId: number;
  entityId: number;
};
const _activeForceFields: ActiveForceFieldRef[] = [];

// Reset module-level buffers (call between game sessions)
export function resetForceFieldBuffers(): void {
  _activeForceFields.length = 0;
}

// Update force field state (transition progress 0→1)
// currentForceFieldRange carries visual/gameplay progress (0→1) for serialization.
export function updateForceFieldState(world: WorldState, dtMs: number): void {
  _activeForceFields.length = 0;

  for (const unit of world.getForceFieldUnits()) {
    const turrets = unit.combat!.turrets;
    for (let weaponIndex = 0; weaponIndex < turrets.length; weaponIndex++) {
      const weapon = turrets[weaponIndex];
      const config = weapon.config;
      const shot = config.shot;
      if (!shot || shot.type !== 'force') continue;
      const fieldShot = shot as ForceShot;

      const transitionTime = fieldShot.transitionTime;

      // Initialize
      if (weapon.forceField === undefined) {
        weapon.forceField = { transition: 0, range: 0 };
      }

      // Move progress toward target based on engaged state
      const targetProgress = weapon.state === 'engaged' ? 1 : 0;
      const progressDelta = dtMs / transitionTime;

      if (weapon.forceField.transition < targetProgress) {
        weapon.forceField.transition = Math.min(weapon.forceField.transition + progressDelta, 1);
      } else if (weapon.forceField.transition > targetProgress) {
        weapon.forceField.transition = Math.max(weapon.forceField.transition - progressDelta, 0);
      }

      // Serialize progress as forceField.range (0→1)
      weapon.forceField.range = weapon.forceField.transition;

      if (weapon.forceField.transition > 0 && unit.unit && unit.unit.hp > 0) {
        const barrier = fieldShot.barrier;
        const radius = barrier?.outerRange ?? config.range;
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
          _forceFieldMount,
        );
        const originOffsetZ = barrier?.originOffsetZ ?? 0;
        _activeForceFields.push({
          centerX: mount.x,
          centerY: mount.y,
          centerZ: mount.z - originOffsetZ,
          radius,
          playerId: unit.ownership?.playerId ?? 0,
          entityId: unit.id,
        });
      }
    }
  }
}

export type ForceFieldProjectileIntersection = {
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

function forceFieldModeAllowsCrossing(
  mode: ForceFieldReflectionMode,
  radialVelocity: number,
): boolean {
  const eps = 1e-6;
  if (radialVelocity < -eps) return mode === 'outside-in' || mode === 'both';
  if (radialVelocity > eps) return mode === 'inside-out' || mode === 'both';
  return false;
}

function intersectForceFieldSphere(
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
  reflectionMode: ForceFieldReflectionMode,
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
    if (forceFieldModeAllowsCrossing(reflectionMode, radialVelocity)) return firstT;
  }

  if (secondT > 1e-6 && secondT <= 1 && secondT !== firstT) {
    const t = secondT;
    const hitX = startX + dx * t - centerX;
    const hitY = startY + dy * t - centerY;
    const hitZ = startZ + dz * t - centerZ;
    const radialVelocity = dx * hitX + dy * hitY + dz * hitZ;
    if (forceFieldModeAllowsCrossing(reflectionMode, radialVelocity)) return t;
  }
  return null;
}

export function findForceFieldSegmentIntersection(
  _world: WorldState,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
): ForceFieldProjectileIntersection | null {
  // Intentionally no projectile-owner/player filter here: a force-field
  // barrier is purely geometric. The world setting decides whether it
  // reflects incoming, outgoing, or both boundary crossings.
  const activeFields = _activeForceFields;
  if (activeFields.length === 0) return null;
  const reflectionMode = _world.forceFieldReflectionMode;
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
    const t = intersectForceFieldSphere(
      startX, startY, startZ,
      endX, endY, endZ,
      active.centerX, active.centerY, active.centerZ,
      active.radius,
      reflectionMode,
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
  _forceFieldHit.t = bestT;
  _forceFieldHit.x = bestX;
  _forceFieldHit.y = bestY;
  _forceFieldHit.z = bestZ;
  _forceFieldHit.nx = bestNx;
  _forceFieldHit.ny = bestNy;
  _forceFieldHit.nz = bestNz;
  _forceFieldHit.playerId = bestPlayerId;
  _forceFieldHit.entityId = bestEntityId;
  return _forceFieldHit;
}

export function findForceFieldProjectileIntersection(
  world: WorldState,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
): ForceFieldProjectileIntersection | null {
  return findForceFieldSegmentIntersection(
    world,
    startX, startY, startZ,
    endX, endY, endZ,
  );
}
