// Entity class hierarchy exports
export { GameEntity } from './GameEntity';
export { UnitEntity } from './UnitEntity';
export { BuildingEntity } from './BuildingEntity';
export { ProjectileEntity } from './ProjectileEntity';

// Re-export types that are commonly used with entities
export type { EntityId, PlayerId, Transform, Ownership, Selectable } from '../types';
