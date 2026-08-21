// LobbyManager — lobby/background battle lifecycle management.

import { createGame, destroyGame } from '../createGame';
import {
  setLiquidSurfaceMode,
  setMetalCoverage,
} from '../sim/worldSurfaceState';
import {
  loadStoredLiquidSurfaceMode,
  loadStoredMetalCoverage,
} from '../../battleBarConfig';
import { GameServer } from '../server/GameServer';
import { LocalGameConnection } from '../server/LocalGameConnection';
import { ClientViewState } from '../network/ClientViewState';
import { getMapSize } from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';
import { BACKGROUND_UNIT_BLUEPRINT_IDS } from '../server/BackgroundBattleStandalone';
import { BUILDING_BLUEPRINT_IDS } from '../../types/blueprintIds';
import {
  loadStoredConverterTax,
  loadStoredPathfindingCellConsolidation,
  loadStoredSimulationTickRate,
  loadBattleUnitRoster,
  loadBattleBuildingRoster,
  getUnitCap,
  loadStoredMapLandDimensions,
  loadStoredTerrainRuntimeConfig,
  type BattleMode,
} from '../../battleBarConfig';
import {
  setTerrainCenterMagnitude,
  setTerrainRingMagnitude,
  setTerrainDividersMagnitude,
  setTerrainPerimeterMagnitude,
  setTerrainPrecedence,
  setTerrainRuntimeConfig,
} from '../sim/Terrain';
import type { PlayerId } from '../sim/types';
import type { GameInstance } from '@/types/game';
import { applyStoredBattleServerSettings } from '../server/battleServerSettings';
import { createHostGameGenerationSeed } from '../network/gameGenerationSeed';
import { createLoadProgressReporter } from '../lifecycle/loadProgressReporter';

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
  const report = createLoadProgressReporter(onLoadProgress);

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
  // Sides. The demo's shape is authored as SEATS PER SIDE (DEMO_CONFIG
  // .allyTeamSeats), which is what lets it declare a side with nobody on it
  // — that side still gets its terrain slice, deposits and spawn arc, and
  // the ground is simply left open.
  //
  // The per-side list only applies when the seat list is the demo's own. A
  // lobby preview passes real lobby seats, and pinning those to the demo's
  // per-side counts would seat live players on the wrong sides; it falls
  // back to the side COUNT, clamped to however many seats it actually has.
  const usingDemoSeats = !(playerIds && playerIds.length > 0);
  const demoAllyTeamSeats = usingDemoSeats ? DEMO_CONFIG.allyTeamSeats : undefined;
  const demoAllyTeamCount = Math.max(
    1,
    Math.min(demoPlayerIds.length, Math.floor(DEMO_CONFIG.allyTeamCount) || 1),
  );
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
  const terrainRuntimeConfig = loadStoredTerrainRuntimeConfig(mode);
  const mapDimensions = loadStoredMapLandDimensions(mode);
  const mapSize = getMapSize(
    true,
    mapDimensions.widthLandCells,
    mapDimensions.lengthLandCells,
  );
  setTerrainRuntimeConfig(terrainRuntimeConfig);
  setTerrainCenterMagnitude(terrainRuntimeConfig.centerMagnitude);
  setTerrainRingMagnitude(terrainRuntimeConfig.ringMagnitude);
  setTerrainDividersMagnitude(terrainRuntimeConfig.dividersMagnitude);
  setTerrainPerimeterMagnitude(terrainRuntimeConfig.perimeterMagnitude);
  setTerrainPrecedence(terrainRuntimeConfig.terrainPrecedence);
  // Seed the WORLD materials BEFORE the scene builds: deposit generation and
  // the 3D renderers both read these at construction (ore bodies, terrain
  // material, liquid colour),
  // so waiting for the setMetalCoverage / setLiquidSurfaceMode commands
  // on the first sim tick would build the scene with the wrong world.
  const metalCoverage = loadStoredMetalCoverage(mode);
  const liquidSurfaceMode = loadStoredLiquidSurfaceMode(mode);
  setMetalCoverage(metalCoverage);
  setLiquidSurfaceMode(liquidSurfaceMode);
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

  // Resolve the roster before constructing the server. Demo reads its
  // persistent sandbox choice; Lobby/Real reads session-only state and starts
  // every new lobby at the complete current registries.
  // We resolve this BEFORE creating the GameServer so the constructor's
  // initial-unit spawn picks only from the user's selected types — if
  // we passed it through setBackgroundUnitBlueprintEnabled() afterwards, the
  // toggle handler would wipe initial units of any disabled type and
  // the player would see far fewer than the cap-derived per-team count.
  const selectedUnits = loadBattleUnitRoster(mode);
  const selectedBuildings = loadBattleBuildingRoster(mode);
  const initialAllowedUnitBlueprintIds = new Set<string>();
  // Building selections gate the demo base spawn. Same
  // resolve-from-the-mode-store-up-front rule as
  // units: the spawn reads them in the GameServer constructor. Empty
  // sets are honoured (user disabled everything) via the `?? defaults`
  // null-only fallback — matching the demo bar's local ref seed.
  const initialAllowedBuildingBlueprintIds = new Set<string>();
  const selectedUnitIds = new Set<string>(selectedUnits);
  for (let i = 0; i < BACKGROUND_UNIT_BLUEPRINT_IDS.length; i++) {
    const unitBlueprintId = BACKGROUND_UNIT_BLUEPRINT_IDS[i];
    if (selectedUnitIds.has(unitBlueprintId)) initialAllowedUnitBlueprintIds.add(unitBlueprintId);
  }
  const selectedBuildingIds = new Set<string>(selectedBuildings);
  for (let i = 0; i < BUILDING_BLUEPRINT_IDS.length; i++) {
    const buildingBlueprintId = BUILDING_BLUEPRINT_IDS[i];
    if (selectedBuildingIds.has(buildingBlueprintId)) {
      initialAllowedBuildingBlueprintIds.add(buildingBlueprintId);
    }
  }
  await report(0.14, 'Choosing unit roster');

  // Create a GameServer for background mode (WASM physics).
  //
  // Both `initialAllowedUnitBlueprintIds` AND `initialEntityCountCap` MUST be
  // resolved here because the GameServer constructor's initial-unit spawn
  // reads them up-front. Demo resolves its cap from the saved browser
  // preference; Lobby/Real resolves the current session-only cap. Anything
  // that arrives via post-construction commands would only take effect AFTER
  // the spawn and visibly disagree with the displayed cap.
  const server = await GameServer.create(
    {
      playerIds: demoPlayerIds,
      allyTeamCount: demoAllyTeamCount,
      allyTeamSeats: demoAllyTeamSeats,
      gameGenerationSeed: createHostGameGenerationSeed(),
      centerMagnitude: terrainRuntimeConfig.centerMagnitude,
      ringMagnitude: terrainRuntimeConfig.ringMagnitude,
      dividersMagnitude: terrainRuntimeConfig.dividersMagnitude,
      perimeterMagnitude: terrainRuntimeConfig.perimeterMagnitude,
      terrainPrecedence: terrainRuntimeConfig.terrainPrecedence,
      terrainDTerrain: terrainRuntimeConfig.terrainDTerrain,
      plateauWallSlopeDegrees: terrainRuntimeConfig.plateauWallSlopeDegrees,
      metalDepositStep: terrainRuntimeConfig.metalDepositStep,
      terrainDetail: terrainRuntimeConfig.terrainDetail,
      mapWidthLandCells: mapDimensions.widthLandCells,
      mapLengthLandCells: mapDimensions.lengthLandCells,
      metalCoverage,
      liquidSurfaceMode,
      backgroundMode: true,
      initialAllowedUnitBlueprintIds,
      initialAllowedBuildingBlueprintIds,
      initialEntityCountCap: getUnitCap(mode),
      converterTax: loadStoredConverterTax(mode),
      pathfindingCellConsolidationMultiplier:
        loadStoredPathfindingCellConsolidation(mode),
      simulationTickRateHz: loadStoredSimulationTickRate(mode),
      aiPlayerIds,
      // The two seat axes, spelled out (src/game/sim/agentSeat.ts): the DEMO
      // gives EVERY seat the 'base' initial state — the local human seat
      // included, which is exactly the mix-and-match the axes exist for —
      // while the lobby preview stays commander-only.
      baseSeatPlayerIds: isLobbyPreview ? [] : [...demoPlayerIds],
    },
    {
      onProgress: (progress, phase) => report(0.14 + progress * 0.5, phase),
    },
  );
  await report(0.66, 'Server ready');

  const connection = new LocalGameConnection(server, resolvedLocalPlayerId, 'local-offline');
  applyStoredBattleServerSettings(server, mode, {
    ipAddress,
    entityCountCap: undefined,
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
      server.setBackgroundUnitBlueprintEnabled(ut, selectedUnitIds.has(ut));
    }
  }
  await report(0.74, 'Applying unit filters');

  // (Demo cap is now applied via `initialEntityCountCap` on
  // GameServer.create above — that path runs BEFORE the initial
  // spawn so the unit count matches the mode's cap from the first
  // frame. The post-construction `setEntityCountCap` command path
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
    allyTeamCount: demoAllyTeamCount,
    allyTeamSeats: demoAllyTeamSeats,
    localPlayerId: resolvedLocalPlayerId,
    gameConnection: connection,
    clientViewState,
    mapWidth: mapSize.width,
    mapHeight: mapSize.height,
    centerMagnitude: terrainRuntimeConfig.centerMagnitude,
    ringMagnitude: terrainRuntimeConfig.ringMagnitude,
    dividersMagnitude: terrainRuntimeConfig.dividersMagnitude,
    perimeterMagnitude: terrainRuntimeConfig.perimeterMagnitude,
    terrainPrecedence: terrainRuntimeConfig.terrainPrecedence,
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
