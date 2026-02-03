// Combat system - re-exports from helper modules
// This file maintains backwards compatibility with existing imports

export type {
  AudioEvent,
  FireWeaponsResult,
  CollisionResult,
  DeathContext,
  WeaponAudioId,
} from './combat/types';

export {
  updateTurretRotation,
} from './combat/turretSystem';

export {
  updateAutoTargeting,
  updateWeaponCooldowns,
  updateWeaponFiringState,
} from './combat/targetingSystem';

export {
  updateLaserSounds,
} from './combat/laserSoundSystem';

export {
  updateWaveWeaponState,
  applyWaveDamage,
} from './combat/waveWeapon';

export {
  fireWeapons,
  updateProjectiles,
  checkProjectileCollisions,
  removeDeadUnits,
} from './combat/projectileSystem';
