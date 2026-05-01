import type { Vec3 } from '@/types/vec2';
import type { Entity, ProjectileShot, Turret, TurretConfig } from '../types';
import { computeInterceptTime, getBarrelTip, solveBallisticPitch } from '../../math';
import type { BarrelEndpoint } from '../../math/BarrelGeometry';
import { GRAVITY } from '../../../config';
import { computeTurretPointVelocity, getEntityVelocity3 } from './combatUtils';

type GroundHeightLookup = (x: number, y: number) => number;

export type DirectTurretAim = {
  aim: Vec3;
  tip: BarrelEndpoint;
  yaw: number;
  pitch: number;
};

export type ProjectileTurretAim = DirectTurretAim & {
  targetVelocity: Vec3;
  muzzleVelocity: Vec3;
};

export function createDirectTurretAimScratch(): DirectTurretAim {
  return {
    aim: { x: 0, y: 0, z: 0 },
    tip: { x: 0, y: 0, z: 0, dirX: 1, dirY: 0, dirZ: 0 },
    yaw: 0,
    pitch: 0,
  };
}

export function createProjectileTurretAimScratch(): ProjectileTurretAim {
  return {
    ...createDirectTurretAimScratch(),
    targetVelocity: { x: 0, y: 0, z: 0 },
    muzzleVelocity: { x: 0, y: 0, z: 0 },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolve the point a turret should aim at on a target's gameplay
 * collider. Buildings are AABBs, so the correct point is the closest
 * point on that box from the muzzle/turret, not always the building
 * center. This is what keeps weapons from visually shooting over a
 * building sitting at a different terrain height.
 */
export function resolveTargetAimPoint(
  target: Entity,
  originX: number,
  originY: number,
  originZ: number,
  out: Vec3,
): Vec3 {
  if (target.building) {
    const halfW = target.building.width / 2;
    const halfH = target.building.height / 2;
    const halfD = target.building.depth / 2;
    const minX = target.transform.x - halfW;
    const maxX = target.transform.x + halfW;
    const minY = target.transform.y - halfH;
    const maxY = target.transform.y + halfH;
    const minZ = target.transform.z - halfD;
    const maxZ = target.transform.z + halfD;

    out.x = clamp(originX, minX, maxX);
    out.y = clamp(originY, minY, maxY);
    out.z = clamp(originZ, minZ, maxZ);

    // If the origin is inside the collider, the closest point is the
    // origin itself. Aim through the center instead of producing a
    // zero-length direction.
    if (out.x === originX && out.y === originY && out.z === originZ) {
      out.x = target.transform.x;
      out.y = target.transform.y;
      out.z = target.transform.z;
    }
    return out;
  }

  // Units and projectiles use their transform as the center of their
  // 3D gameplay collider. For spheres this is the stable aim point.
  out.x = target.transform.x;
  out.y = target.transform.y;
  out.z = target.transform.z;
  return out;
}

export function solveDirectTurretAim(
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  config: TurretConfig,
  unitScale: number,
  out: DirectTurretAim,
): DirectTurretAim {
  resolveTargetAimPoint(target, mountX, mountY, mountZ, out.aim);
  let yaw = Math.atan2(out.aim.y - mountY, out.aim.x - mountX);

  // Resolve from the actual barrel tip after yaw, because a long
  // barrel can move the origin enough to change which point on a
  // building AABB is closest.
  let tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, config, unitScale, 0);
  resolveTargetAimPoint(target, tip.x, tip.y, tip.z, out.aim);
  yaw = Math.atan2(out.aim.y - tip.y, out.aim.x - tip.x);
  tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, config, unitScale, 0);
  resolveTargetAimPoint(target, tip.x, tip.y, tip.z, out.aim);

  const horizDist = Math.hypot(out.aim.x - tip.x, out.aim.y - tip.y);
  const heightDiff = out.aim.z - tip.z;
  out.yaw = Math.atan2(out.aim.y - tip.y, out.aim.x - tip.x);
  out.pitch = Math.atan2(heightDiff, horizDist);
  out.tip = tip;
  return out;
}

export function solveProjectileTurretAim(
  weapon: Turret,
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  unitScale: number,
  inheritMuzzleVelocity: boolean,
  groundHeightAt: GroundHeightLookup,
  out: ProjectileTurretAim,
): ProjectileTurretAim {
  const shot = weapon.config.shot as ProjectileShot;
  const launchSpeed = shot.launchForce / shot.mass;

  resolveTargetAimPoint(target, mountX, mountY, mountZ, out.aim);
  let yaw = Math.atan2(out.aim.y - mountY, out.aim.x - mountX);
  let tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, weapon.config, unitScale, 0);
  resolveTargetAimPoint(target, tip.x, tip.y, tip.z, out.aim);
  yaw = Math.atan2(out.aim.y - tip.y, out.aim.x - tip.x);
  tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, weapon.config, unitScale, 0);
  resolveTargetAimPoint(target, tip.x, tip.y, tip.z, out.aim);

  const targetVelocity = getEntityVelocity3(target, out.targetVelocity);
  const muzzleVelocity = out.muzzleVelocity;
  if (inheritMuzzleVelocity) {
    computeTurretPointVelocity(
      weapon,
      mountX, mountY, mountZ,
      tip.x, tip.y, tip.z,
      muzzleVelocity,
    );
  } else {
    muzzleVelocity.x = 0;
    muzzleVelocity.y = 0;
    muzzleVelocity.z = 0;
  }

  const relVx = targetVelocity.x - muzzleVelocity.x;
  const relVy = targetVelocity.y - muzzleVelocity.y;
  const relVz = targetVelocity.z - muzzleVelocity.z;
  const relMoves = (relVx * relVx + relVy * relVy + relVz * relVz) > 1e-6;

  if (relMoves) {
    const dxT = out.aim.x - tip.x;
    const dyT = out.aim.y - tip.y;
    const dzT = out.aim.z - tip.z;
    let tIntercept = computeInterceptTime(dxT, dyT, dzT, relVx, relVy, relVz, launchSpeed);

    if (tIntercept > 0 && !shot.ignoresGravity) {
      const px = out.aim.x + relVx * tIntercept;
      const py = out.aim.y + relVy * tIntercept;
      const pz = out.aim.z + relVz * tIntercept;
      const horizD = Math.hypot(px - tip.x, py - tip.y);
      const heightD = pz - tip.z;
      const pitch0 = solveBallisticPitch(
        horizD, heightD, launchSpeed, GRAVITY, weapon.config.highArc ?? false,
      );
      const horizSpeed = launchSpeed * Math.max(Math.cos(pitch0), 0.1);
      const tRefined = computeInterceptTime(dxT, dyT, dzT, relVx, relVy, relVz, horizSpeed);
      if (tRefined > 0) tIntercept = tRefined;
    }

    out.aim.x += relVx * tIntercept;
    out.aim.y += relVy * tIntercept;
    out.aim.z += relVz * tIntercept;
    yaw = Math.atan2(out.aim.y - tip.y, out.aim.x - tip.x);
  }

  const groundAimFraction = weapon.config.groundAimFraction;
  const leadAimX = out.aim.x;
  const leadAimY = out.aim.y;
  if (groundAimFraction !== undefined && groundAimFraction > 0) {
    const f = groundAimFraction;
    out.aim.x = tip.x + f * (out.aim.x - tip.x);
    out.aim.y = tip.y + f * (out.aim.y - tip.y);
    out.aim.z = groundHeightAt(out.aim.x, out.aim.y);
  }

  yaw = Math.atan2(out.aim.y - tip.y, out.aim.x - tip.x);
  tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, weapon.config, unitScale, 0);
  if (groundAimFraction !== undefined && groundAimFraction > 0) {
    const f = groundAimFraction;
    out.aim.x = tip.x + f * (leadAimX - tip.x);
    out.aim.y = tip.y + f * (leadAimY - tip.y);
    out.aim.z = groundHeightAt(out.aim.x, out.aim.y);
    yaw = Math.atan2(out.aim.y - tip.y, out.aim.x - tip.x);
    tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, weapon.config, unitScale, 0);
  }

  const horizDist = Math.hypot(out.aim.x - tip.x, out.aim.y - tip.y);
  const heightDiff = out.aim.z - tip.z;
  out.yaw = yaw;
  out.pitch = solveBallisticPitch(
    horizDist, heightDiff, launchSpeed, GRAVITY, weapon.config.highArc ?? false,
  );
  out.tip = tip;
  return out;
}
