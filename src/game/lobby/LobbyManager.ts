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
  loadStoredDemoUnits,
  loadStoredDemoCap,
  loadStoredTerrainCenter,
  loadStoredTerrainDividers,
  loadStoredTerrainMapShape,
  loadStoredMapLandDimensions,
  getDefaultDemoUnits,
  type BattleMode,
} from '../../battleBarConfig';
import { setTerrainCenterShape, setTerrainDividersShape, setTerrainMapShape } from '../sim/Terrain';
import type { PlayerId } from '../sim/types';
import type { GameInstance } from '@/types/game';
import { applyStoredBattleServerSettings } from '../server/battleServerSettings';

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
 *  Returns the state needed to control / tear down the background
 *  battle.
 *
 *  `mode` selects which storage namespace to read settings from:
 *  - `demo` for the visual demo behind the BUDGET ANNIHILATION
 *    screen (initial page load).
 *  - `real` for the GAME LOBBY's preview pane — runs the same demo
 *    code path but reads `real-battle-*` keys so it shows what the
 *    upcoming real battle will look like with the host's lobby
 *    choices, not the user's solo-demo preferences.
 *
 *  `playerIds` optionally overrides the demo's [1..DEMO_CONFIG.playerCount]
 *  seat numbering. The GAME LOBBY preview passes the actual lobby
 *  seat IDs so commanders spawn at the seats players will occupy
 *  in the real battle (not a generic 1..N filler), and so
 *  `localPlayerId` lines up with whichever spawned commander is
 *  the local player's. `localPlayerId` defaults to the first ID
 *  in the array — correct for the solo demo, where the player is
 *  always seat 1. */
export async function createBackgroundBattle(
  container: HTMLDivElement,
  ipAddress: string,
  mode: BattleMode = 'demo',
  playerIds?: PlayerId[],
  localPlayerId?: PlayerId,
  onRendererWarmupChange?: (warming: boolean) => void,
): Promise<BackgroundBattleState> {
  const rect = container.getBoundingClientRect();

  // Player IDs come from the caller (lobby) or fall back to the
  // demo's [1..DEMO_CONFIG.playerCount]. Either way a single source
  // of truth per call controls how many teams spawn AND at which
  // seats — preserving the lobby's actual seat assignments so the
  // local commander corresponds to the player's lobby slot.
  let demoPlayerIds: PlayerId[];
  if (playerIds && playerIds.length > 0) {
    demoPlayerIds = playerIds.slice();
  } else {
    const fallbackCount = Math.max(1, Math.floor(DEMO_CONFIG.playerCount));
    demoPlayerIds = [];
    for (let i = 1; i <= fallbackCount; i++) demoPlayerIds.push(i as PlayerId);
  }
  const resolvedLocalPlayerId: PlayerId =
    localPlayerId !== undefined && demoPlayerIds.includes(localPlayerId)
      ? localPlayerId
      : demoPlayerIds[0];

  // Apply the host's terrain-shape choice BEFORE constructing the
  // GameServer. The constructor calls spawnInitialBases (which samples
  // the heightmap to skip building placements over water) and the
  // renderer bakes its tile mesh once when the scene is created — both
  // must read the current shape, not the module's compile-time
  // default.
  const terrainCenter = loadStoredTerrainCenter(mode);
  const terrainDividers = loadStoredTerrainDividers(mode);
  const terrainMapShape = loadStoredTerrainMapShape(mode);
  const mapDimensions = loadStoredMapLandDimensions(mode);
  const mapSize = getMapSize(
    true,
    mapDimensions.widthLandCells,
    mapDimensions.lengthLandCells,
  );
  setTerrainCenterShape(terrainCenter);
  setTerrainDividersShape(terrainDividers);
  setTerrainMapShape(terrainMapShape);

  // GAME LOBBY preview = a stripped-down background battle showing
  // only commanders. The full DEMO BATTLE keeps its initialized
  // buildings, units, and fabricator orders, but the local demo seat
  // is excluded from AI control so it behaves like the REAL BATTLE.
  const isLobbyPreview = mode === 'real';
  const aiPlayerIds: PlayerId[] = isLobbyPreview
    ? []
    : demoPlayerIds.filter((playerId) => playerId !== resolvedLocalPlayerId);

  // Restore stored demo unit selection (fall back to config defaults).
  // We resolve this BEFORE creating the GameServer so the constructor's
  // initial-unit spawn picks only from the user's selected types — if
  // we passed it through setBackgroundUnitTypeEnabled() afterwards, the
  // toggle handler would wipe initial units of any disabled type and
  // the player would see far fewer than the cap-derived per-team count.
  // Lobby preview short-circuits this: no AI = no production = the
  // selection is meaningless, so we just pass an empty allowed set.
  const storedDemoUnits = loadStoredDemoUnits() ?? getDefaultDemoUnits();
  const initialAllowedTypes = isLobbyPreview
    ? new Set<string>()
    : new Set(BACKGROUND_UNIT_TYPES.filter(ut => storedDemoUnits.includes(ut)));

  // Create a GameServer for background mode (WASM physics).
  //
  // Both `initialAllowedTypes` AND `initialMaxTotalUnits` MUST be
  // resolved here from localStorage (with config defaults as fallback)
  // because the GameServer constructor's initial-unit spawn reads them
  // up-front. Anything that arrives via post-construction commands
  // would only take effect AFTER the spawn — meaning users would see
  // a battle sized by the bare config defaults until the next
  // reinforcement tick reconciles to their stored preference.
  const server = await GameServer.create({
    playerIds: demoPlayerIds,
    terrainCenter,
    terrainDividers,
    terrainMapShape,
    mapWidthLandCells: mapDimensions.widthLandCells,
    mapLengthLandCells: mapDimensions.lengthLandCells,
    backgroundMode: true,
    initialAllowedTypes,
    initialMaxTotalUnits: loadStoredDemoCap(),
    aiPlayerIds,
    spawnDemoInitialState: !isLobbyPreview,
  });

  const connection = new LocalGameConnection(server, resolvedLocalPlayerId);
  applyStoredBattleServerSettings(server, mode, { ipAddress });

  // Tell the AI / UI layer about the same selection (the GameServer
  // already used it for the initial spawn). Skipped in lobby-preview
  // mode — there's no AI to talk to.
  if (!isLobbyPreview) {
    for (const ut of BACKGROUND_UNIT_TYPES) {
      server.setBackgroundUnitTypeEnabled(ut, storedDemoUnits.includes(ut));
    }
  }

  // (Demo cap is now applied via `initialMaxTotalUnits` on
  // GameServer.create above — that path runs BEFORE the initial
  // spawn so the unit count matches the stored cap from the first
  // frame. The post-construction `setMaxTotalUnits` command path
  // still exists for runtime cap changes.)
  server.start();

  // Background-battle CVS — owned by the returned gameInstance; destroyed
  // when the lobby tears it down.
  const clientViewState = new ClientViewState();
  clientViewState.setMapDimensions(mapSize.width, mapSize.height);
  const gameInstance = createGame({
    parent: container,
    width: rect.width || window.innerWidth,
    height: rect.height || window.innerHeight,
    playerIds: demoPlayerIds,
    localPlayerId: resolvedLocalPlayerId,
    gameConnection: connection,
    clientViewState,
    mapWidth: mapSize.width,
    mapHeight: mapSize.height,
    terrainCenter,
    terrainDividers,
    terrainMapShape,
    backgroundMode: true,
    lobbyPreview: isLobbyPreview,
    onRendererWarmupChange,
  });

  return { gameInstance, server, connection, clientViewState };
}

/** Tear down a background battle: stop the server and destroy the game instance. */
export function destroyBackgroundBattle(state: BackgroundBattleState): void {
  state.server.stop();
  destroyGame(state.gameInstance);
}
