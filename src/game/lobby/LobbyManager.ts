// LobbyManager — lobby/background battle lifecycle management
// Extracted from PhaserCanvas.vue to keep the component lean.

import { createGame, destroyGame } from '../createGame';
import type { RendererMode } from '../../types/game';
import { GameServer } from '../server/GameServer';
import { LocalGameConnection } from '../server/LocalGameConnection';
import { ClientViewState } from '../network/ClientViewState';
import { MAP_SETTINGS } from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';
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
  /** Persistent ClientViewState — survives a live renderer swap of the
   *  background demo so the new scene resumes from the current entity
   *  state without waiting for a keyframe. */
  clientViewState: ClientViewState;
};

/** Create and start a background battle server + game instance.
 *  Returns the state needed to control / tear down the background battle. */
export async function createBackgroundBattle(
  container: HTMLDivElement,
  ipAddress: string,
  rendererMode: RendererMode = '2d',
): Promise<BackgroundBattleState> {
  const rect = container.getBoundingClientRect();

  // Player IDs derived from DEMO_CONFIG.playerCount so a single source
  // of truth controls how many teams the demo battle has.
  const demoPlayerIds: PlayerId[] = [];
  for (let i = 1; i <= DEMO_CONFIG.playerCount; i++) demoPlayerIds.push(i as PlayerId);

  // Create a GameServer for background mode (WASM physics)
  const server = await GameServer.create({
    playerIds: demoPlayerIds,
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

  // Background-battle CVS — owned by the returned gameInstance; destroyed
  // when the lobby tears it down. Background demos don't support the live
  // renderer swap, so no hoist beyond this function is needed.
  const clientViewState = new ClientViewState();
  const gameInstance = createGame({
    parent: container,
    width: rect.width || window.innerWidth,
    height: rect.height || window.innerHeight,
    playerIds: demoPlayerIds,
    localPlayerId: 1,
    gameConnection: connection,
    clientViewState,
    mapWidth: MAP_SETTINGS.game.width,
    mapHeight: MAP_SETTINGS.game.height,
    backgroundMode: true,
    rendererMode,
  });

  return { gameInstance, server, connection, clientViewState };
}

/** Tear down a background battle: stop the server and destroy the game instance. */
export function destroyBackgroundBattle(state: BackgroundBattleState): void {
  state.server.stop();
  destroyGame(state.gameInstance);
}
