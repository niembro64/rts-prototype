// Combat system - re-exports from helper modules
// This file maintains backwards compatibility with existing imports

export type {
  SimEvent,
  FireWeaponsResult,
  CollisionResult,
  DeathContext,
  WeaponAudioId,
  ProjectileSpawnEvent,
  ProjectileDespawnEvent,
  ProjectileVelocityUpdateEvent,
} from './combat/types';

export {
  updateTurretRotation,
} from './combat/turretSystem';

export {
  updateTargetingAndFiringState,
  updateWeaponCooldowns,
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
  applyForceFieldDamage,
  resetForceFieldBuffers,
} from './combat/forceFieldWeapon';

export {
  fireWeapons,
  updateProjectiles,
  checkProjectileCollisions,
} from './combat/projectileSystem';
