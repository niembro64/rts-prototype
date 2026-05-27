import type { BattleMode } from '../../battleBarConfig';
import {
  loadStoredConverterTax,
  loadStoredForceFieldReflectionMode,
  loadStoredForceFieldsObstructSight,
  loadStoredForceFieldsEnabled,
  loadStoredFogOfWarEnabled,
  loadStoredGrid,
  loadStoredMirrorsEnabled,
} from '../../battleBarConfig';
import {
  loadStoredKeyframeRatio,
  loadStoredSnapshotRate,
  loadStoredTickRate,
  loadStoredUnitGroundNormalEmaMode,
} from '../../serverBarConfig';
import type { GameServer } from './GameServer';
import type { CommandAuthority } from './commandAuthority';

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

export function applyStoredBattleServerSettings(
  server: GameServer,
  mode: BattleMode,
  options: StoredBattleServerSettingsOptions = DEFAULT_STORED_BATTLE_SERVER_SETTINGS_OPTIONS,
): void {
  const authority: CommandAuthority = { mode: 'host-admin' };
  server.setTickRate(loadStoredTickRate(mode));
  server.setSnapshotRate(loadStoredSnapshotRate(mode));
  server.setKeyframeRatio(loadStoredKeyframeRatio(mode));
  server.receiveCommand({
    type: 'setUnitGroundNormalEmaMode',
    tick: 0,
    mode: loadStoredUnitGroundNormalEmaMode(mode),
  }, authority);

  if (options.ipAddress !== undefined) {
    server.setIpAddress(options.ipAddress);
  }
  if (options.maxTotalUnits !== undefined) {
    server.receiveCommand({
      type: 'setMaxTotalUnits',
      tick: 0,
      maxTotalUnits: options.maxTotalUnits,
    }, authority);
  }

  server.receiveCommand({
    type: 'setMirrorsEnabled',
    tick: 0,
    enabled: loadStoredMirrorsEnabled(mode),
  }, authority);
  server.receiveCommand({
    type: 'setForceFieldsEnabled',
    tick: 0,
    enabled: loadStoredForceFieldsEnabled(mode),
  }, authority);
  server.receiveCommand({
    type: 'setForceFieldsObstructSight',
    tick: 0,
    enabled: loadStoredForceFieldsObstructSight(mode),
  }, authority);
  server.receiveCommand({
    type: 'setForceFieldReflectionMode',
    tick: 0,
    mode: loadStoredForceFieldReflectionMode(mode),
  }, authority);
  server.receiveCommand({
    type: 'setFogOfWarEnabled',
    tick: 0,
    enabled: options.fogOfWarEnabled ?? loadStoredFogOfWarEnabled(mode),
  }, authority);
  server.receiveCommand({
    type: 'setConverterTax',
    tick: 0,
    tax: loadStoredConverterTax(mode),
  }, authority);
  server.receiveCommand({
    type: 'setSendGridInfo',
    tick: 0,
    enabled: loadStoredGrid(mode),
  }, authority);
}
