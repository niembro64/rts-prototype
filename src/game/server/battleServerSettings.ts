import type { BattleMode } from '../../battleBarConfig';
import {
  loadStoredConverterTax,
  loadStoredForceFieldsVisible,
  loadStoredShieldReflectionMode,
  loadStoredShieldsObstructSight,
  loadStoredTurretShieldSpheresEnabled,
  loadStoredFogOfWarEnabled,
  loadStoredGrid,
  loadStoredTurretShieldPanelsEnabled,
} from '../../battleBarConfig';
import {
  loadStoredUnitGroundNormalEmaMode,
} from '../../serverBarConfig';
import type { GameServer } from './GameServer';
import type { CommandAuthority } from './commandAuthority';
import type { Command } from '../sim/commands';

export type StoredBattleServerSettingsOptions = {
  ipAddress: string | undefined;
  maxTotalUnits: number | undefined;
  /** When set, overrides the stored fog-of-war value. Lobby preview
   *  passes `false` and real-battle startup passes `true`; the demo
   *  battle leaves it undefined so the DEMO BATTLE bar toggle still
   *  drives the value via stored 'demo' preferences. */
  fogOfWarEnabled?: boolean;
};

const DEFAULT_STORED_BATTLE_SERVER_SETTINGS_OPTIONS: StoredBattleServerSettingsOptions = {
  ipAddress: undefined,
  maxTotalUnits: undefined,
};

export function buildStoredBattleServerSettingCommands(
  mode: BattleMode,
  options: StoredBattleServerSettingsOptions = DEFAULT_STORED_BATTLE_SERVER_SETTINGS_OPTIONS,
): Command[] {
  const commands: Command[] = [
    {
      type: 'setUnitGroundNormalEmaMode',
      tick: 0,
      mode: loadStoredUnitGroundNormalEmaMode(mode),
    },
  ];

  if (options.maxTotalUnits !== undefined) {
    commands.push({
      type: 'setMaxTotalUnits',
      tick: 0,
      maxTotalUnits: options.maxTotalUnits,
    });
  }

  commands.push(
    {
      type: 'setTurretShieldPanelsEnabled',
      tick: 0,
      enabled: loadStoredTurretShieldPanelsEnabled(mode),
    },
    {
      type: 'setTurretShieldSpheresEnabled',
      tick: 0,
      enabled: loadStoredTurretShieldSpheresEnabled(mode),
    },
    {
      type: 'setForceFieldsVisible',
      tick: 0,
      enabled: loadStoredForceFieldsVisible(mode),
    },
    {
      type: 'setShieldsObstructSight',
      tick: 0,
      enabled: loadStoredShieldsObstructSight(mode),
    },
    {
      type: 'setShieldReflectionMode',
      tick: 0,
      mode: loadStoredShieldReflectionMode(mode),
    },
    {
      type: 'setFogOfWarEnabled',
      tick: 0,
      enabled: options.fogOfWarEnabled ?? loadStoredFogOfWarEnabled(mode),
    },
    {
      type: 'setConverterTax',
      tick: 0,
      tax: loadStoredConverterTax(mode),
    },
    {
      type: 'setSendGridInfo',
      tick: 0,
      enabled: loadStoredGrid(mode),
    },
  );

  return commands;
}

export function applyStoredBattleServerSettings(
  server: GameServer,
  mode: BattleMode,
  options: StoredBattleServerSettingsOptions = DEFAULT_STORED_BATTLE_SERVER_SETTINGS_OPTIONS,
): void {
  const authority: CommandAuthority = { mode: 'host-admin' };
  if (options.ipAddress !== undefined) {
    server.setIpAddress(options.ipAddress);
  }
  for (const command of buildStoredBattleServerSettingCommands(mode, options)) {
    server.receiveCommand(command, authority);
  }
}
