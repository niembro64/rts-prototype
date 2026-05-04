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
} from './combat/targetingSystem';

export {
  updateLaserSounds,
  emitLaserStopsForEntity,
  emitLaserStopsForTarget,
} from './combat/laserSoundSystem';

export {
  updateForceFieldSounds,
  emitForceFieldStopsForEntity,
} from './combat/forceFieldSoundSystem';

export {
  updateForceFieldState,
  findForceFieldProjectileIntersection,
  resetForceFieldBuffers,
} from './combat/forceFieldTurret';

export {
  fireTurrets,
  updateProjectiles,
  checkProjectileCollisions,
  registerPackedProjectile,
  unregisterPackedProjectile,
} from './combat/projectileSystem';
