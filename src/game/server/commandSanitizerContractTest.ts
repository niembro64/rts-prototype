import type {
  Command,
  SetShieldReflectionModeCommand,
  SetTurretShieldPanelsEnabledCommand,
  SetTurretShieldSpheresEnabledCommand,
} from '../sim/commands';
import { WorldState } from '../sim/WorldState';
import {
  SHIELD_REFLECTION_MODES,
  type ShieldReflectionMode,
} from '../../types/shotTypes';
import { sanitizeCommand } from './commandSanitizer';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[command sanitizer contract] ${message}`);
  }
}

function sanitizeRequired<T extends Command>(world: WorldState, command: T): T {
  const sanitized = sanitizeCommand(command, world);
  if (sanitized === null) {
    throw new Error(`[command sanitizer contract] ${command.type} should pass sanitizer`);
  }
  assertContract(
    sanitized.type === command.type,
    `${command.type} should not be rewritten to another command type`,
  );
  return sanitized as T;
}

export function runCommandSanitizerContractTest(): void {
  const world = new WorldState(9001, 128, 128);

  const panelsDisabled = sanitizeRequired<SetTurretShieldPanelsEnabledCommand>(world, {
    type: 'setTurretShieldPanelsEnabled',
    tick: 1,
    enabled: false,
  });
  assertContract(
    panelsDisabled.enabled === false,
    'setTurretShieldPanelsEnabled must preserve enabled=false',
  );

  const spheresDisabled = sanitizeRequired<SetTurretShieldSpheresEnabledCommand>(world, {
    type: 'setTurretShieldSpheresEnabled',
    tick: 2,
    enabled: false,
  });
  assertContract(
    spheresDisabled.enabled === false,
    'setTurretShieldSpheresEnabled must preserve enabled=false',
  );

  for (const mode of SHIELD_REFLECTION_MODES) {
    const sanitized = sanitizeRequired<SetShieldReflectionModeCommand>(world, {
      type: 'setShieldReflectionMode',
      tick: 3,
      mode: mode as ShieldReflectionMode,
    });
    assertContract(
      sanitized.mode === mode,
      `setShieldReflectionMode must preserve mode=${mode}`,
    );
  }
}
