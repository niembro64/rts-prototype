import type {
  Entity,
  EntityId,
  Turret,
  TurretEntityTaskOperation,
  TurretPointTask,
} from './types';

export function emitterSupportsEntityOperation(
  emitter: Turret,
  operation: TurretEntityTaskOperation,
): boolean {
  return operation === 'attack' && emitter.config.kind === 'attack';
}

export function assignEmitterEntityTask(
  emitter: Turret,
  operation: TurretEntityTaskOperation,
  targetId: EntityId,
): boolean {
  if (!emitterSupportsEntityOperation(emitter, operation)) return false;
  const task = emitter.task;
  if (
    task?.kind === 'entity' &&
    task.operation === operation &&
    task.targetId === targetId &&
    emitter.target === targetId
  ) {
    return false;
  }
  emitter.task = { kind: 'entity', operation, targetId };
  emitter.target = targetId;
  return true;
}

export function assignEmitterPointTask(
  emitter: Turret,
  task: Omit<TurretPointTask, 'kind'>,
): boolean {
  if (emitter.config.kind !== 'attack') return false;
  const current = emitter.task;
  if (
    current?.kind === 'point' &&
    current.operation === task.operation &&
    current.x === task.x &&
    current.y === task.y &&
    current.z === task.z
  ) {
    return false;
  }
  emitter.task = { kind: 'point', ...task };
  emitter.target = null;
  return true;
}

export function clearEmitterTask(emitter: Turret): boolean {
  if (emitter.task === null && emitter.target === null) return false;
  emitter.task = null;
  emitter.target = null;
  return true;
}

export function clearHostEmitterTasks(
  host: Entity,
  predicate: (emitter: Turret) => boolean = () => true,
): boolean {
  const turrets = host.combat?.turrets;
  if (turrets === undefined) return false;
  let changed = false;
  for (let i = 0; i < turrets.length; i++) {
    if (predicate(turrets[i]) && clearEmitterTask(turrets[i])) changed = true;
  }
  return changed;
}
