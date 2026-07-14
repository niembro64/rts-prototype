import type { Vec3 } from '@/types/vec2';
import type { Entity } from '../types';
import { clamp, getTransformCosSin } from '../../math';
import {
  getEntityPosition3d,
  resolveWeaponWorldMount,
} from './combatUtils';
import { pickTargetAimTurret } from './shieldTargetPriority';
import { readCombatTargetingTurretMountInto } from './targetingInputStamping';
import { getUnitGroundZ } from '../unitGeometry';
import { getBuildingCombatCenterZ } from '../buildingAnchors';

type ResolveTargetAimPointOptions = {
  aimAtTargetTurret: boolean | undefined;
  source: Entity | undefined;
  sourceTurretId: number | undefined;
  currentTick: number | undefined;
};

const _mirrorEnemyTurretMount = { x: 0, y: 0, z: 0 };
const _targetAimPosition: Vec3 = { x: 0, y: 0, z: 0 };

function resolveTargetTurretAimPoint(
  target: Entity,
  source: Entity | undefined,
  sourceTurretId: number | undefined,
  currentTick: number | undefined,
  out: Vec3,
): boolean {
  const sourceEntityId = source === undefined ? undefined : source.id;
  const surfaceN = target.unit === null ? undefined : target.unit.surfaceNormal;
  const picked = pickTargetAimTurret(target, sourceEntityId, sourceTurretId);
  if (!picked) return false;
  if (
    currentTick !== undefined &&
    readCombatTargetingTurretMountInto(target, picked.index, currentTick, out)
  ) {
    return true;
  }
  const tCS = getTransformCosSin(target.transform);
  const targetMount = resolveWeaponWorldMount(
    target, picked.turret, picked.index,
    tCS.cos, tCS.sin,
    {
      currentTick,
      unitGroundZ: getUnitGroundZ(target),
      surfaceN,
    },
    _mirrorEnemyTurretMount,
  );
  out.x = targetMount.x;
  out.y = targetMount.y;
  out.z = targetMount.z;
  return true;
}

/**
 * Resolve the point a projectile or non-scheduler helper should aim at on a
 * target. Turret yaw/pitch and ballistic solving are Rust-owned; this TS
 * helper only resolves body/turret aim points for homing projectile guidance
 * and diagnostic paths that do not have a firing turret slab row.
 */
export function resolveTargetAimPoint(
  target: Entity,
  originX: number,
  originY: number,
  originZ: number,
  out: Vec3,
  options: ResolveTargetAimPointOptions | undefined = undefined,
): Vec3 {
  const aimAtTargetTurret = options === undefined ? false : options.aimAtTargetTurret === true;
  const source = options === undefined ? undefined : options.source;
  const currentTick = options === undefined ? undefined : options.currentTick;
  const sourceTurretId = options === undefined ? undefined : options.sourceTurretId;
  if (
    aimAtTargetTurret &&
    resolveTargetTurretAimPoint(target, source, sourceTurretId, currentTick, out)
  ) {
    return out;
  }

  const targetPos = getEntityPosition3d(target, _targetAimPosition);
  if (target.building) {
    // A hovering building's box is in the air (the fabricator torus); aim at its
    // combat center, not the ground-level transform.z. No-op for grounded ones.
    const centerZ = getBuildingCombatCenterZ(target);
    const halfW = target.building.width / 2;
    const halfH = target.building.height / 2;
    const halfD = target.building.depth / 2;
    const minX = targetPos.x - halfW;
    const maxX = targetPos.x + halfW;
    const minY = targetPos.y - halfH;
    const maxY = targetPos.y + halfH;
    const minZ = centerZ - halfD;
    const maxZ = centerZ + halfD;

    out.x = clamp(originX, minX, maxX);
    out.y = clamp(originY, minY, maxY);
    out.z = clamp(originZ, minZ, maxZ);

    if (out.x === originX && out.y === originY && out.z === originZ) {
      out.x = targetPos.x;
      out.y = targetPos.y;
      out.z = centerZ;
    }
    return out;
  }

  return getEntityPosition3d(target, out);
}
