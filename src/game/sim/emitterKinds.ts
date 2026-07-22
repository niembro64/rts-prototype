import type { Turret, TurretConfig } from './types';

/** Effect-family predicates. Callers must never infer emitter behavior from
 * nullable shot data or renderer flags. */
export function isAttackEmitterConfig(config: TurretConfig): boolean {
  return config.kind === 'attack';
}

export function isAttackEmitter(emitter: Turret): boolean {
  return isAttackEmitterConfig(emitter.config);
}

export function isManualEmitterConfig(config: TurretConfig): boolean {
  return config.controlMode === 'manual';
}

export function isAutomatedAttackEmitterConfig(config: TurretConfig): boolean {
  return isAttackEmitterConfig(config) && !isManualEmitterConfig(config);
}

export function isTargetableEmitter(emitter: Turret): boolean {
  return emitter.id >= 0 && isAttackEmitter(emitter);
}
