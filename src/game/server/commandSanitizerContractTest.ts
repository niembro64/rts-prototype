import type {
  Command,
  MoveCommand,
  SkipCurrentOrderCommand,
  StopFactoryProductionCommand,
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

  const skipCurrent = sanitizeRequired<SkipCurrentOrderCommand>(world, {
    type: 'skipCurrentOrder',
    tick: 4,
    entityIds: [1, 2, 2],
  });
  assertContract(
    skipCurrent.tick === 9001 && skipCurrent.entityIds.join(',') === '1,2,2',
    'skipCurrentOrder must sanitize through the unit-list path and normalize tick',
  );

  const stopFactoryProduction = sanitizeRequired<StopFactoryProductionCommand>(world, {
    type: 'stopFactoryProduction',
    tick: 5,
    factoryId: 42,
  });
  assertContract(
    stopFactoryProduction.tick === 9001 && stopFactoryProduction.factoryId === 42,
    'stopFactoryProduction must preserve a valid factory id and normalize tick',
  );

  const queueFrontMove = sanitizeRequired<MoveCommand>(world, {
    type: 'move',
    tick: 6,
    entityIds: [7],
    targetX: 12,
    targetY: 13,
    waypointType: 'move',
    queue: true,
    queueFront: true,
  });
  assertContract(
    queueFrontMove.tick === 9001 && queueFrontMove.queueFront === true,
    'move queueFront must survive sanitizer when queue=true',
  );

  const replaceMove = sanitizeRequired<MoveCommand>(world, {
    type: 'move',
    tick: 7,
    entityIds: [7],
    targetX: 14,
    targetY: 15,
    waypointType: 'fight',
    queue: false,
    queueFront: true,
  });
  assertContract(
    replaceMove.queueFront === false,
    'move queueFront must normalize to false when queue=false',
  );

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
