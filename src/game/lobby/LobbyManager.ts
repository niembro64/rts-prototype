// LobbyManager — lobby/background battle lifecycle management
// Extracted from PhaserCanvas.vue to keep the component lean.

import { createGame, destroyGame } from '../createGame';
import { GameServer } from '../server/GameServer';
import { LocalGameConnection } from '../server/LocalGameConnection';
import { MAP_SETTINGS } from '../../config';
import { BACKGROUND_UNIT_TYPES } from '../server/BackgroundBattleStandalone';
import {
  loadStoredTickRate,
  loadStoredSnapshotRate,
  loadStoredKeyframeRatio,
} from '../../serverBarConfig';
import {
  loadStoredDemoUnits,
  loadStoredDemoCap,
  loadStoredProjVelInherit,
  loadStoredFfAccelUnits,
  loadStoredFfAccelShots,
  loadStoredFfDmgUnits,
  loadStoredDemoGrid,
  getDefaultDemoUnits,
} from '../../battleBarConfig';
import type { PlayerId } from '../sim/types';
import type { GameInstance } from '@/types/game';

export type BackgroundBattleState = {
  gameInstance: GameInstance;
  server: GameServer;
  connection: LocalGameConnection;
};

/** Create and start a background battle server + game instance.
 *  Returns the state needed to control / tear down the background battle. */
export async function createBackgroundBattle(
  container: HTMLDivElement,
  ipAddress: string,
): Promise<BackgroundBattleState> {
  const rect = container.getBoundingClientRect();

  // Create a GameServer for background mode (WASM physics)
  const server = await GameServer.create({
    playerIds: [1, 2, 3, 4] as PlayerId[],
    backgroundMode: true,
  });

  const connection = new LocalGameConnection(server);
  server.setTickRate(loadStoredTickRate());
  server.setSnapshotRate(loadStoredSnapshotRate());
  server.setKeyframeRatio(loadStoredKeyframeRatio());
  server.setIpAddress(ipAddress);

  // Restore stored demo unit selection (fall back to config defaults)
  const storedDemoUnits = loadStoredDemoUnits() ?? getDefaultDemoUnits();
  for (const ut of BACKGROUND_UNIT_TYPES) {
    server.setBackgroundUnitTypeEnabled(
      ut,
      storedDemoUnits.includes(ut),
    );
  }

  // Restore stored demo cap
  server.receiveCommand({
    type: 'setMaxTotalUnits',
    tick: 0,
    maxTotalUnits: loadStoredDemoCap(),
  });
  server.receiveCommand({
    type: 'setProjVelInherit',
    tick: 0,
    enabled: loadStoredProjVelInherit(),
  });
  server.receiveCommand({
    type: 'setFfAccelUnits',
    tick: 0,
    enabled: loadStoredFfAccelUnits(),
  });
  server.receiveCommand({
    type: 'setFfAccelShots',
    tick: 0,
    enabled: loadStoredFfAccelShots(),
  });
  server.receiveCommand({
    type: 'setFfDmgUnits',
    tick: 0,
    enabled: loadStoredFfDmgUnits(),
  });
  server.receiveCommand({
    type: 'setSendGridInfo',
    tick: 0,
    enabled: loadStoredDemoGrid(),
  });

  server.start();

  const gameInstance = createGame({
    parent: container,
    width: rect.width || window.innerWidth,
    height: rect.height || window.innerHeight,
    playerIds: [1, 2, 3, 4] as PlayerId[],
    localPlayerId: 1,
    gameConnection: connection,
    mapWidth: MAP_SETTINGS.game.width,
    mapHeight: MAP_SETTINGS.game.height,
    backgroundMode: true,
  });

  return { gameInstance, server, connection };
}

/** Tear down a background battle: stop the server and destroy the game instance. */
export function destroyBackgroundBattle(state: BackgroundBattleState): void {
  state.server.stop();
  destroyGame(state.gameInstance);
}
