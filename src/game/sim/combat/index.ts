// Combat system - main orchestrator module
// Re-exports all combat functionality from helper modules

// Types
export type { SimEvent, SimDeathContext, ImpactContext, FireTurretsResult, CollisionResult, DeathContext, TurretAudioId } from './types';
export type { ProjectileSpawnEvent, ProjectileDespawnEvent, ProjectileVelocityUpdateEvent } from './types';

// Utility functions
export { distance, getTargetRadius, normalizeAngle, getMovementAngle } from './combatUtils';

// Turret rotation
export { updateTurretRotation } from './turretSystem';

// Targeting and weapon state
export { updateTargetingAndFiringState } from './targetingSchedulerBridge';

// Laser sounds
export {
  updateLaserSounds,
  emitLaserStopsForEntity,
  emitLaserStopsForTarget,
  resetLaserSoundState,
} from './laserSoundSystem';

// Force field sounds
export {
  updateForceFieldSounds,
  emitForceFieldStopsForEntity,
  resetForceFieldSoundState,
} from './forceFieldSoundSystem';

// Force field weapons
export {
  updateForceFieldState,
  resetForceFieldBuffers,
} from './forceFieldTurret';

// Projectiles
export {
  fireTurrets,
  updateProjectiles,
  checkProjectileCollisions,
  registerPackedProjectile,
  unregisterPackedProjectile,
} from './projectileSystem';
