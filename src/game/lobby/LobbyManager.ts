// LobbyManager — lobby/background battle lifecycle management
// Extracted from PhaserCanvas.vue to keep the component lean.

import { createGame, destroyGame } from '../createGame';
import { GameServer } from '../server/GameServer';
import { LocalGameConnection } from '../server/LocalGameConnection';
import { ClientViewState } from '../network/ClientViewState';
import { getMapSize } from '../../config';
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
  loadStoredDemoGrid,
  getDefaultDemoUnits,
} from '../../battleBarConfig';
import type { PlayerId } from '../sim/types';
import type { GameInstance } from '@/types/game';

export type BackgroundBattleState = {
  gameInstance: GameInstance;
  server: GameServer;
  connection: LocalGameConnection;
  /** Persistent ClientViewState — survives a scene rebuild so the new
   *  scene resumes from the current entity state without waiting for a
   *  keyframe. */
  clientViewState: ClientViewState;
};

/** Create and start a background battle server + game instance.
 *  Returns the state needed to control / tear down the background battle. */
export async function createBackgroundBattle(
  container: HTMLDivElement,
  ipAddress: string,
): Promise<BackgroundBattleState> {
  const rect = container.getBoundingClientRect();

  // Player IDs derived from DEMO_CONFIG.playerCount so a single source
  // of truth controls how many teams the demo battle has.
  const demoPlayerIds: PlayerId[] = [];
  for (let i = 1; i <= DEMO_CONFIG.playerCount; i++) demoPlayerIds.push(i as PlayerId);

  // Restore stored demo unit selection (fall back to config defaults).
  // We resolve this BEFORE creating the GameServer so the constructor's
  // initial-unit spawn picks only from the user's selected types — if
  // we passed it through setBackgroundUnitTypeEnabled() afterwards, the
  // toggle handler would wipe initial units of any disabled type and
  // the player would see far fewer than centerSpawnPerPlayer.
  const storedDemoUnits = loadStoredDemoUnits() ?? getDefaultDemoUnits();
  const initialAllowedTypes = new Set(
    BACKGROUND_UNIT_TYPES.filter(ut => storedDemoUnits.includes(ut)),
  );

  // Create a GameServer for background mode (WASM physics)
  const server = await GameServer.create({
    playerIds: demoPlayerIds,
    backgroundMode: true,
    initialAllowedTypes,
  });

  const connection = new LocalGameConnection(server);
  server.setTickRate(loadStoredTickRate());
  server.setSnapshotRate(loadStoredSnapshotRate());
  server.setKeyframeRatio(loadStoredKeyframeRatio());
  server.setIpAddress(ipAddress);

  // Tell the AI / UI layer about the same selection (the GameServer
  // already used it for the initial spawn). Calling
  // setBackgroundUnitTypeEnabled here is a no-op for already-enabled
  // types and harmlessly idempotent for disabled ones — no units to
  // wipe because the spawn path already skipped them.
  for (const ut of BACKGROUND_UNIT_TYPES) {
    server.setBackgroundUnitTypeEnabled(ut, storedDemoUnits.includes(ut));
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
    type: 'setSendGridInfo',
    tick: 0,
    enabled: loadStoredDemoGrid(),
  });

  server.start();

  // Background-battle CVS — owned by the returned gameInstance; destroyed
  // when the lobby tears it down.
  const clientViewState = new ClientViewState();
  const gameInstance = createGame({
    parent: container,
    width: rect.width || window.innerWidth,
    height: rect.height || window.innerHeight,
    playerIds: demoPlayerIds,
    localPlayerId: 1,
    gameConnection: connection,
    clientViewState,
    mapWidth: getMapSize(true).width,
    mapHeight: getMapSize(true).height,
    backgroundMode: true,
  });

  return { gameInstance, server, connection, clientViewState };
}

/** Tear down a background battle: stop the server and destroy the game instance. */
export function destroyBackgroundBattle(state: BackgroundBattleState): void {
  state.server.stop();
  destroyGame(state.gameInstance);
}
