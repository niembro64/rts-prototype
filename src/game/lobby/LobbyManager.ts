// LobbyManager — lobby/background battle lifecycle management.

import { createGame, destroyGame } from '../createGame';
import { GameServer } from '../server/GameServer';
import { LocalGameConnection } from '../server/LocalGameConnection';
import { ClientViewState } from '../network/ClientViewState';
import { getMapSize } from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';
import { BACKGROUND_UNIT_BLUEPRINT_IDS } from '../server/BackgroundBattleStandalone';
import { BUILDING_BLUEPRINT_IDS, TOWER_BLUEPRINT_IDS } from '../../types/blueprintIds';
import {
  loadStoredConverterTax,
  loadStoredDemoUnits,
  loadStoredDemoBuildings,
  loadStoredDemoTowers,
  loadStoredDemoCap,
  loadStoredTerrainMapShape,
  loadStoredMapLandDimensions,
  loadStoredTerrainRuntimeConfig,
  getDefaultDemoUnits,
  getDefaultDemoBuildings,
  getDefaultDemoTowers,
  type BattleMode,
} from '../../battleBarConfig';
import {
  setTerrainCenterMagnitude,
  setTerrainDividersMagnitude,
  setTerrainMapShape,
  setTerrainRuntimeConfig,
} from '../sim/Terrain';
import type { PlayerId } from '../sim/types';
import type { GameInstance } from '@/types/game';
import { applyStoredBattleServerSettings } from '../server/battleServerSettings';

export type BackgroundBattleState = {
  gameInstance: GameInstance;
  server: GameServer;
  connection: LocalGameConnection;
  /** Persistent ClientViewState — survives a scene rebuild so the new
   *  scene resumes from the current entity state without waiting for a
   *  fresh snapshot. */
  clientViewState: ClientViewState;
};

type BackgroundBattleLoadProgress = (
  progress: number,
  phase?: string,
) => void | Promise<void>;

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
  onLoadProgress?: BackgroundBattleLoadProgress,
  onStartupReady?: () => void,
): Promise<BackgroundBattleState> {
  const report = async (progress: number, phase?: string) => {
    if (!onLoadProgress) return;
    const clamped = Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : 0;
    await onLoadProgress(clamped, phase);
  };

  await report(0, 'Preparing battle');
  const rect = container.getBoundingClientRect();
  await report(0.03, 'Measuring viewport');

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
  let resolvedLocalPlayerId: PlayerId = demoPlayerIds[0];
  if (localPlayerId !== undefined) {
    for (let i = 0; i < demoPlayerIds.length; i++) {
      if (demoPlayerIds[i] !== localPlayerId) continue;
      resolvedLocalPlayerId = localPlayerId;
      break;
    }
  }

  // Apply the host's terrain-shape choice BEFORE constructing the
  // GameServer. The constructor calls spawnInitialBases (which samples
  // the heightmap to skip building placements over water) and the
  // renderer bakes its tile mesh once when the scene is created — both
  // must read the current shape, not the module's compile-time
  // default.
  const terrainMapShape = loadStoredTerrainMapShape(mode);
  const terrainRuntimeConfig = loadStoredTerrainRuntimeConfig(mode);
  const mapDimensions = loadStoredMapLandDimensions(mode);
  const mapSize = getMapSize(
    true,
    mapDimensions.widthLandCells,
    mapDimensions.lengthLandCells,
  );
  setTerrainRuntimeConfig(terrainRuntimeConfig);
  setTerrainCenterMagnitude(terrainRuntimeConfig.centerMagnitude);
  setTerrainDividersMagnitude(terrainRuntimeConfig.dividersMagnitude);
  setTerrainMapShape(terrainMapShape);
  await report(0.1, 'Loading terrain settings');

  // GAME LOBBY preview = a stripped-down background battle showing
  // only commanders. The full DEMO BATTLE keeps its initialized
  // buildings, units, and fabricator orders, but the local demo seat
  // is excluded from AI control so it behaves like the REAL BATTLE.
  const isLobbyPreview = mode === 'real';
  const aiPlayerIds: PlayerId[] = [];
  if (!isLobbyPreview) {
    for (let i = 0; i < demoPlayerIds.length; i++) {
      const playerId = demoPlayerIds[i];
      if (playerId !== resolvedLocalPlayerId) aiPlayerIds.push(playerId);
    }
  }

  // Restore stored demo unit selection (fall back to config defaults).
  // We resolve this BEFORE creating the GameServer so the constructor's
  // initial-unit spawn picks only from the user's selected types — if
  // we passed it through setBackgroundUnitBlueprintEnabled() afterwards, the
  // toggle handler would wipe initial units of any disabled type and
  // the player would see far fewer than the cap-derived per-team count.
  // Lobby preview short-circuits this: no AI = no production = the
  // selection is meaningless, so we just pass an empty allowed set.
  const savedDemoUnits = loadStoredDemoUnits();
  const storedDemoUnits = savedDemoUnits && savedDemoUnits.length > 0
    ? savedDemoUnits
    : getDefaultDemoUnits();
  const initialAllowedUnitBlueprintIds = new Set<string>();
  // Building / tower selections gate the demo base spawn (BUILDINGS /
  // TOWERS bar groups). Same resolve-from-localStorage-up-front rule as
  // units: the spawn reads them in the GameServer constructor. Empty
  // sets are honoured (user disabled everything) via the `?? defaults`
  // null-only fallback — matching the demo bar's local ref seed.
  const initialAllowedBuildingBlueprintIds = new Set<string>();
  const initialAllowedTowerBlueprintIds = new Set<string>();
  if (!isLobbyPreview) {
    const storedDemoUnitIds = new Set<string>(storedDemoUnits);
    for (let i = 0; i < BACKGROUND_UNIT_BLUEPRINT_IDS.length; i++) {
      const unitBlueprintId = BACKGROUND_UNIT_BLUEPRINT_IDS[i];
      if (storedDemoUnitIds.has(unitBlueprintId)) initialAllowedUnitBlueprintIds.add(unitBlueprintId);
    }
    const storedDemoBuildingIds = new Set<string>(loadStoredDemoBuildings() ?? getDefaultDemoBuildings());
    for (let i = 0; i < BUILDING_BLUEPRINT_IDS.length; i++) {
      const buildingBlueprintId = BUILDING_BLUEPRINT_IDS[i];
      if (storedDemoBuildingIds.has(buildingBlueprintId)) initialAllowedBuildingBlueprintIds.add(buildingBlueprintId);
    }
    const storedDemoTowerIds = new Set<string>(loadStoredDemoTowers() ?? getDefaultDemoTowers());
    for (let i = 0; i < TOWER_BLUEPRINT_IDS.length; i++) {
      const towerBlueprintId = TOWER_BLUEPRINT_IDS[i];
      if (storedDemoTowerIds.has(towerBlueprintId)) initialAllowedTowerBlueprintIds.add(towerBlueprintId);
    }
  }
  await report(0.14, 'Choosing unit roster');

  // Create a GameServer for background mode (WASM physics).
  //
  // Both `initialAllowedUnitBlueprintIds` AND `initialMaxTotalUnits` MUST be
  // resolved here from localStorage (with config defaults as fallback)
  // because the GameServer constructor's initial-unit spawn reads them
  // up-front. Anything that arrives via post-construction commands
  // would only take effect AFTER the spawn — meaning users would see
  // a battle sized by the bare config defaults until the next
  // reinforcement tick reconciles to their stored preference.
  const server = await GameServer.create(
    {
      playerIds: demoPlayerIds,
      centerMagnitude: terrainRuntimeConfig.centerMagnitude,
      dividersMagnitude: terrainRuntimeConfig.dividersMagnitude,
      terrainMapShape,
      terrainDTerrain: terrainRuntimeConfig.terrainDTerrain,
      metalDepositStep: terrainRuntimeConfig.metalDepositStep,
      terrainDetail: terrainRuntimeConfig.terrainDetail,
      mapWidthLandCells: mapDimensions.widthLandCells,
      mapLengthLandCells: mapDimensions.lengthLandCells,
      backgroundMode: true,
      initialAllowedUnitBlueprintIds,
      initialAllowedBuildingBlueprintIds,
      initialAllowedTowerBlueprintIds,
      initialMaxTotalUnits: loadStoredDemoCap(),
      converterTax: loadStoredConverterTax(mode),
      aiPlayerIds,
      spawnDemoInitialState: !isLobbyPreview,
    },
    {
      onProgress: (progress, phase) => report(0.14 + progress * 0.5, phase),
    },
  );
  await report(0.66, 'Server ready');

  const connection = new LocalGameConnection(server, resolvedLocalPlayerId, 'local-offline');
  applyStoredBattleServerSettings(server, mode, {
    ipAddress,
    maxTotalUnits: undefined,
    // Lobby preview (mode='real') must never show fog of war — the
    // real battle hardcodes fog on, so the preview deliberately runs
    // with fog off to differentiate the two. Demo battle keeps its
    // stored DEMO BATTLE bar toggle value.
    fogOfWarEnabled: isLobbyPreview ? false : undefined,
  });
  await report(0.7, 'Applying battle settings');

  // Tell the AI / UI layer about the same selection (the GameServer
  // already used it for the initial spawn). Skipped in lobby-preview
  // mode — there's no AI to talk to.
  if (!isLobbyPreview) {
    for (const ut of BACKGROUND_UNIT_BLUEPRINT_IDS) {
      server.setBackgroundUnitBlueprintEnabled(ut, storedDemoUnits.includes(ut));
    }
  }
  await report(0.74, 'Applying unit filters');

  // (Demo cap is now applied via `initialMaxTotalUnits` on
  // GameServer.create above — that path runs BEFORE the initial
  // spawn so the unit count matches the stored cap from the first
  // frame. The post-construction `setMaxTotalUnits` command path
  // still exists for runtime cap changes.)
  server.start();
  await report(0.78, 'Starting server tick');

  // Background-battle CVS — owned by the returned gameInstance; destroyed
  // when the lobby tears it down.
  const clientViewState = new ClientViewState();
  clientViewState.setMapDimensions(mapSize.width, mapSize.height);
  await report(0.82, 'Creating client state');
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
    centerMagnitude: terrainRuntimeConfig.centerMagnitude,
    dividersMagnitude: terrainRuntimeConfig.dividersMagnitude,
    terrainMapShape,
    backgroundMode: true,
    lobbyPreview: isLobbyPreview,
    onRendererWarmupChange,
    onStartupReady,
  });
  await report(1, 'Creating 3D scene');

  return { gameInstance, server, connection, clientViewState };
}

/** Tear down a background battle: stop the server and destroy the game
 *  instance. Each stage runs independently and logs its own failure —
 *  one throwing stage must neither skip the later stages nor hide which
 *  part of the teardown actually broke. */
export function destroyBackgroundBattle(state: BackgroundBattleState): void {
  try {
    destroyGame(state.gameInstance);
  } catch (err) {
    console.error('[Lobby] background battle game teardown failed:', err);
  }
  try {
    state.connection.disconnect();
  } catch (err) {
    console.error('[Lobby] background battle disconnect failed:', err);
  }
  try {
    state.clientViewState.clear();
  } catch (err) {
    console.error('[Lobby] background battle view-state clear failed:', err);
  }
  try {
    state.server.stop();
  } catch (err) {
    console.error('[Lobby] background battle server stop failed:', err);
  }
}
