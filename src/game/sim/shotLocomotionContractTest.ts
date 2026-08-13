import { GRAVITY } from '../../config';
import { buildProjectileShotConfig, getTurretBlueprint } from './blueprints';
import { SHOT_BLUEPRINTS } from './blueprints/shots';
import { isProjectileShot } from './types';
import {
  getProjectileHomingEngagementScale,
  getProjectileMediumHoldCounterGravityAcceleration,
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
    assertContract(
      locomotion.maxLifespanMs === null &&
        locomotion.guidanceDelayMs === 0 &&
        locomotion.guidanceRampMs === 0 &&
        locomotion.media.air.turnRate === 0 &&
        locomotion.media.water.turnRate === 0,
      `${blueprint.shotBlueprintId} locomotion preset must not own blueprint lifetime/turning controls`,
    );
  }

  const rocketEmission = buildProjectileShotConfig('shotRocketLight');
  if (!isProjectileShot(rocketEmission)) {
    throw new Error('[shot locomotion contract] shotRocketLight must build a projectile shot');
  }
  const rocketShot = rocketEmission;
  const rocketBlueprint = SHOT_BLUEPRINTS.shotRocketLight;
  const rocketTurning = rocketBlueprint.turning;
  if (rocketTurning === null) {
    throw new Error('[shot locomotion contract] shotRocketLight must author turning controls');
  }
  const rocketLocomotion = rocketShot.shotLocomotion;
  const rocketAir = rocketLocomotion.media.air;
  assertContract(rocketShot.type === 'rocket', 'shotRocketLight must stay on the rocket visual policy');
  assertContract(
    rocketLocomotion.motionModel === 'constantSpeedGuided',
    'shotRocketLight must preserve one speed before and after delayed guidance',
  );
  assertContract(
    rocketLocomotion.gravityForceMultiplier === 0 &&
      rocketAir.propulsionForce === 0 &&
      rocketAir.guidanceThrust === 0 &&
      rocketAir.velocityFrictionPer60HzFrame === 0,
    'constant-speed light rocket cannot hide acceleration, gravity, or drag in its air profile',
  );
  assertContract(
    rocketAir.turnRate === rocketTurning.turnRate,
    'constant-speed light rocket must expand blueprint-authored turn authority',
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
    getProjectileHomingEngagementScale(
      rocketShot,
      delayMs + rocketTurning.guidanceRampMs * 0.5 - fixedStepMs * 0.5,
      fixedStepMs,
    ),
    0.5,
    'rocket homing engagement should reach half strength halfway through the smootherstep ramp',
    1e-6,
  );
  assertContract(
    getProjectileHomingEngagementScale(
      rocketShot,
      delayMs + rocketTurning.guidanceRampMs,
      fixedStepMs,
    ) === 1,
    'rocket homing engagement must reach full strength after the ramp',
  );

  const rocketTurret = getTurretBlueprint('turretRocketSlow');
  const rocketLaunchSpeed = rocketTurret.launchForce / rocketShot.mass;
  assertContract(
    rocketLaunchSpeed === 150,
    `light rocket must launch and cruise at 150 world units/s; got ${rocketLaunchSpeed}`,
  );
  assertContract(
    getPoweredShotReachabilityDistance(
      rocketLocomotion,
      rocketAir,
      rocketLaunchSpeed,
      rocketShot.mass,
    ) >= rocketTurret.targeting.engagement.range,
    'constant-speed light rocket must retain enough lifetime reach for its launcher range',
  );

  for (const shotBlueprintId of ['shotRocketLight', 'shotMissileFast', 'shotMissileLong'] as const) {
    const emission = buildProjectileShotConfig(shotBlueprintId);
    if (!isProjectileShot(emission)) {
      throw new Error(`[shot locomotion contract] ${shotBlueprintId} must build a projectile shot`);
    }
    const locomotion = emission.shotLocomotion;
    const turning = SHOT_BLUEPRINTS[shotBlueprintId].turning;
    if (turning === null) {
      throw new Error(`[shot locomotion contract] ${shotBlueprintId} must author turning controls`);
    }
    assertContract(
      locomotion.motionModel === 'constantSpeedGuided',
      `${shotBlueprintId} must use constant-speed guidance`,
    );
    assertContract(
      locomotion.maxLifespanMs === SHOT_BLUEPRINTS[shotBlueprintId].maxLifespanMs,
      `${shotBlueprintId} must expand its blueprint-authored lifetime`,
    );
    assertContract(
      locomotion.guidanceDelayMs === turning.guidanceDelayMs &&
        locomotion.guidanceRampMs === turning.guidanceRampMs,
      `${shotBlueprintId} must expand its blueprint-authored guidance phase`,
    );
    assertContract(
      locomotion.media.air.turnRate === turning.turnRate,
      `${shotBlueprintId} must expand its blueprint-authored in-flight turn authority`,
    );
  }

  const torpedoEmission = buildProjectileShotConfig('shotTorpedo');
  if (!isProjectileShot(torpedoEmission)) {
    throw new Error('[shot locomotion contract] shotTorpedo must build a projectile shot');
  }
  const torpedoShot = torpedoEmission;
  const torpedoTurning = SHOT_BLUEPRINTS.shotTorpedo.turning;
  if (torpedoTurning === null) {
    throw new Error('[shot locomotion contract] shotTorpedo must author turning controls');
  }
  const torpedoLocomotion = torpedoShot.shotLocomotion;
  const torpedoWater = torpedoLocomotion.media.water;
  assertContract(
    torpedoWater.turnRate === torpedoTurning.turnRate,
    'torpedo must expand blueprint-authored underwater turn authority',
  );
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
    torpedoReach >= (
      torpedoTurret.targeting.effect.rangeSource === 'engagement'
        ? torpedoTurret.targeting.engagement.range
        : (torpedoTurret.targeting.effect.range ?? 0)
    ),
    `torpedo locomotion reach ${torpedoReach} must support authored effect range`,
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
