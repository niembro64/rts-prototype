import type {
  Entity,
  EntityId,
  Turret,
  TurretEntityTaskOperation,
  TurretPointTask,
  TurretSpawnTask,
} from './types';

export type SpawnTaskRequest = Omit<TurretSpawnTask, 'kind' | 'producedEntityId'>;

export function findMountedEmitter(host: Entity, mountId: string): Turret | null {
  const turrets = host.combat?.turrets;
  if (turrets === undefined) return null;
  for (let i = 0; i < turrets.length; i++) {
    if (turrets[i].mountId === mountId) return turrets[i];
  }
  return null;
}

export function findSpawnEmitter(
  host: Entity,
  blueprintKind: 'structure' | 'unit',
): Turret | null {
  const producedKind = blueprintKind === 'unit' ? 'units' : 'buildingsAndTowers';
  const turrets = host.combat?.turrets;
  if (turrets === undefined) return null;
  for (let i = 0; i < turrets.length; i++) {
    const emitter = turrets[i];
    if (emitter.config.kind === 'spawn' && emitter.config.spawn?.producedKind === producedKind) {
      return emitter;
    }
  }
  return null;
}

export function emitterSupportsEntityOperation(
  emitter: Turret,
  operation: TurretEntityTaskOperation,
): boolean {
  if (operation === 'attack') return emitter.config.kind === 'attack';
  if (
    emitter.config.kind !== 'resourcePylon' ||
    emitter.config.resourcePylon?.role !== 'construction'
  ) {
    return false;
  }
  // Repair is currently energy-only. A metal construction pylon remains idle
  // instead of pretending to execute a resource lane that does not exist.
  return operation === 'construct' || emitter.config.resourcePylon.resource === 'energy';
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

export function assignEmitterSpawnTask(
  emitter: Turret,
  request: SpawnTaskRequest,
): boolean {
  if (emitter.config.kind !== 'spawn') return false;
  emitter.task = {
    kind: 'spawn',
    ...request,
    producedEntityId: null,
  };
  emitter.target = null;
  return true;
}

export function completeEmitterSpawnTask(emitter: Turret, producedEntityId: EntityId): boolean {
  if (emitter.task?.kind !== 'spawn') return false;
  emitter.task.producedEntityId = producedEntityId;
  // Once identity exists, expose it through the compact target mirror for the
  // init beam, snapshots, and inspection. The spawn request itself remains the
  // typed source of truth until the host advances the workflow.
  emitter.target = producedEntityId;
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
