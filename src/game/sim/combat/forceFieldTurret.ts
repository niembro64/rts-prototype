// Force field weapon system - spherical projectile shield boundary

import type { WorldState } from '../WorldState';
import type { Entity, ForceShot, Turret } from '../types';
import { getTransformCosSin } from '../../math';
import { updateWeaponWorldKinematics } from './combatUtils';
import { getUnitGroundZ } from '../unitGeometry';

const _forceFieldMount = { x: 0, y: 0, z: 0 };
const _forceFieldHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, playerId: 0, entityId: 0 };

// Compact list of force field weapons with progress > 0, built by
// updateForceFieldState() and consumed by projectile collision.
type ActiveForceFieldRef = {
  unit: Entity;
  weapon: Turret;
  weaponIndex: number;
  shot: ForceShot;
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
    for (let weaponIndex = 0; weaponIndex < unit.turrets!.length; weaponIndex++) {
      const weapon = unit.turrets![weaponIndex];
      const config = weapon.config;
      if (config.shot.type !== 'force') continue;
      const fieldShot = config.shot as ForceShot;

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
        _activeForceFields.push({ unit, weapon, weaponIndex, shot: fieldShot });
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

function intersectOutsideToInsideSphere(
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
): number | null {
  const sx = startX - centerX;
  const sy = startY - centerY;
  const sz = startZ - centerZ;
  const radiusSq = radius * radius;
  const startDistSq = sx * sx + sy * sy + sz * sz;
  // Shield only stops projectiles that begin outside and cross inward.
  // Inside-starting projectiles, including friendly shots fired from
  // inside the bubble, are not clipped by the barrier.
  if (startDistSq <= radiusSq) return null;

  const dx = endX - startX;
  const dy = endY - startY;
  const dz = endZ - startZ;
  const a = dx * dx + dy * dy + dz * dz;
  if (a <= 1e-9) return null;
  const b = 2 * (sx * dx + sy * dy + sz * dz);
  const c = startDistSq - radiusSq;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const invDenom = 1 / (2 * a);
  const t = (-b - sqrtDisc) * invDenom;
  if (t < 0 || t > 1) return null;

  const hitX = startX + dx * t - centerX;
  const hitY = startY + dy * t - centerY;
  const hitZ = startZ + dz * t - centerZ;
  // Negative dot means the segment is entering the sphere at this
  // intersection. Exiting or tangential paths are unaffected.
  const radialVelocity = dx * hitX + dy * hitY + dz * hitZ;
  return radialVelocity < 0 ? t : null;
}

export function findForceFieldSegmentIntersection(
  world: WorldState,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
): ForceFieldProjectileIntersection | null {
  // Intentionally no projectile-owner/player filter here: a force-field
  // barrier is purely geometric and stops any non-rocket projectile that
  // crosses from outside the sphere to inside.
  const activeFields = _activeForceFields;
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
    const unit = active.unit;
    const weapon = active.weapon;
    const weaponIndex = active.weaponIndex;
    const fieldShot = active.shot;
    const fieldPlayerId = unit.ownership?.playerId ?? 0;
    const { cos: unitCos, sin: unitSin } = getTransformCosSin(unit.transform);

    const progress = weapon.forceField?.transition ?? (weapon.forceField?.range ?? 0);
    if (progress <= 0) continue;

    const radius = fieldShot.barrier?.outerRange ?? weapon.config.range;
    if (radius <= 0) continue;

    const mount = updateWeaponWorldKinematics(
      unit, weapon, weaponIndex,
      unitCos, unitSin,
      {
        currentTick: world.getTick(),
        dtMs: 0,
        unitGroundZ: getUnitGroundZ(unit),
        surfaceN: unit.unit?.surfaceNormal,
      },
      _forceFieldMount,
    );
    const t = intersectOutsideToInsideSphere(
      startX, startY, startZ,
      endX, endY, endZ,
      mount.x, mount.y, mount.z,
      radius,
    );
    if (t === null || t >= bestT) continue;

    const hitX = startX + (endX - startX) * t;
    const hitY = startY + (endY - startY) * t;
    const hitZ = startZ + (endZ - startZ) * t;
    const nx = hitX - mount.x;
    const ny = hitY - mount.y;
    const nz = hitZ - mount.z;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    bestT = t;
    bestX = hitX;
    bestY = hitY;
    bestZ = hitZ;
    bestNx = nx / nLen;
    bestNy = ny / nLen;
    bestNz = nz / nLen;
    bestPlayerId = fieldPlayerId;
    bestEntityId = unit.id;
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
