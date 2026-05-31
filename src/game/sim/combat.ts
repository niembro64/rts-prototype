// Combat system - re-exports from helper modules
// This file maintains backwards compatibility with existing imports

export type {
  SimEvent,
  FireTurretsResult,
  CollisionResult,
  DeathContext,
  TurretAudioId,
  ProjectileSpawnEvent,
  ProjectileDespawnEvent,
  ProjectileVelocityUpdateEvent,
} from './combat/types';

export {
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
  updateProjectiles,
  checkProjectileCollisions,
  registerPackedProjectile,
  unregisterPackedProjectile,
} from './combat/projectileSystem';
