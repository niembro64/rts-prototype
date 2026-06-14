import type { BattleMode } from '../../battleBarConfig';
import {
  loadStoredConverterTax,
  loadStoredShieldReflectionMode,
  loadStoredShieldsObstructSight,
  loadStoredTurretShieldSpheresEnabled,
  loadStoredFogOfWarEnabled,
  loadStoredGrid,
  loadStoredTurretShieldPanelsEnabled,
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
  applyAuthoritativeTiming?: boolean;
  /** When set, overrides the stored fog-of-war value. Lobby preview
   *  passes `false` and real-battle startup passes `true`; the demo
   *  battle leaves it undefined so the DEMO BATTLE bar toggle still
   *  drives the value via stored 'demo' preferences. */
  fogOfWarEnabled?: boolean;
};

const DEFAULT_STORED_BATTLE_SERVER_SETTINGS_OPTIONS: StoredBattleServerSettingsOptions = {
  ipAddress: undefined,
  maxTotalUnits: undefined,
  applyAuthoritativeTiming: true,
};

export function applyStoredBattleServerSettings(
  server: GameServer,
  mode: BattleMode,
  options: StoredBattleServerSettingsOptions = DEFAULT_STORED_BATTLE_SERVER_SETTINGS_OPTIONS,
): void {
  const authority: CommandAuthority = { mode: 'host-admin' };
  if (options.applyAuthoritativeTiming !== false) {
    server.setTickRate(loadStoredTickRate(mode));
    server.setSnapshotRate(loadStoredSnapshotRate(mode));
    server.setKeyframeRatio(loadStoredKeyframeRatio(mode));
  }
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
    type: 'setTurretShieldPanelsEnabled',
    tick: 0,
    enabled: loadStoredTurretShieldPanelsEnabled(mode),
  }, authority);
  server.receiveCommand({
    type: 'setTurretShieldSpheresEnabled',
    tick: 0,
    enabled: loadStoredTurretShieldSpheresEnabled(mode),
  }, authority);
  server.receiveCommand({
    type: 'setShieldsObstructSight',
    tick: 0,
    enabled: loadStoredShieldsObstructSight(mode),
  }, authority);
  server.receiveCommand({
    type: 'setShieldReflectionMode',
    tick: 0,
    mode: loadStoredShieldReflectionMode(mode),
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
