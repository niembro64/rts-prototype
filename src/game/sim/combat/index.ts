// Combat system - main orchestrator module
// Re-exports all combat functionality from helper modules

// Types
export type { AudioEvent, FireWeaponsResult, CollisionResult, DeathContext, WeaponAudioId } from './types';

// Utility functions
export { distance, getTargetRadius, normalizeAngle, getMovementAngle } from './combatUtils';

// Turret rotation
export { updateTurretRotation } from './turretSystem';

// Targeting and weapon state
export { updateAutoTargeting, updateWeaponCooldowns, updateWeaponFiringState } from './targetingSystem';

// Laser sounds
export { updateLaserSounds } from './laserSoundSystem';

// Wave weapons
export { updateWaveWeaponState, applyWaveDamage } from './waveWeapon';

// Projectiles
export { fireWeapons, updateProjectiles, checkProjectileCollisions, removeDeadUnits } from './projectileSystem';
