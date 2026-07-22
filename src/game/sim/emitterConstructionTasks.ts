import type { Entity, EntityId, Turret } from './types';
import type { WorldState } from './WorldState';
import { ENTITY_CHANGED_TURRETS } from '../../types/network';
import {
  assignEmitterEntityTask,
  clearEmitterTask,
  emitterSupportsEntityOperation,
} from './emitterTasks';

export function isConstructionEmitter(emitter: Turret): boolean {
  return emitter.config.kind === 'resourcePylon' &&
    emitter.config.resourcePylon?.role === 'construction';
}

export function assignHostConstructionTask(
  world: WorldState,
  host: Entity,
  targetId: EntityId,
  operation: 'construct' | 'repair',
): boolean {
  const turrets = host.combat?.turrets;
  if (turrets === undefined) return false;
  let changed = false;
  for (let i = 0; i < turrets.length; i++) {
    const emitter = turrets[i];
    if (!isConstructionEmitter(emitter) || emitter.config.controlMode === 'manual') continue;
    if (emitterSupportsEntityOperation(emitter, operation)) {
      if (assignEmitterEntityTask(emitter, operation, targetId)) changed = true;
    } else if (
      emitter.task?.kind === 'entity' &&
      (emitter.task.operation === 'construct' || emitter.task.operation === 'repair') &&
      clearEmitterTask(emitter)
    ) {
      changed = true;
    }
  }
  if (changed) world.markSnapshotDirty(host.id, ENTITY_CHANGED_TURRETS);
  return changed;
}

export function clearHostConstructionTasks(world: WorldState, host: Entity): boolean {
  const turrets = host.combat?.turrets;
  if (turrets === undefined) return false;
  let changed = false;
  for (let i = 0; i < turrets.length; i++) {
    const emitter = turrets[i];
    if (!isConstructionEmitter(emitter)) continue;
    if (emitter.task?.kind !== 'entity') continue;
    if (emitter.task.operation !== 'construct' && emitter.task.operation !== 'repair') continue;
    if (clearEmitterTask(emitter)) changed = true;
  }
  if (changed) world.markSnapshotDirty(host.id, ENTITY_CHANGED_TURRETS);
  return changed;
}
