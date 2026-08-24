import { unitTurretsAllowVisualBank3D } from '../../render3d/turretRenderHelpers3D';
import { getBodyTopFrac } from '../../math/BodyDimensions';
import { getUnitBlueprint } from './index';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[queen armament contract] ${message}`);
}

function assertQueenArmament(
  unitBlueprintId: 'unitQueenBee' | 'unitQueenTick',
  sensorTurretBlueprintId: 'turretSensorUnitQueenBee' | 'turretSensorUnitQueenTick',
  replacedHeadX: number,
  verticalSurface: 'low' | 'high',
): void {
  const queen = getUnitBlueprint(unitBlueprintId);
  const turrets = queen.turrets;
  const bodyTopFrac = getBodyTopFrac(queen.bodyShape);
  const bodyCenterZFrac = queen.supportPointOffsetZ / queen.radius.other;
  const expectedTurretZ = verticalSurface === 'high'
    ? bodyCenterZFrac + bodyTopFrac * 0.5
    : bodyCenterZFrac - bodyTopFrac * 0.5;
  assertContract(
    turrets.length === 5,
    `${unitBlueprintId} must mount one large beam and four mini beams`,
  );

  const large = turrets.filter((turret) => turret.turretBlueprintId === 'turretBeamLong');
  const minis = turrets.filter((turret) => turret.turretBlueprintId === 'turretBeamMini');
  assertContract(large.length === 1, `${unitBlueprintId} must mount exactly one large beam`);
  assertContract(minis.length === 4, `${unitBlueprintId} must mount exactly four mini beams`);
  assertContract(
    large[0].mountId === 'beamLong' &&
      large[0].controlMode === 'hostPreferred' &&
      large[0].requiredEngagedForFightStop &&
      large[0].mount.x === replacedHeadX &&
      large[0].mount.y === 0 &&
      Math.abs(large[0].mount.z - expectedTurretZ) < 1e-12,
    `${unitBlueprintId} large beam must replace the old forward head and own host attack intent`,
  );
  assertContract(
    turrets.every((turret) => Math.abs(turret.mount.z - expectedTurretZ) < 1e-12),
    `${unitBlueprintId} turrets must share the body's ${verticalSurface} vertical surface`,
  );

  assertContract(
    queen.bodyShape?.kind === 'composite' && queen.bodyShape.parts.length === 1,
    `${unitBlueprintId} old body-geometry head must be removed instead of hidden under the beam turret`,
  );
  assertContract(
    large[0].sensorTurretBlueprintId === sensorTurretBlueprintId &&
      minis.every((turret) => turret.sensorTurretBlueprintId === undefined),
    `${unitBlueprintId} must carry its long-range sensor package on exactly one mounted origin`,
  );
  assertContract(
    minis.every((turret) =>
      turret.controlMode === 'autonomous' && !turret.requiredEngagedForFightStop,
    ),
    `${unitBlueprintId} side beams must defend autonomously without blocking Fight completion`,
  );

  const left = minis.filter((turret) => turret.mount.y > 0);
  const right = minis.filter((turret) => turret.mount.y < 0);
  assertContract(
    left.length === 2 && right.length === 2,
    `${unitBlueprintId} must mount two mini beams on each side`,
  );
  for (const leftTurret of left) {
    assertContract(
      right.some((rightTurret) =>
        rightTurret.mount.x === leftTurret.mount.x &&
        rightTurret.mount.y === -leftTurret.mount.y &&
        rightTurret.mount.z === leftTurret.mount.z,
      ),
      `${unitBlueprintId} side beam at x=${leftTurret.mount.x} must have a mirrored partner`,
    );
  }

  assertContract(
    !unitTurretsAllowVisualBank3D(turrets),
    `${unitBlueprintId} off-axis weapons must suppress visual-only host banking`,
  );
}

export function runQueenArmamentContractTest(): void {
  assertQueenArmament('unitQueenBee', 'turretSensorUnitQueenBee', 0.52, 'low');
  assertQueenArmament('unitQueenTick', 'turretSensorUnitQueenTick', 0.54, 'high');
  assertContract(
    unitTurretsAllowVisualBank3D(getUnitBlueprint('unitBee').turrets),
    'centerline-only aircraft must retain presentation banking',
  );
}
