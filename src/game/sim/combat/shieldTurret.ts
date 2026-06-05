// Shield weapon system - projectile shield boundaries

import type { WorldState } from '../WorldState';
import type { ShieldConfig } from '../types';
import type { ShieldBarrierShape, ShieldReflectionMode } from '../../../types/shotTypes';
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
const SHIELD_FIRE_YAW_TOLERANCE = 0.16;
const SHIELD_FIRE_PITCH_TOLERANCE = 0.16;

function isAimedCylinderReadyForEmission(weapon: { aimErrorYaw: number; aimErrorPitch: number }): boolean {
  return (
    Math.abs(weapon.aimErrorYaw) <= SHIELD_FIRE_YAW_TOLERANCE &&
    Math.abs(weapon.aimErrorPitch) <= SHIELD_FIRE_PITCH_TOLERANCE
  );
}

// Compact list of shield weapons with progress > 0, built by
// updateShieldState() and consumed by projectile collision and the
// targeting LOS clearance check.
export type ActiveShieldRef = {
  shape: ShieldBarrierShape;
  prevCenterX: number;
  prevCenterY: number;
  prevCenterZ: number;
  prevAxisEndX: number;
  prevAxisEndY: number;
  prevAxisEndZ: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  axisEndX: number;
  axisEndY: number;
  axisEndZ: number;
  radius: number;
  reflectionMode: ShieldReflectionMode;
  playerId: number;
  entityId: number;
};
const _activeShields: ActiveShieldRef[] = [];
type ShieldPose = {
  centerX: number;
  centerY: number;
  centerZ: number;
  axisEndX: number;
  axisEndY: number;
  axisEndZ: number;
};
let _previousShieldPoses = new Map<string, ShieldPose>();
let _nextShieldPoses = new Map<string, ShieldPose>();

// Reset module-level buffers (call between game sessions)
export function resetShieldBuffers(): void {
  _activeShields.length = 0;
  _previousShieldPoses.clear();
  _nextShieldPoses.clear();
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
  _nextShieldPoses.clear();

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
      const hasTargetingFsm = readCombatTargetingTurretFsmInto(unit, weaponIndex, _shieldFsm);
      const engaged = hasTargetingFsm
        ? _shieldFsm.stateCode === CT_TURRET_STATE_ENGAGED
        : weapon.state === 'engaged';
      const targetId = hasTargetingFsm ? _shieldFsm.targetId : (weapon.target ?? -1);
      const aimedCylinderReady = fieldShot.barrier?.shape === 'aimedCylinder'
        ? isAimedCylinderReadyForEmission(weapon)
        : true;
      const targetProgress = engaged && aimedCylinderReady ? 1 : 0;
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
        const centerX = mount.x;
        const centerY = mount.y;
        const centerZ = mount.z - originOffsetZ;
        let axisEndX = centerX;
        let axisEndY = centerY;
        let axisEndZ = centerZ;
        if (barrier.shape === 'aimedCylinder') {
          if (targetId === -1) continue;
          const pitchCos = Math.cos(weapon.pitch);
          axisEndX = centerX + Math.cos(weapon.rotation) * pitchCos * config.range;
          axisEndY = centerY + Math.sin(weapon.rotation) * pitchCos * config.range;
          axisEndZ = centerZ + Math.sin(weapon.pitch) * config.range;
          if (Math.hypot(axisEndX - centerX, axisEndY - centerY, axisEndZ - centerZ) <= 1e-6) {
            continue;
          }
        }
        const poseKey = `${unit.id}:${weapon.id}:${weaponIndex}`;
        const previousPose = _previousShieldPoses.get(poseKey);
        _nextShieldPoses.set(poseKey, {
          centerX,
          centerY,
          centerZ,
          axisEndX,
          axisEndY,
          axisEndZ,
        });
        const playerId = unit.ownership !== null ? unit.ownership.playerId : 0;
        _activeShields.push({
          shape: barrier.shape,
          prevCenterX: previousPose?.centerX ?? centerX,
          prevCenterY: previousPose?.centerY ?? centerY,
          prevCenterZ: previousPose?.centerZ ?? centerZ,
          prevAxisEndX: previousPose?.axisEndX ?? axisEndX,
          prevAxisEndY: previousPose?.axisEndY ?? axisEndY,
          prevAxisEndZ: previousPose?.axisEndZ ?? axisEndZ,
          centerX,
          centerY,
          centerZ,
          axisEndX,
          axisEndY,
          axisEndZ,
          radius,
          reflectionMode: fieldShot.material.reflection.mode,
          playerId,
          entityId: unit.id,
        });
      }
    }
  }

  const oldPrevious = _previousShieldPoses;
  _previousShieldPoses = _nextShieldPoses;
  _nextShieldPoses = oldPrevious;
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

export function encodeShieldBarrierShape(shape: ShieldBarrierShape): number {
  switch (shape) {
    case 'sphere':
      return 0;
    case 'infiniteVerticalCylinder':
      return 1;
    case 'aimedCylinder':
      return 2;
  }
  return 0;
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

function intersectShieldInfiniteVerticalCylinder(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  centerX: number,
  centerY: number,
  radius: number,
  reflectionMode: ShieldReflectionMode,
): number | null {
  const sx = startX - centerX;
  const sy = startY - centerY;

  if (
    Math.max(startX, endX) < centerX - radius ||
    Math.min(startX, endX) > centerX + radius ||
    Math.max(startY, endY) < centerY - radius ||
    Math.min(startY, endY) > centerY + radius
  ) {
    return null;
  }

  const dx = endX - startX;
  const dy = endY - startY;
  const a = dx * dx + dy * dy;
  if (a <= 1e-9) return null;

  const radiusSq = radius * radius;
  const startDistSq = sx * sx + sy * sy;
  const startDotVelocity = sx * dx + sy * dy;
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
    const radialVelocity = dx * hitX + dy * hitY;
    if (shieldModeAllowsCrossing(reflectionMode, radialVelocity)) return firstT;
  }

  if (secondT > 1e-6 && secondT <= 1 && secondT !== firstT) {
    const t = secondT;
    const hitX = startX + dx * t - centerX;
    const hitY = startY + dy * t - centerY;
    const radialVelocity = dx * hitX + dy * hitY;
    if (shieldModeAllowsCrossing(reflectionMode, radialVelocity)) return t;
  }
  return null;
}

function intersectShieldAimedCylinder(
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  axisStartX: number,
  axisStartY: number,
  axisStartZ: number,
  axisEndX: number,
  axisEndY: number,
  axisEndZ: number,
  radius: number,
  reflectionMode: ShieldReflectionMode,
): number | null {
  const axisX = axisEndX - axisStartX;
  const axisY = axisEndY - axisStartY;
  const axisZ = axisEndZ - axisStartZ;
  const axisLen = Math.hypot(axisX, axisY, axisZ);
  if (axisLen <= 1e-6 || radius <= 0) return null;

  const ux = axisX / axisLen;
  const uy = axisY / axisLen;
  const uz = axisZ / axisLen;
  const dx = endX - startX;
  const dy = endY - startY;
  const dz = endZ - startZ;
  const wx = startX - axisStartX;
  const wy = startY - axisStartY;
  const wz = startZ - axisStartZ;
  const dDotAxis = dx * ux + dy * uy + dz * uz;
  const wDotAxis = wx * ux + wy * uy + wz * uz;
  const mx = dx - ux * dDotAxis;
  const my = dy - uy * dDotAxis;
  const mz = dz - uz * dDotAxis;
  const nx = wx - ux * wDotAxis;
  const ny = wy - uy * wDotAxis;
  const nz = wz - uz * wDotAxis;
  const a = mx * mx + my * my + mz * mz;
  if (a <= 1e-9) return null;

  const radiusSq = radius * radius;
  const b = 2 * (nx * mx + ny * my + nz * mz);
  const c = nx * nx + ny * ny + nz * nz - radiusSq;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const invDenom = 1 / (2 * a);
  const t0 = (-b - sqrtDisc) * invDenom;
  const t1 = (-b + sqrtDisc) * invDenom;
  const firstT = Math.min(t0, t1);
  const secondT = Math.max(t0, t1);

  const accepts = (t: number): boolean => {
    if (t <= 1e-6 || t > 1) return false;
    const hitPerpX = nx + mx * t;
    const hitPerpY = ny + my * t;
    const hitPerpZ = nz + mz * t;
    const radialVelocity = mx * hitPerpX + my * hitPerpY + mz * hitPerpZ;
    return shieldModeAllowsCrossing(reflectionMode, radialVelocity);
  };

  if (accepts(firstT)) return firstT;
  if (secondT !== firstT && accepts(secondT)) return secondT;
  return null;
}

type ShieldFieldHit = {
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
};

function shieldFieldSignedDistanceAndNormal(
  x: number,
  y: number,
  z: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  axisEndX: number,
  axisEndY: number,
  axisEndZ: number,
  radius: number,
  shape: ShieldBarrierShape,
): { distance: number; nx: number; ny: number; nz: number } | null {
  if (radius <= 0) return null;
  if (shape === 'infiniteVerticalCylinder') {
    const dx = x - centerX;
    const dy = y - centerY;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-9) return { distance: -radius, nx: 1, ny: 0, nz: 0 };
    return { distance: len - radius, nx: dx / len, ny: dy / len, nz: 0 };
  }
  if (shape === 'aimedCylinder') {
    const axisX = axisEndX - centerX;
    const axisY = axisEndY - centerY;
    const axisZ = axisEndZ - centerZ;
    const axisLen = Math.hypot(axisX, axisY, axisZ);
    if (axisLen <= 1e-6) return null;
    const ux = axisX / axisLen;
    const uy = axisY / axisLen;
    const uz = axisZ / axisLen;
    const relX = x - centerX;
    const relY = y - centerY;
    const relZ = z - centerZ;
    const axial = relX * ux + relY * uy + relZ * uz;
    const perpX = relX - ux * axial;
    const perpY = relY - uy * axial;
    const perpZ = relZ - uz * axial;
    const len = Math.hypot(perpX, perpY, perpZ);
    if (len <= 1e-9) {
      const fallbackX = -uy;
      const fallbackY = ux;
      const fallbackLen = Math.hypot(fallbackX, fallbackY);
      if (fallbackLen > 1e-9) {
        return { distance: -radius, nx: fallbackX / fallbackLen, ny: fallbackY / fallbackLen, nz: 0 };
      }
      return { distance: -radius, nx: 1, ny: 0, nz: 0 };
    }
    return { distance: len - radius, nx: perpX / len, ny: perpY / len, nz: perpZ / len };
  }

  const dx = x - centerX;
  const dy = y - centerY;
  const dz = z - centerZ;
  const len = Math.hypot(dx, dy, dz);
  if (len <= 1e-9) return { distance: -radius, nx: 1, ny: 0, nz: 0 };
  return { distance: len - radius, nx: dx / len, ny: dy / len, nz: dz / len };
}

function movingShieldFieldHit(
  active: ActiveShieldRef,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
): ShieldFieldHit | null {
  const previous = shieldFieldSignedDistanceAndNormal(
    startX, startY, startZ,
    active.prevCenterX, active.prevCenterY, active.prevCenterZ,
    active.prevAxisEndX, active.prevAxisEndY, active.prevAxisEndZ,
    active.radius,
    active.shape,
  );
  if (previous === null) return null;
  const current = shieldFieldSignedDistanceAndNormal(
    endX, endY, endZ,
    active.centerX, active.centerY, active.centerZ,
    active.axisEndX, active.axisEndY, active.axisEndZ,
    active.radius,
    active.shape,
  );
  if (current === null) return null;
  const crossedOut = previous.distance <= 1e-6 && current.distance > 1e-6;
  const crossedIn = previous.distance > 1e-6 && current.distance <= 1e-6;
  if (!crossedOut && !crossedIn) return null;
  if (!shieldModeAllowsCrossing(active.reflectionMode, current.distance - previous.distance)) {
    return null;
  }
  return {
    t: 1,
    x: endX - current.nx * current.distance,
    y: endY - current.ny * current.distance,
    z: endZ - current.nz * current.distance,
    nx: current.nx,
    ny: current.ny,
    nz: current.nz,
  };
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
    const t = active.shape === 'infiniteVerticalCylinder'
      ? intersectShieldInfiniteVerticalCylinder(
        startX, startY,
        endX, endY,
        active.centerX, active.centerY,
        active.radius,
        active.reflectionMode,
      )
      : active.shape === 'aimedCylinder'
        ? intersectShieldAimedCylinder(
          startX, startY, startZ,
          endX, endY, endZ,
          active.centerX, active.centerY, active.centerZ,
          active.axisEndX, active.axisEndY, active.axisEndZ,
          active.radius,
          active.reflectionMode,
        )
      : intersectShieldSphere(
        startX, startY, startZ,
        endX, endY, endZ,
        active.centerX, active.centerY, active.centerZ,
        active.radius,
        active.reflectionMode,
      );
    let hit: ShieldFieldHit | null = null;
    if (t !== null) {
      const hitX = startX + (endX - startX) * t;
      const hitY = startY + (endY - startY) * t;
      const hitZ = startZ + (endZ - startZ) * t;
      let nx = hitX - active.centerX;
      let ny = hitY - active.centerY;
      let nz = active.shape === 'infiniteVerticalCylinder' ? 0 : hitZ - active.centerZ;
      if (active.shape === 'aimedCylinder') {
        const axisX = active.axisEndX - active.centerX;
        const axisY = active.axisEndY - active.centerY;
        const axisZ = active.axisEndZ - active.centerZ;
        const axisLen = Math.hypot(axisX, axisY, axisZ) || 1;
        const ux = axisX / axisLen;
        const uy = axisY / axisLen;
        const uz = axisZ / axisLen;
        const relX = hitX - active.centerX;
        const relY = hitY - active.centerY;
        const relZ = hitZ - active.centerZ;
        const axial = relX * ux + relY * uy + relZ * uz;
        nx = relX - ux * axial;
        ny = relY - uy * axial;
        nz = relZ - uz * axial;
      }
      const nLen = Math.hypot(nx, ny, nz) || 1;
      hit = { t, x: hitX, y: hitY, z: hitZ, nx: nx / nLen, ny: ny / nLen, nz: nz / nLen };
    } else {
      hit = movingShieldFieldHit(active, startX, startY, startZ, endX, endY, endZ);
    }
    if (hit === null || hit.t >= bestT) continue;

    bestT = hit.t;
    bestX = hit.x;
    bestY = hit.y;
    bestZ = hit.z;
    bestNx = hit.nx;
    bestNy = hit.ny;
    bestNz = hit.nz;
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
