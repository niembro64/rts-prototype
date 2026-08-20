// Contract: every gameplay-setting command has exactly ONE implementation,
// and it actually moves world state.
//
// These commands reach the simulation two ways — through the lockstep command
// frame in a real battle, and straight from the host in the demo sandbox. Both
// end in applyGameplaySettingCommand. A setting that is silently ignored there
// is a bar toggle that does nothing, which is how a battle setting came to
// behave differently online than it did in the sandbox.

import { LOCKSTEP_GAMEPLAY_SETTING_COMMAND_TYPES } from '../architecture/LockstepCommandProtocol';
import { sanitizeCommand } from '../server/commandSanitizer';
import { applyGameplaySettingCommand } from './commandExecution';
import {
  getLiquidSurfaceMode,
  getMetalCoverage,
  setLiquidSurfaceMode,
  setMetalCoverage,
} from './worldSurfaceState';
import {
  getUnitGroundNormalEmaMode,
  setUnitGroundNormalEmaMode,
} from './unitGroundNormal';
import type { Command } from './commands';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[gameplay setting command] ${message}`);
}

type SettingCase = {
  readonly type: Command['type'];
  /** Candidate (command, resulting value) pairs. The case runs the first one
   *  whose value differs from the world's current value, so the assertion can
   *  never be satisfied by a default that happened to match. */
  readonly candidates: readonly { readonly command: Command; readonly value: unknown }[];
  /** Absent when the setting lives outside WorldState; the case then only
   *  proves the sanitizer accepts it and the applier claims it. */
  readonly read?: (world: WorldState) => unknown;
};

function booleanCase(
  type: Command['type'],
  read: (world: WorldState) => unknown,
  build: (enabled: boolean) => Command,
): SettingCase {
  return {
    type,
    read,
    candidates: [
      { command: build(true), value: true },
      { command: build(false), value: false },
    ],
  };
}

function buildSettingCases(): SettingCase[] {
  return [
    {
      type: 'setUnitGroundNormalEmaMode',
      candidates: [
        { command: { type: 'setUnitGroundNormalEmaMode', tick: 0, mode: 'snap' }, value: undefined },
      ],
    },
    {
      type: 'setEntityCountCap',
      read: (world) => world.entityCountCap,
      candidates: [
        { command: { type: 'setEntityCountCap', tick: 0, entityCountCap: 750 }, value: 750 },
        { command: { type: 'setEntityCountCap', tick: 0, entityCountCap: 250 }, value: 250 },
      ],
    },
    booleanCase(
      'setTurretShieldPanelsEnabled',
      (world) => world.turretShieldPanelsEnabled,
      (enabled) => ({ type: 'setTurretShieldPanelsEnabled', tick: 0, enabled }),
    ),
    booleanCase(
      'setTurretShieldSpheresEnabled',
      (world) => world.turretShieldSpheresEnabled,
      (enabled) => ({ type: 'setTurretShieldSpheresEnabled', tick: 0, enabled }),
    ),
    booleanCase(
      'setForceFieldsVisible',
      (world) => world.forceFieldsVisible,
      (enabled) => ({ type: 'setForceFieldsVisible', tick: 0, enabled }),
    ),
    {
      type: 'setShieldReflectionMode',
      read: (world) => world.shieldReflectionMode,
      candidates: [
        { command: { type: 'setShieldReflectionMode', tick: 0, mode: 'outside-in' }, value: 'outside-in' },
        { command: { type: 'setShieldReflectionMode', tick: 0, mode: 'inside-out' }, value: 'inside-out' },
        { command: { type: 'setShieldReflectionMode', tick: 0, mode: 'both' }, value: 'both' },
      ],
    },
    booleanCase(
      'setFogOfWarEnabled',
      (world) => world.fogOfWarEnabled,
      (enabled) => ({ type: 'setFogOfWarEnabled', tick: 0, enabled }),
    ),
    booleanCase(
      'setSlowDownAtFinalWaypoint',
      (world) => world.slowDownAtFinalWaypoint,
      (enabled) => ({ type: 'setSlowDownAtFinalWaypoint', tick: 0, enabled }),
    ),
    {
      type: 'setSlopePathMode',
      read: (world) => world.slopePathMode,
      candidates: [
        { command: { type: 'setSlopePathMode', tick: 0, mode: 'symmetric' }, value: 'symmetric' },
        { command: { type: 'setSlopePathMode', tick: 0, mode: 'directional' }, value: 'directional' },
      ],
    },
    {
      type: 'setMetalCoverage',
      read: (world) => world.metalCoverage,
      candidates: [
        { command: { type: 'setMetalCoverage', tick: 0, mode: 'all' }, value: 'all' },
        { command: { type: 'setMetalCoverage', tick: 0, mode: 'none' }, value: 'none' },
      ],
    },
    {
      type: 'setLiquidSurfaceMode',
      read: (world) => world.liquidSurfaceMode,
      candidates: [
        { command: { type: 'setLiquidSurfaceMode', tick: 0, mode: 'lava' }, value: 'lava' },
        { command: { type: 'setLiquidSurfaceMode', tick: 0, mode: 'water' }, value: 'water' },
      ],
    },
    {
      type: 'setConverterTax',
      read: (world) => world.converterTax,
      candidates: [
        { command: { type: 'setConverterTax', tick: 0, tax: 0.5 }, value: 0.5 },
        { command: { type: 'setConverterTax', tick: 0, tax: 0.1 }, value: 0.1 },
      ],
    },
  ];
}

export function runGameplaySettingCommandContractTest(): void {
  // WORLD-group settings also write module-scoped battle state that the
  // renderers read. This suite shares one page, so restore it: leaving the
  // battle in lava made a later demo-layout test find no workable underwater
  // deposits.
  const restoreMetalCoverage = getMetalCoverage();
  const restoreLiquidSurfaceMode = getLiquidSurfaceMode();
  const restoreEmaMode = getUnitGroundNormalEmaMode();
  try {
    runGameplaySettingCommandCases();
  } finally {
    setMetalCoverage(restoreMetalCoverage);
    setLiquidSurfaceMode(restoreLiquidSurfaceMode);
    setUnitGroundNormalEmaMode(restoreEmaMode);
  }
}

function runGameplaySettingCommandCases(): void {
  const cases = buildSettingCases();
  const covered = new Set(cases.map((entry) => entry.type));
  for (const commandType of LOCKSTEP_GAMEPLAY_SETTING_COMMAND_TYPES) {
    assertContract(
      covered.has(commandType),
      `${commandType} is a gameplay setting with no parity case; add one so a dead toggle cannot ship`,
    );
  }

  for (const entry of cases) {
    const world = new WorldState(4242, 512, 512);
    const read = entry.read;
    const chosen = read === undefined
      ? entry.candidates[0]
      : entry.candidates.find((candidate) => candidate.value !== read(world));
    assertContract(
      chosen !== undefined,
      `${entry.type} needs a candidate value that differs from the world default`,
    );
    const sanitized = sanitizeCommand(chosen.command, world);
    assertContract(
      sanitized !== null,
      `${entry.type} must survive the shared command sanitizer`,
    );
    applyGameplaySettingCommand(world, sanitized);
    if (read === undefined) continue;
    assertContract(
      read(world) === chosen.value,
      `${entry.type} must move world state through the shared applier ` +
        `(expected ${String(chosen.value)}, got ${String(read(world))})`,
    );
  }
}
