import * as THREE from 'three';
import { easeBuildingActiveStateAmount } from './BuildingActiveStateTransition3D';

type BuildingOperationalMotion = Readonly<{
  /** Local-axis rotation while the host is operational. */
  spinAxis?: THREE.Vector3;
  spinRadPerSec?: number;
  /** Small vertical travel that makes a powered core look suspended. */
  bobAmplitude?: number;
  bobHz?: number;
  /** Uniform breathing applied around the authored open scale. */
  pulseAmplitude?: number;
  pulseHz?: number;
  phaseOffset?: number;
}>;

export type BuildingOperationalPosePart = Readonly<{
  object: THREE.Object3D;
  openPosition: THREE.Vector3;
  closedPosition: THREE.Vector3;
  openQuaternion: THREE.Quaternion;
  closedQuaternion: THREE.Quaternion;
  openScale: THREE.Vector3;
  closedScale: THREE.Vector3;
  motion?: BuildingOperationalMotion;
}>;

export type BuildingOperationalRig = Readonly<{
  parts: readonly BuildingOperationalPosePart[];
  /** Optional compression of the renderer-owned primary chassis about its
   * ground-level origin. Detail pieces author their own matching closed pose. */
  chassisClosedScaleY: number;
  hasContinuousMotion: boolean;
  /** Keeps non-scene presentation data (for example particle endpoints)
   * aligned with scene parts that telescope during the same pose. */
  applyLinkedPose?: (easedOperationalAmount: number) => void;
}>;

type BuildingOperationalPosePartOptions = Readonly<{
  closedPosition?: THREE.Vector3;
  closedQuaternion?: THREE.Quaternion;
  closedScale?: THREE.Vector3;
  motion?: BuildingOperationalMotion;
}>;

export function createBuildingOperationalPosePart(
  object: THREE.Object3D,
  options: BuildingOperationalPosePartOptions = {},
): BuildingOperationalPosePart {
  return {
    object,
    openPosition: object.position.clone(),
    closedPosition: options.closedPosition?.clone() ?? object.position.clone(),
    openQuaternion: object.quaternion.clone(),
    closedQuaternion: options.closedQuaternion?.clone() ?? object.quaternion.clone(),
    openScale: object.scale.clone(),
    closedScale: options.closedScale?.clone() ?? object.scale.clone(),
    motion: options.motion,
  };
}

export function createBuildingOperationalRig(
  parts: readonly BuildingOperationalPosePart[],
  options: Readonly<{
    chassisClosedScaleY?: number;
    applyLinkedPose?: (easedOperationalAmount: number) => void;
  }> = {},
): BuildingOperationalRig {
  return {
    parts,
    chassisClosedScaleY: options.chassisClosedScaleY ?? 1,
    hasContinuousMotion: parts.some((part) => part.motion !== undefined),
    applyLinkedPose: options.applyLinkedPose,
  };
}

const _motionAxis = new THREE.Vector3();
const _motionQuaternion = new THREE.Quaternion();

/** Writes a canonical open/closed pose plus weighted active motion. The
 * operational amount is presentation-only: 0 is the compact fortified pose,
 * 1 is fully deployed. It never feeds simulation or damage decisions. */
export function applyBuildingOperationalPose(
  rig: BuildingOperationalRig | undefined,
  chassis: THREE.Object3D | undefined,
  operationalAmount: number,
  motionTimeSec: number,
): boolean {
  if (rig === undefined) return false;
  const eased = easeBuildingActiveStateAmount(operationalAmount);
  const safeTime = Number.isFinite(motionTimeSec) ? motionTimeSec : 0;

  if (chassis !== undefined) {
    chassis.scale.set(1, THREE.MathUtils.lerp(rig.chassisClosedScaleY, 1, eased), 1);
  }
  rig.applyLinkedPose?.(eased);

  for (const part of rig.parts) {
    const object = part.object;
    object.position.copy(part.closedPosition).lerp(part.openPosition, eased);
    object.quaternion.copy(part.closedQuaternion).slerp(part.openQuaternion, eased);
    object.scale.copy(part.closedScale).lerp(part.openScale, eased);

    const motion = part.motion;
    if (motion === undefined || eased <= 0) continue;
    const phaseOffset = motion.phaseOffset ?? 0;
    if (motion.spinAxis !== undefined && motion.spinRadPerSec !== undefined) {
      _motionAxis.copy(motion.spinAxis).normalize();
      _motionQuaternion.setFromAxisAngle(
        _motionAxis,
        (safeTime * motion.spinRadPerSec + phaseOffset) * eased,
      );
      object.quaternion.multiply(_motionQuaternion);
    }
    if (motion.bobAmplitude !== undefined && motion.bobHz !== undefined) {
      object.position.y += Math.sin(
        safeTime * motion.bobHz * Math.PI * 2 + phaseOffset,
      ) * motion.bobAmplitude * eased;
    }
    if (motion.pulseAmplitude !== undefined && motion.pulseHz !== undefined) {
      const pulse = 1 + Math.sin(
        safeTime * motion.pulseHz * Math.PI * 2 + phaseOffset,
      ) * motion.pulseAmplitude * eased;
      object.scale.multiplyScalar(pulse);
    }
  }
  return true;
}
