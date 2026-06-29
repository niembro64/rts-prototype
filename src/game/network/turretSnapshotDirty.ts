import {
  turretBlueprintIdToCode,
  turretStateToCode,
} from '../../types/network';
import type { Entity, Turret } from '../sim/types';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from '../sim/combat/targetingInputStamping';
import { quantizeRotation as qRot } from './snapshotQuantization';
import {
  turretAimMotionIsSnapshotVisible,
  turretShouldEncodeInactive,
} from './turretSnapshotFields';

const TURRET_SNAPSHOT_SIGNATURE_STRIDE = 10;
const _turretSnapshotDirtyFsm: CombatTargetingTurretFsmOut = {
  stateCode: 0,
  targetId: -1,
};

let turretSnapshotSignatureByEntity = new WeakMap<Entity, Float64Array>();

export function resetTurretSnapshotDirtyCache(): void {
  turretSnapshotSignatureByEntity = new WeakMap<Entity, Float64Array>();
}

function writeTurretSnapshotSignature(
  entity: Entity,
  weaponIndex: number,
  turret: Turret,
  out: Float64Array,
  base: number,
): void {
  if (!turretAimMotionIsSnapshotVisible(turret)) {
    out[base + 0] = 0;
    out[base + 1] = 0;
    out[base + 2] = 0;
    out[base + 3] = 0;
  } else {
    out[base + 0] = qRot(turret.rotation);
    out[base + 1] = qRot(turret.angularVelocity);
    out[base + 2] = qRot(turret.pitch);
    out[base + 3] = qRot(turret.pitchVelocity);
  }

  const hasTargetingFsm = readCombatTargetingTurretFsmInto(
    entity,
    weaponIndex,
    _turretSnapshotDirtyFsm,
  );
  const targetId = hasTargetingFsm
    ? _turretSnapshotDirtyFsm.targetId
    : (turret.target !== null ? turret.target : -1);
  const shield = turret.shield;

  out[base + 4] = turretBlueprintIdToCode(turret.config.turretBlueprintId);
  out[base + 5] = hasTargetingFsm
    ? _turretSnapshotDirtyFsm.stateCode
    : turretStateToCode(turret.state);
  out[base + 6] = targetId;
  out[base + 7] = shield !== null ? 1 : 0;
  out[base + 8] = shield !== null ? shield.range : 0;
  out[base + 9] = turretShouldEncodeInactive(turret, targetId) ? 1 : 0;
}

export function turretSnapshotRowsChangedSinceLastSample(entity: Entity): boolean {
  const combat = entity.combat;
  if (combat === null) return false;
  const turrets = combat.turrets;
  const requiredLength = turrets.length * TURRET_SNAPSHOT_SIGNATURE_STRIDE;
  if (requiredLength === 0) return false;

  let previous = turretSnapshotSignatureByEntity.get(entity);
  let changed = previous === undefined || previous.length !== requiredLength;
  if (previous === undefined || previous.length !== requiredLength) {
    previous = new Float64Array(requiredLength);
    turretSnapshotSignatureByEntity.set(entity, previous);
  }

  const scratch = currentTurretSnapshotSignature(requiredLength);
  for (let i = 0; i < turrets.length; i++) {
    const base = i * TURRET_SNAPSHOT_SIGNATURE_STRIDE;
    writeTurretSnapshotSignature(entity, i, turrets[i], scratch, base);
    for (let field = 0; field < TURRET_SNAPSHOT_SIGNATURE_STRIDE; field++) {
      const index = base + field;
      const value = scratch[index];
      if (previous[index] !== value) {
        previous[index] = value;
        changed = true;
      }
    }
  }

  return changed;
}

let _currentSignature = new Float64Array(0);

function currentTurretSnapshotSignature(requiredLength: number): Float64Array {
  if (_currentSignature.length < requiredLength) {
    _currentSignature = new Float64Array(requiredLength);
  }
  return _currentSignature;
}
