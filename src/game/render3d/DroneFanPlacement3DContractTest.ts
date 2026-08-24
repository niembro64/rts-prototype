import * as THREE from 'three';
import { getBodyTopY } from '../math/BodyDimensions';
import { getAllUnitBlueprints } from '../sim/blueprints/units';
import {
  fanRotorHandedness,
  getDroneFanVisualRootY,
  resolveDroneFanMounts,
  updateDroneFans,
  type DroneMesh,
} from './DroneRig3D';
import type { DroneFanMount } from '@/types/blueprints';
import type { LocomotionRenderPose } from './LocomotionRigShared3D';

type ExpectedDroneArray = {
  /** Authored mount height, which the render-only overhead lift must not move. */
  logicalZ: number;
  /** Ducts the unit ends up wearing once the authored half is mirrored. */
  fans: number;
};

const EXPECTED_DRONE_ARRAYS: Readonly<Record<string, ExpectedDroneArray>> = Object.freeze({
  unitBee: { logicalZ: -0.04444, fans: 2 },
  unitRadarScout: { logicalZ: -0.04444, fans: 2 },
  unitDragonfly: { logicalZ: -0.09, fans: 2 },
  unitConstructionDrone: { logicalZ: -0.0315, fans: 3 },
  unitAdvancedConstructionDrone: { logicalZ: -0.0315, fans: 3 },
  unitQueenBee: { logicalZ: -0.036, fans: 6 },
  unitTransport: { logicalZ: -0.036, fans: 4 },
  unitDetector: { logicalZ: -0.04444, fans: 2 },
});

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[drone fan placement contract] ${message}`);
}

export function runDroneFanPlacement3DContractTest(): void {
  checkSubmergedFanHostLock();

  const droneUnits = getAllUnitBlueprints().filter(
    (blueprint) => blueprint.unitLocomotion.type === 'drone',
  );
  assertContract(
    droneUnits.length === Object.keys(EXPECTED_DRONE_ARRAYS).length,
    'every drone unit must have an explicit fan-array expectation',
  );

  for (const blueprint of droneUnits) {
    const locomotion = blueprint.unitLocomotion;
    if (locomotion.type !== 'drone') continue;
    const unitRadius = blueprint.radius.other;
    const bodyTopY = getBodyTopY(blueprint.bodyShape, unitRadius);
    const visualRootY = getDroneFanVisualRootY(bodyTopY, unitRadius, locomotion.config);
    const expected = EXPECTED_DRONE_ARRAYS[blueprint.unitBlueprintId];
    assertContract(
      expected !== undefined,
      `${blueprint.unitBlueprintId} is missing a fan-array expectation`,
    );

    checkHalfAuthoring(blueprint.unitBlueprintId, locomotion.config.mounts, expected.fans);
    const mounts = resolveDroneFanMounts(locomotion.config);

    for (const mount of mounts) {
      assertContract(
        mount.offset.zUnitRadiusRatio === expected.logicalZ,
        `${blueprint.unitBlueprintId} logical drone mount z must not move with its visual fans`,
      );

      const fanRadius = Math.max(1, unitRadius * mount.radiusFrac);
      const tubeRadius = Math.max(0.35, unitRadius * mount.ringTubeRadiusFrac);
      const tiltRad = Math.max(0, Math.min(35, mount.outwardAngleDeg)) * Math.PI / 180;
      const fanCenterY = visualRootY + unitRadius * mount.offset.zUnitRadiusRatio;
      const lowestRingY = fanCenterY - fanRadius * Math.sin(tiltRad) - tubeRadius;
      assertContract(
        lowestRingY > bodyTopY,
        `${blueprint.unitBlueprintId} visual fan ring must clear the top of its chassis`,
      );
    }

    checkCounterRotation(blueprint.unitBlueprintId, mounts);
  }
}

/** A locomotion assembly has one root authority. In particular, water or
 * terrain may not push a drone's fans away from a submerged chassis. */
function checkSubmergedFanHostLock(): void {
  const group = new THREE.Group();
  group.position.y = 500;
  const mesh = {
    type: 'drone',
    group,
    fans: [],
    visualBaseY: 17,
    clearance: 0,
    fanSpinRadPerSec: 1,
    geometryKey: 'contract',
  } satisfies DroneMesh;
  const submergedPose = {
    baseX: 30,
    baseY: -80,
    baseZ: 40,
    rootX: 30,
    rootY: -110,
    rootZ: 40,
    quaternionX: 0,
    quaternionY: 0,
    quaternionZ: 0,
    quaternionW: 1,
    velocityX: 0,
    velocityY: -10,
    velocityZ: 0,
    yawRate: 0,
    waterFraction: 1,
    maxContinuousDistance: 0,
  carried: false,
  } satisfies LocomotionRenderPose;

  updateDroneFans(mesh, submergedPose, 0);
  assertContract(
    mesh.group.position.y === mesh.visualBaseY,
    'submerged drone fans retain their authored chassis-local offset',
  );
  assertContract(
    mesh.clearance === submergedPose.rootY - submergedPose.baseY,
    'submerged clearance remains diagnostic and cannot displace fan hardware',
  );
}

/** Everything about a duct except which flank it sits on. Two mounts agreeing
 *  on this and disagreeing only in the sign of their lateral offset are a
 *  mirrored pair. */
function mirrorInvariantKey(mount: DroneFanMount): string {
  return [
    mount.offset.xUnitRadiusRatio,
    Math.abs(mount.offset.yUnitRadiusRatio),
    mount.offset.zUnitRadiusRatio,
    mount.radiusFrac,
    mount.ringTubeRadiusFrac,
    mount.outwardAngleDeg,
  ].join(',');
}

/**
 * HALF THE ARRAY IS AUTHORED; THE OTHER HALF IS GROWN.
 *
 * A hand-written mirror is a pair of numbers that has to be kept in step by
 * whoever edits either one — the failure mode is a duct nudged outboard on one
 * flank only, which reads as a bent airframe. So the blueprint may only author
 * the unit's left side (+y) and the centreline, and resolveDroneFanMounts owes
 * it exactly one starboard twin per off-centre mount and nothing for a
 * centreline duct.
 */
function checkHalfAuthoring(
  unitBlueprintId: string,
  authored: readonly DroneFanMount[],
  expectedFans: number,
): void {
  for (let i = 0; i < authored.length; i++) {
    assertContract(
      authored[i].offset.yUnitRadiusRatio >= 0,
      `${unitBlueprintId} drone mount ${i} is authored to starboard — author the `
        + 'left side (+y) or the centreline only, and let the mirror be generated',
    );
  }

  const resolved = resolveDroneFanMounts({ mounts: [...authored], fanSpinRadPerSec: 0 });
  assertContract(
    resolved.length === expectedFans,
    `${unitBlueprintId} resolves ${resolved.length} ducts, expected ${expectedFans}`,
  );

  const seen = new Set<string>();
  for (const mount of resolved) {
    const key = [
      mount.offset.xUnitRadiusRatio,
      mount.offset.yUnitRadiusRatio,
      mount.offset.zUnitRadiusRatio,
    ].join(',');
    assertContract(
      !seen.has(key),
      `${unitBlueprintId} resolves two ducts at (${key}) — a centreline fan must `
        + 'not be mirrored onto itself',
    );
    seen.add(key);
  }

  for (const mount of authored) {
    const lateral = mount.offset.yUnitRadiusRatio;
    const family = resolved.filter(
      (candidate) => mirrorInvariantKey(candidate) === mirrorInvariantKey(mount),
    );
    const expectedFamily = lateral === 0 ? 1 : 2;
    assertContract(
      family.length === expectedFamily,
      `${unitBlueprintId} duct at y=${lateral} must resolve to ${expectedFamily} `
        + `duct(s), not ${family.length}`,
    );
    assertContract(
      family.reduce((sum, duct) => sum + duct.offset.yUnitRadiusRatio, 0) === 0,
      `${unitBlueprintId} duct at y=${lateral} and its twin must straddle the `
        + 'centreline — mirroring negates the lateral axis and nothing else',
    );
  }
}

/** Counter-rotating ducts. The handedness sign multiplies blade pitch and
 *  spin rate together, so the two properties worth pinning are that mirrored
 *  ducts come out opposite-handed, and that the direction each one blows —
 *  the sign of pitch x spin — survives the mirroring. Base magnitudes are
 *  arbitrary positives: this is a sign contract, not a tuning one. */
function checkCounterRotation(
  unitBlueprintId: string,
  mounts: readonly { offset: { yUnitRadiusRatio: number } }[],
): void {
  const BASE_PITCH = 1;
  const BASE_SPIN = -1;
  assertContract(
    fanRotorHandedness(0) === 1,
    'a duct on the centreline must keep the authored rotor handedness',
  );

  for (const mount of mounts) {
    const lateral = mount.offset.yUnitRadiusRatio;
    const handedness = fanRotorHandedness(lateral);
    const mirrored = fanRotorHandedness(-lateral);
    assertContract(
      lateral === 0 || handedness === -mirrored,
      `${unitBlueprintId} ducts at +/-${lateral} must counter-rotate`,
    );
    assertContract(
      Math.sign(BASE_PITCH * handedness * BASE_SPIN * handedness)
        === Math.sign(BASE_PITCH * mirrored * BASE_SPIN * mirrored),
      `${unitBlueprintId} mirrored ducts must still blow the same way — `
        + 'pitch and spin have to flip together',
    );
  }
}
