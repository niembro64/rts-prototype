import type { Entity, Turret } from './types';
import {
  assignEmitterEntityTask,
  assignEmitterPointTask,
  clearEmitterTask,
} from './emitterTasks';

function isHostCombatEmitter(emitter: Turret): boolean {
  return emitter.config.kind === 'attack' &&
    (
      emitter.config.controlMode === 'hostPreferred' ||
      emitter.config.controlMode === 'hostOnly'
    );
}

/** Project the host's attack lane onto compatible host-controlled mounts.
 * Autonomous mounts retain independent acquisition and manual mounts retain
 * their ability-owned task. This is the sole host->combat-emitter adapter. */
export function synchronizeHostCombatEmitterTasks(host: Entity): boolean {
  const combat = host.combat;
  if (combat === null) return false;
  let changed = false;

  for (let i = 0; i < combat.turrets.length; i++) {
    const emitter = combat.turrets[i];
    if (!isHostCombatEmitter(emitter)) continue;

    if (combat.priorityTargetId !== null) {
      if (assignEmitterEntityTask(emitter, 'attack', combat.priorityTargetId)) changed = true;
      continue;
    }
    if (combat.priorityTargetPoint !== null) {
      if (assignEmitterPointTask(emitter, {
        operation: 'attackGround',
        x: combat.priorityTargetPoint.x,
        y: combat.priorityTargetPoint.y,
        z: combat.priorityTargetPoint.z,
      })) changed = true;
      continue;
    }
    if (
      (emitter.task?.kind === 'entity' && emitter.task.operation === 'attack') ||
      (emitter.task?.kind === 'point' && emitter.task.operation === 'attackGround')
    ) {
      if (clearEmitterTask(emitter)) changed = true;
    }
  }

  // Slaved mounts mirror a named sibling after host intent has been
  // projected. A master's independently acquired target is mirrored on the
  // following tick; explicit host/manual tasks mirror immediately.
  for (let i = 0; i < combat.turrets.length; i++) {
    const emitter = combat.turrets[i];
    if (
      emitter.config.kind !== 'attack' ||
      emitter.config.controlMode !== 'slaved' ||
      emitter.config.slavedToMountId === null
    ) {
      continue;
    }
    const master = combat.turrets.find(
      (candidate) => candidate.mountId === emitter.config.slavedToMountId,
    );
    if (master === undefined || master === emitter) {
      if (clearEmitterTask(emitter)) changed = true;
      continue;
    }
    if (master.task?.kind === 'entity') {
      if (
        assignEmitterEntityTask(
          emitter,
          master.task.operation,
          master.task.targetId,
        )
      ) {
        changed = true;
      }
      continue;
    }
    if (master.task?.kind === 'point') {
      if (
        assignEmitterPointTask(emitter, {
          operation: master.task.operation,
          x: master.task.x,
          y: master.task.y,
          z: master.task.z,
        })
      ) {
        changed = true;
      }
      continue;
    }
    if (master.target !== null) {
      if (assignEmitterEntityTask(emitter, 'attack', master.target)) changed = true;
      continue;
    }
    if (clearEmitterTask(emitter)) changed = true;
  }
  return changed;
}

export function getEmitterAttackTaskTargetId(emitter: Turret): number {
  const task = emitter.task;
  return task?.kind === 'entity' && task.operation === 'attack' ? task.targetId : -1;
}

export function hasEmitterAttackPointTask(emitter: Turret): boolean {
  const task = emitter.task;
  return task?.kind === 'point' && task.operation === 'attackGround';
}
