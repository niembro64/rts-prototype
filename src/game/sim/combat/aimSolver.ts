import type { Vec3 } from '@/types/vec2';
import type { Entity, ProjectileShot, Turret, TurretConfig } from '../types';
import { isProjectileShot } from '../types';
import { ballisticSolutions, clamp, computeInterceptTime, getBarrelTip, getTransformCosSin, solveBallisticPitch } from '../../math';
import type { BarrelEndpoint } from '../../math/BarrelGeometry';
import { GRAVITY } from '../../../config';
import { computeTurretPointVelocity, getEntityVelocity3, getProjectileLaunchSpeed, resolveWeaponWorldMount } from './combatUtils';
import { pickMirrorLineTurret } from './mirrorTargetPriority';
import { getUnitGroundZ } from '../unitGeometry';

type GroundHeightLookup = (x: number, y: number) => number;

const _mirrorEnemyTurretMount = { x: 0, y: 0, z: 0 };

export type DirectTurretAim = {
  aim: Vec3;
  tip: BarrelEndpoint;
  yaw: number;
  pitch: number;
};

export type ProjectileTurretAim = DirectTurretAim & {
  targetVelocity: Vec3;
  muzzleVelocity: Vec3;
  hasBallisticSolution: boolean;
};

export type TurretAimSolution = ProjectileTurretAim;

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
    hasBallisticSolution: true,
  };
}

export function createTurretAimScratch(): TurretAimSolution {
  return createProjectileTurretAimScratch();
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

/**
 * Three-iteration refinement of `out.aim` toward a target through the
 * actual barrel tip. A long barrel can move the firing origin enough
 * to change which point on a building AABB is closest, so the loop
 * resolves the aim point once from the mount, recomputes the tip,
 * resolves again, and re-resolves once more to settle. Returns the
 * settled barrel tip and yaw; `out.aim` is mutated in place.
 *
 * Shared by solveDirectTurretAim and solveProjectileTurretAim — they
 * differ only in what they do AFTER this refinement (lead-time
 * solving, ballistic pitch, ground-aim folding) and used to inline
 * the chain identically.
 */
function iterateMuzzleAim(
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  config: TurretConfig,
  out: Vec3,
): { tip: BarrelEndpoint; yaw: number } {
  resolveTargetAimPoint(target, mountX, mountY, mountZ, out);
  let yaw = Math.atan2(out.y - mountY, out.x - mountX);
  let tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, config, 0);
  resolveTargetAimPoint(target, tip.x, tip.y, tip.z, out);
  yaw = Math.atan2(out.y - tip.y, out.x - tip.x);
  tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, config, 0);
  resolveTargetAimPoint(target, tip.x, tip.y, tip.z, out);
  return { tip, yaw };
}

function writeFallbackDirectionAimPoint(
  mountX: number,
  mountY: number,
  mountZ: number,
  fallbackYaw: number,
  fallbackPitch: number,
  out: Vec3,
): Vec3 {
  const cosYaw = Math.cos(fallbackYaw);
  const sinYaw = Math.sin(fallbackYaw);
  const cosPitch = Math.cos(fallbackPitch);
  out.x = mountX + cosYaw * cosPitch;
  out.y = mountY + sinYaw * cosPitch;
  out.z = mountZ + Math.sin(fallbackPitch);
  return out;
}

/**
 * Mirror turrets share the normal turret aiming pipeline: resolve a
 * world-space point, then yaw/pitch toward it. The only mirror-specific
 * part is this point provider: it returns the direction bisecting
 * own-mirror-center→enemy-line-turret-center and
 * own-mirror-center→enemy-body-center.
 */
export function resolveMirrorTurretAimPoint(
  unit: Entity,
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  fallbackYaw: number,
  fallbackPitch: number,
  currentTick: number | undefined,
  out: Vec3,
): Vec3 | null {
  if (!target.combat || !unit.unit) return null;

  const picked = pickMirrorLineTurret(target, unit.id);
  if (picked === null) return null;

  const tCS = getTransformCosSin(target.transform);
  const enemyMount = resolveWeaponWorldMount(
    target, picked.turret, picked.index,
    tCS.cos, tCS.sin,
    {
      currentTick,
      unitGroundZ: getUnitGroundZ(target),
      surfaceN: target.unit?.surfaceNormal,
    },
    _mirrorEnemyTurretMount,
  );

  const turretVecX = enemyMount.x - mountX;
  const turretVecY = enemyMount.y - mountY;
  const turretVecZ = enemyMount.z - mountZ;
  const turretLen = Math.hypot(turretVecX, turretVecY, turretVecZ);
  const bodyVecX = target.transform.x - mountX;
  const bodyVecY = target.transform.y - mountY;
  const bodyVecZ = target.transform.z - mountZ;
  const bodyLen = Math.hypot(bodyVecX, bodyVecY, bodyVecZ);
  if (turretLen <= 1e-6 || bodyLen <= 1e-6) {
    return writeFallbackDirectionAimPoint(
      mountX, mountY, mountZ, fallbackYaw, fallbackPitch, out,
    );
  }

  const nx = turretVecX / turretLen + bodyVecX / bodyLen;
  const ny = turretVecY / turretLen + bodyVecY / bodyLen;
  const nz = turretVecZ / turretLen + bodyVecZ / bodyLen;
  const nLen = Math.hypot(nx, ny, nz);
  if (nLen <= 1e-6) {
    return writeFallbackDirectionAimPoint(
      mountX, mountY, mountZ, fallbackYaw, fallbackPitch, out,
    );
  }

  out.x = mountX + nx / nLen;
  out.y = mountY + ny / nLen;
  out.z = mountZ + nz / nLen;
  return out;
}

export function solveTurretAimAtPoint(
  aimPoint: Vec3,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  config: TurretConfig,
  out: TurretAimSolution,
): TurretAimSolution {
  out.aim.x = aimPoint.x;
  out.aim.y = aimPoint.y;
  out.aim.z = aimPoint.z;

  let yaw = Math.atan2(aimPoint.y - mountY, aimPoint.x - mountX);
  let tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, config, 0);
  yaw = Math.atan2(aimPoint.y - tip.y, aimPoint.x - tip.x);
  tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, config, 0);

  const horizDist = Math.hypot(aimPoint.x - tip.x, aimPoint.y - tip.y);
  const heightDiff = aimPoint.z - tip.z;
  out.yaw = yaw;
  out.pitch = Math.atan2(heightDiff, horizDist);
  out.tip = tip;
  out.hasBallisticSolution = true;
  out.targetVelocity.x = 0;
  out.targetVelocity.y = 0;
  out.targetVelocity.z = 0;
  out.muzzleVelocity.x = 0;
  out.muzzleVelocity.y = 0;
  out.muzzleVelocity.z = 0;
  return out;
}

export function solveDirectTurretAim(
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  config: TurretConfig,
  out: DirectTurretAim,
): DirectTurretAim {
  const { tip } = iterateMuzzleAim(
    target, mountX, mountY, mountZ, currentPitch, config, out.aim,
  );

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
  inheritMuzzleVelocity: boolean,
  groundHeightAt: GroundHeightLookup,
  out: ProjectileTurretAim,
): ProjectileTurretAim {
  const shot = weapon.config.shot as ProjectileShot;
  const launchSpeed = getProjectileLaunchSpeed(shot);

  const refined = iterateMuzzleAim(
    target, mountX, mountY, mountZ, currentPitch, weapon.config, out.aim,
  );
  let yaw = refined.yaw;
  let tip = refined.tip;

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
      const tRefined = computeInterceptTime(dxT, dyT, 0, relVx, relVy, 0, horizSpeed);
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
  tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, weapon.config, 0);
  if (groundAimFraction !== undefined && groundAimFraction > 0) {
    const f = groundAimFraction;
    out.aim.x = tip.x + f * (leadAimX - tip.x);
    out.aim.y = tip.y + f * (leadAimY - tip.y);
    out.aim.z = groundHeightAt(out.aim.x, out.aim.y);
    yaw = Math.atan2(out.aim.y - tip.y, out.aim.x - tip.x);
    tip = getBarrelTip(mountX, mountY, mountZ, yaw, currentPitch, weapon.config, 0);
  }

  const horizDist = Math.hypot(out.aim.x - tip.x, out.aim.y - tip.y);
  const heightDiff = out.aim.z - tip.z;
  out.yaw = yaw;
  if (shot.ignoresGravity) {
    out.hasBallisticSolution = true;
    out.pitch = Math.atan2(heightDiff, horizDist);
  } else {
    const solutions = ballisticSolutions(horizDist, heightDiff, launchSpeed, GRAVITY);
    out.hasBallisticSolution = solutions !== null;
    out.pitch = solutions
      ? (weapon.config.highArc ? solutions.high : solutions.low)
      : solveBallisticPitch(
          horizDist, heightDiff, launchSpeed, GRAVITY, weapon.config.highArc ?? false,
        );
  }
  out.tip = tip;
  return out;
}

export function solveTurretAim(
  unit: Entity,
  weapon: Turret,
  target: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  currentPitch: number,
  currentTick: number | undefined,
  groundHeightAt: GroundHeightLookup,
  out: TurretAimSolution,
): TurretAimSolution | null {
  if (weapon.config.passive) {
    const aimPoint = resolveMirrorTurretAimPoint(
      unit, target,
      mountX, mountY, mountZ,
      weapon.rotation, weapon.pitch,
      currentTick,
      out.aim,
    );
    if (!aimPoint) return null;
    return solveTurretAimAtPoint(
      aimPoint,
      mountX, mountY, mountZ,
      currentPitch,
      weapon.config,
      out,
    );
  }

  const shot = weapon.config.shot;
  if (shot && isProjectileShot(shot)) {
    return solveProjectileTurretAim(
      weapon,
      target,
      mountX, mountY, mountZ,
      currentPitch,
      true,
      groundHeightAt,
      out,
    );
  }

  solveDirectTurretAim(
    target,
    mountX, mountY, mountZ,
    currentPitch,
    weapon.config,
    out,
  );
  out.hasBallisticSolution = true;
  out.targetVelocity.x = 0;
  out.targetVelocity.y = 0;
  out.targetVelocity.z = 0;
  out.muzzleVelocity.x = 0;
  out.muzzleVelocity.y = 0;
  out.muzzleVelocity.z = 0;
  return out;
}
