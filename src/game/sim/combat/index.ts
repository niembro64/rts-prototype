// Combat system - main orchestrator module
// Re-exports all combat functionality from helper modules

// Types
export type { SimEvent, SimDeathContext, ImpactContext, FireWeaponsResult, CollisionResult, DeathContext, WeaponAudioId } from './types';
export type { ProjectileSpawnEvent, ProjectileDespawnEvent, ProjectileVelocityUpdateEvent } from './types';

// Utility functions
export { distance, getTargetRadius, normalizeAngle, getMovementAngle, getBarrelTipOffset } from './combatUtils';

// Turret rotation
export { updateTurretRotation } from './turretSystem';

// Targeting and weapon state
export { updateTargetingAndFiringState, updateWeaponCooldowns } from './targetingSystem';

// Laser sounds
export { updateLaserSounds, emitLaserStopsForEntity, emitLaserStopsForTarget } from './laserSoundSystem';

// Force field sounds
export { updateForceFieldSounds, emitForceFieldStopsForEntity } from './forceFieldSoundSystem';

// Force field weapons
export { updateForceFieldState, applyForceFieldDamage, resetForceFieldBuffers } from './forceFieldWeapon';

// Projectiles
export { fireWeapons, updateProjectiles, checkProjectileCollisions } from './projectileSystem';
