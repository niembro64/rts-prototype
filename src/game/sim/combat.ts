// Public combat-system facade over the focused helper modules.

export type {
  SimEvent,


  DeathContext,

  ProjectileSpawnEvent,
  ProjectileDespawnEvent,
  ProjectileMotionUpdateEvent,
} from './combat/types';

export {
  collectTurretRotationUnits,
  updateTurretRotation,
} from './combat/turretSystem';

export {
  updateTargetingAndFiringState,
} from './combat/targetingSchedulerBridge';

export {
  updateLaserSounds,
  emitLaserStopsForEntity,
  emitLaserStopsForTarget,
  resetLaserSoundState,
} from './combat/laserSoundSystem';

export {
  updateShieldSounds,
  emitShieldStopsForEntity,
  resetShieldSoundState,
} from './combat/shieldSoundSystem';

export {
  updateShieldState,
  resetShieldBuffers,
} from './combat/shieldTurret';

export {
  fireTurrets,
  finalizePendingProjectileLaunchVelocities,
  hasPendingProjectileLaunchVelocityFinalization,
  updateProjectiles,
  checkProjectileCollisions,
  registerPackedProjectile,
  unregisterPackedProjectile,
} from './combat/projectileSystem';
