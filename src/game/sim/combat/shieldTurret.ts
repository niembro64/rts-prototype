// Shield weapon system - projectile shield boundaries

import type { WorldState } from '../WorldState';
import type { ShieldConfig } from '../types';
import type { ShieldBarrierShape, ShieldReflectionMode } from '../../../types/shotTypes';
import { getTransformCosSin } from '../../math';
import { CT_TURRET_STATE_ENGAGED } from '../../sim-wasm/init';
import {
  isShieldSubmunitionTurret,
  isWeaponAimedForFire,
  updateWeaponWorldKinematics,
} from './combatUtils';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from './targetingInputStamping';
import { getUnitGroundZ } from '../unitGeometry';

const _shieldMount = { x: 0, y: 0, z: 0 };
const _shieldFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_ENGAGED,
  targetId: -1,
};

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
      if (shot === null || shot.type !== 'shield') continue;
      const fieldShot = shot as ShieldConfig;

      const transitionTime = fieldShot.transitionTime;

      // Initialize
      if (weapon.shield === null) {
        weapon.shield = { transition: 0, range: 0 };
      }

      // Move progress toward target based on engaged state
      const hasTargetingFsm = readCombatTargetingTurretFsmInto(unit, weaponIndex, _shieldFsm);
      const engaged = hasTargetingFsm
        ? _shieldFsm.stateCode === CT_TURRET_STATE_ENGAGED
        : weapon.state === 'engaged';
      const targetId = hasTargetingFsm ? _shieldFsm.targetId : (weapon.target ?? -1);
      const hasAimedCylinderBarrier = fieldShot.barrier?.shape === 'aimedCylinder';
      const aimedCylinderReady = hasAimedCylinderBarrier
        ? isWeaponAimedForFire(weapon)
        : true;
      const aimedCylinderHasTarget = !hasAimedCylinderBarrier || targetId !== -1;
      const targetProgress = engaged && aimedCylinderReady && aimedCylinderHasTarget ? 1 : 0;
      if (isShieldSubmunitionTurret(weapon)) {
        weapon.shield.transition = targetProgress;
      } else {
        const progressDelta = transitionTime > 0 ? dtMs / transitionTime : Number.POSITIVE_INFINITY;
        if (weapon.shield.transition < targetProgress) {
          weapon.shield.transition = Math.min(weapon.shield.transition + progressDelta, 1);
        } else if (weapon.shield.transition > targetProgress) {
          weapon.shield.transition = Math.max(weapon.shield.transition - progressDelta, 0);
        }
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


