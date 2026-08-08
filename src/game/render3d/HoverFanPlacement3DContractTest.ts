import { getBodyTopY } from '../math/BodyDimensions';
import { getAllUnitBlueprints } from '../sim/blueprints/units';
import { getHoverFanVisualRootY } from './HoverRig3D';

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
  }
}
