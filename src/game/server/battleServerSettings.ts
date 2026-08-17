import type { BattleMode } from '../../battleBarConfig';
import {
  loadStoredConverterTax,
  loadStoredShieldReflectionMode,
  loadStoredTurretShieldSpheresEnabled,
  loadStoredFogOfWarEnabled,
  loadStoredSlowDownAtFinalWaypoint,
  loadStoredSlopePathMode,
  loadStoredTerrainSurfaceMode,
  loadStoredLiquidSurfaceMode,
  loadStoredTurretShieldPanelsEnabled,
} from '../../battleBarConfig';
import {
  loadStoredUnitGroundNormalEmaMode,
} from '../../serverBarConfig';
import type { GameServer } from './GameServer';
import type { CommandAuthority } from './commandAuthority';
import type { Command } from '../sim/commands';
import type {
  LiquidSurfaceMode,
  TerrainSurfaceMode,
} from '../../types/worldSurfaceMode';

type StoredBattleServerSettingsOptions = {
  ipAddress: string | undefined;
  entityCountCap: number | undefined;
  /** When set, overrides the stored fog-of-war value. Lobby preview
   *  passes `false` and real-battle startup passes `true`; the demo
   *  battle leaves it undefined so the DEMO BATTLE bar toggle still
   *  drives the value via stored 'demo' preferences. */
  fogOfWarEnabled?: boolean;
  /** Canonical handoff value for real battles. Demo/background callers omit
   *  it and use their mode's persisted BATTLE toggle. */
  slowDownAtFinalWaypoint?: boolean;
  /** Canonical real-battle WORLD selections. Background/demo callers omit
   *  them and use the stored namespace. */
  terrainSurfaceMode?: TerrainSurfaceMode;
  liquidSurfaceMode?: LiquidSurfaceMode;
};

const DEFAULT_STORED_BATTLE_SERVER_SETTINGS_OPTIONS: StoredBattleServerSettingsOptions = {
  ipAddress: undefined,
  entityCountCap: undefined,
};

function buildStoredBattleServerSettingCommands(
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

  if (options.entityCountCap !== undefined) {
    commands.push({
      type: 'setEntityCountCap',
      tick: 0,
      entityCountCap: options.entityCountCap,
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
      type: 'setSlowDownAtFinalWaypoint',
      tick: 0,
      enabled:
        options.slowDownAtFinalWaypoint ??
        loadStoredSlowDownAtFinalWaypoint(mode),
    },
    {
      type: 'setSlopePathMode',
      tick: 0,
      mode: loadStoredSlopePathMode(mode),
    },
    {
      type: 'setTerrainSurfaceMode',
      tick: 0,
      mode: options.terrainSurfaceMode ?? loadStoredTerrainSurfaceMode(mode),
    },
    {
      type: 'setLiquidSurfaceMode',
      tick: 0,
      mode: options.liquidSurfaceMode ?? loadStoredLiquidSurfaceMode(mode),
    },
    {
      type: 'setConverterTax',
      tick: 0,
      tax: loadStoredConverterTax(mode),
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
