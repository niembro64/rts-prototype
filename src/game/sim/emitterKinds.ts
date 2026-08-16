import type { Turret, TurretConfig } from './types';

/** Effect-family predicates. Callers must never infer emitter behavior from
 * nullable shot data or renderer flags. */
export function isPassiveShieldFieldConfig(config: TurretConfig): boolean {
  return config.kind === 'attack' &&
    config.shot?.type === 'shield' &&
    config.shot.barrier !== undefined;
}

export function isAttackEmitterConfig(config: TurretConfig): boolean {
  // Persistent sphere/cylinder barriers are mounted shield capabilities, not
  // target-acquiring weapons. Directional shield panels have no barrier on
  // their shot config and remain attack turrets because they must aim at an
  // incoming threat.
  return config.kind === 'attack' && !isPassiveShieldFieldConfig(config);
}

export function isAttackEmitter(emitter: Turret): boolean {
  return isAttackEmitterConfig(emitter.config);
}

export function isManualEmitterConfig(config: TurretConfig): boolean {
  return config.controlMode === 'manual';
}
