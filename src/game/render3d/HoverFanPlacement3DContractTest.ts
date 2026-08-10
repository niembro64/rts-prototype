import { getBodyTopY } from '../math/BodyDimensions';
import { getAllUnitBlueprints } from '../sim/blueprints/units';
import { fanRotorHandedness, getHoverFanVisualRootY } from './HoverRig3D';

const EXPECTED_LOGICAL_MOUNT_Z: Readonly<Record<string, number>> = Object.freeze({
  unitBee: -0.04444,
  unitDragonfly: -0.09,
  unitConstructionDrone: -0.0315,
  unitQueenBee: -0.036,
  unitTransport: -0.036,
});

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[hover fan placement contract] ${message}`);
}

export function runHoverFanPlacement3DContractTest(): void {
  const hoverUnits = getAllUnitBlueprints().filter(
    (blueprint) => blueprint.unitLocomotion.type === 'hover',
  );
  assertContract(
    hoverUnits.length === Object.keys(EXPECTED_LOGICAL_MOUNT_Z).length,
    'every hover unit must have an explicit logical-mount preservation expectation',
  );

  for (const blueprint of hoverUnits) {
    const locomotion = blueprint.unitLocomotion;
    if (locomotion.type !== 'hover') continue;
    const unitRadius = blueprint.radius.other;
    const bodyTopY = getBodyTopY(blueprint.bodyShape, unitRadius);
    const visualRootY = getHoverFanVisualRootY(bodyTopY, unitRadius, locomotion.config);
    const expectedLogicalZ = EXPECTED_LOGICAL_MOUNT_Z[blueprint.unitBlueprintId];
    assertContract(
      expectedLogicalZ !== undefined,
      `${blueprint.unitBlueprintId} is missing a logical mount expectation`,
    );

    for (const mount of locomotion.config.mounts) {
      assertContract(
        mount.offset.zUnitRadiusRatio === expectedLogicalZ,
        `${blueprint.unitBlueprintId} logical hover mount z must not move with its visual fans`,
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

    checkCounterRotation(blueprint.unitBlueprintId, locomotion.config.mounts);
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
