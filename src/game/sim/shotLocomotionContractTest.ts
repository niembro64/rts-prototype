import { GRAVITY } from '../../config';
import { buildProjectileShotConfig, getTurretBlueprint } from './blueprints';
import { SHOT_BLUEPRINTS } from './blueprints/shots';
import { isProjectileShot } from './types';
import {
  getProjectileHomingEngagementScale,
  getProjectileHomingThrustAcceleration,
  getProjectileMediumHoldCounterGravityAcceleration,
  getProjectileRocketCounterGravityCarryAcceleration,
} from './shotLocomotionMotion';
import {
  getShotLocomotionPreset,
  getShotWaterSurfaceCrossingFraction,
  getPoweredShotReachabilityDistance,
  shotLocomotionCanOperateInWater,
  shotLocomotionPhysicsAppliesAtHeight,
  shotLocomotionUsesBallisticFeasibility,
} from './shotLocomotion';
import { WATER_LEVEL } from './Terrain';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[projectile motion contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string, epsilon = 1e-9): void {
  assertContract(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
}

export function runShotLocomotionContractTest(): void {
  for (const blueprint of Object.values(SHOT_BLUEPRINTS)) {
    const locomotion = getShotLocomotionPreset(blueprint.shotLocomotionPresetId);
    assertContract(
      locomotion.presetId === blueprint.shotLocomotionPresetId,
      `${blueprint.shotBlueprintId} expands its authored shot locomotion preset`,
    );
  }

  const rocketEmission = buildProjectileShotConfig('shotRocketLight');
  if (!isProjectileShot(rocketEmission)) {
    throw new Error('[shot locomotion contract] shotRocketLight must build a projectile shot');
  }
  const rocketShot = rocketEmission;
  const rocketLocomotion = getShotLocomotionPreset(rocketShot.shotLocomotion.presetId);
  const rocketAir = rocketLocomotion.media.air;
  assertContract(rocketShot.type === 'rocket', 'shotRocketLight must stay on the rocket visual policy');
  assertContract(rocketLocomotion.gravityForceMultiplier === 1, 'shotRocketLight must use real projectile gravity');

  const projectileGravity = GRAVITY * rocketLocomotion.gravityForceMultiplier;
  const maxThrustAccel = getProjectileHomingThrustAcceleration(rocketShot, rocketAir);
  assertContract(maxThrustAccel > 0, 'light rocket must author positive guidance thrust');

  assertNear(
    getProjectileRocketCounterGravityCarryAcceleration(rocketShot, rocketAir, 0, projectileGravity),
    projectileGravity,
    'delayed rocket guidance must fully carry gravity before lateral steering starts',
  );
  assertNear(
    getProjectileRocketCounterGravityCarryAcceleration(rocketShot, rocketAir, 1, projectileGravity),
    projectileGravity - maxThrustAccel,
    'fully engaged rocket carry term must cover gravity left outside bounded guidance thrust',
  );

  const delayMs = rocketLocomotion.guidanceDelayMs;
  assertContract(
    getProjectileHomingEngagementScale(rocketShot, delayMs - 16, 16) === 0,
    'homing engagement must remain zero before the delay midpoint crosses',
  );

  const fixedStepMs = 1000 / 30;
  const firstPostDelayScale = getProjectileHomingEngagementScale(rocketShot, delayMs, fixedStepMs);
  assertContract(
    firstPostDelayScale > 0 && firstPostDelayScale < 0.001,
    `first 30Hz post-delay guidance step must be a very small soft-start; got ${firstPostDelayScale}`,
  );
  assertNear(
    getProjectileHomingEngagementScale(rocketShot, delayMs + 350 - fixedStepMs * 0.5, fixedStepMs),
    0.5,
    'rocket homing engagement should reach half strength halfway through the smootherstep ramp',
    1e-6,
  );
  assertContract(
    getProjectileHomingEngagementScale(rocketShot, delayMs + 700, fixedStepMs) === 1,
    'rocket homing engagement must reach full strength after the ramp',
  );

  const torpedoEmission = buildProjectileShotConfig('shotTorpedo');
  if (!isProjectileShot(torpedoEmission)) {
    throw new Error('[shot locomotion contract] shotTorpedo must build a projectile shot');
  }
  const torpedoShot = torpedoEmission;
  const torpedoLocomotion = getShotLocomotionPreset(torpedoShot.shotLocomotion.presetId);
  const torpedoWater = torpedoLocomotion.media.water;
  assertContract(!torpedoLocomotion.media.air.operational, 'torpedo engine policy must exclude air');
  assertContract(torpedoLocomotion.gravityForceMultiplier === 1, 'torpedo must retain universal gravity');
  assertContract(
    !shotLocomotionUsesBallisticFeasibility(torpedoLocomotion),
    'powered torpedo targeting must not use the unpowered ballistic solver',
  );
  assertContract(
    torpedoLocomotion.transitions.enterWater === 'continue',
    'torpedo must cross from air into water without terminating',
  );
  assertContract(
    torpedoLocomotion.transitions.exitWater === 'continueBallistic',
    'torpedo must cross from water into air and lose engine authority without terminating',
  );
  assertContract(
    torpedoLocomotion.maxLifespanMs === 10000,
    'torpedo must use the same long ten-second lifetime as the guided rocket',
  );
  assertContract(
    torpedoLocomotion.terminal.expiry === 'detonate',
    'torpedo must detonate when its long lifetime expires',
  );
  assertContract(
    shotLocomotionPhysicsAppliesAtHeight(torpedoLocomotion, WATER_LEVEL - 1, WATER_LEVEL),
    'torpedo propulsion and guidance must engage underwater',
  );
  assertContract(
    !shotLocomotionPhysicsAppliesAtHeight(torpedoLocomotion, WATER_LEVEL + 1, WATER_LEVEL),
    'torpedo propulsion and gravity compensation must disengage above water',
  );
  assertContract(
    shotLocomotionCanOperateInWater(torpedoLocomotion),
    'torpedo seabed impacts must use water-compatible terminal behavior',
  );
  assertNear(
    getProjectileMediumHoldCounterGravityAcceleration(
      torpedoShot,
      torpedoWater,
      true,
      true,
      false,
      GRAVITY,
    ),
    GRAVITY,
    'unlocked underwater torpedo must spend thrust to hold gravity',
  );
  assertNear(
    getProjectileMediumHoldCounterGravityAcceleration(
      torpedoShot,
      torpedoWater,
      false,
      false,
      false,
      GRAVITY,
    ),
    0,
    'breached torpedo must lose gravity compensation above water',
  );
  assertNear(
    getShotWaterSurfaceCrossingFraction(WATER_LEVEL + 10, WATER_LEVEL - 10, WATER_LEVEL) ?? -1,
    0.5,
    'air projectile water entry must use the swept surface crossing',
  );
  assertNear(
    getShotWaterSurfaceCrossingFraction(WATER_LEVEL - 10, WATER_LEVEL + 10, WATER_LEVEL) ?? -1,
    0.5,
    'water projectile exit must use the swept surface crossing',
  );

  const torpedoTurret = getTurretBlueprint('turretTorpedo');
  const torpedoLaunchSpeed = torpedoTurret.launchForce / torpedoShot.mass;
  const torpedoReach = getPoweredShotReachabilityDistance(
    torpedoLocomotion,
    torpedoWater,
    torpedoLaunchSpeed,
    torpedoShot.mass,
  );
  assertContract(
    torpedoReach >= torpedoTurret.range,
    `torpedo locomotion reach ${torpedoReach} must support authored range ${torpedoTurret.range}`,
  );
  assertContract(
    getPoweredShotReachabilityDistance(
      torpedoLocomotion,
      torpedoLocomotion.media.air,
      torpedoLaunchSpeed,
      torpedoShot.mass,
    ) === 0,
    'torpedo targeting reach must be zero when launched in a non-operational medium',
  );

  const disruptor = buildProjectileShotConfig('shotPlasmaDisruptor');
  if (!isProjectileShot(disruptor)) {
    throw new Error('[shot locomotion contract] disruptor must build a projectile shot');
  }
  assertContract(
    disruptor.shotLocomotion.media.ground.mode === 'terrainFollowing',
    'terrain-following behavior must be shot-locomotion authored',
  );
}
