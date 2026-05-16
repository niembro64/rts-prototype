// Top-level game types extracted from game/createGame.ts and server files

import type { PlayerId } from './sim';
import type { Command } from './commands';
import type { NetworkServerSnapshot } from './network';
import type { SimEvent } from './combat';
import type { TerrainMapShape, TerrainShape } from './terrain';

export type GameConfig = {
  parent: HTMLElement;
  width: number;
  height: number;
  playerIds?: PlayerId[];
  localPlayerId?: PlayerId;
  gameConnection: GameConnection;
  /** ClientViewState owned by GameCanvas so its contents (units, buildings,
   *  prediction, selection, etc.) survive a scene rebuild without waiting
   *  on a keyframe. On first boot the caller creates a fresh one. */
  clientViewState: import('../game/network/ClientViewState').ClientViewState;
  mapWidth: number;
  mapHeight: number;
  /** CENTER terrain shape used for the central terrain heightmap and
   *  terrain-polarized metal-deposit dTerrain levels. */
  terrainCenter?: TerrainShape;
  /** DIVIDERS terrain shape used for team-separator ridges/trenches. */
  terrainDividers?: TerrainShape;
  terrainMapShape?: TerrainMapShape;
  backgroundMode?: boolean;
  /** Lobby-preview rendering: skip the usual demo zoom + base spawn
   *  so the small pane in the GAME LOBBY shows commanders only
   *  (no units, no buildings) at a hardcoded wide zoom. The
   *  caller is responsible for matching the GameServer config
   *  (empty `aiPlayerIds`, etc.) so the simulation matches what
   *  the renderer expects. Defaults to false. */
  lobbyPreview?: boolean;
  /** Resolves a player ID to its display name. Hooked up by the host
   *  app from the lobby roster (LobbyPlayer.name); render-side passes
   *  the result to NameLabel3D so commander labels track edits the
   *  user makes in the lobby without having to plumb the entire
   *  roster through the scene. Returns null when the player isn't in
   *  the roster (renderer falls back to a deterministic funny default). */
  lookupPlayerName?: (playerId: PlayerId) => string | null;
  /** Emits true while the 3D renderer is warming shader programs for a
   *  newly-created scene, and false once the scene is ready to reveal. */
  onRendererWarmupChange?: (warming: boolean) => void;
};

export type GameScene = import('../game/scenes/RtsScene3D').RtsScene3D;

export type GameApp = import('../game/render3d/ThreeApp').ThreeApp;

export type GameInstance = {
  app: GameApp;
  getScene: () => GameScene | null;
};

/** Portable camera state. Sim-space center + scalar zoom; the 3D scene's
 *  cameraShim translates this into orbit distance / target. */
export type SceneCameraState = {
  x: number;
  y: number;
  zoom: number;
  targetZ?: number;
  yaw?: number;
  pitch?: number;
};

export type SnapshotCallback = (state: NetworkServerSnapshot) => void;
export type SimEventCallback = (event: SimEvent) => void;
export type GameOverCallback = (winnerId: PlayerId) => void;

export type GameConnection = {
  /** True for in-memory connections where the client scene and
   *  authoritative server share process-level simulation singletons. */
  readonly sharesAuthoritativeState?: boolean;
  sendCommand(command: Command): void;
  markClientReady(): void;
  onSnapshot(callback: SnapshotCallback): void;
  onSimEvent(callback: SimEventCallback): void;
  onGameOver(callback: GameOverCallback): void;
  disconnect(): void;
  /** Re-bind which player the server should filter snapshots for AND
   *  re-attribute commands to that player. Used by demo /
   *  lobby-preview / offline single-player flows where the user
   *  toggles the active scene-local seat — they expect both their
   *  view and their command authority to follow the toggle. For pure
   *  spectating (snapshot follow without command authority) call
   *  setSpectatorTarget instead.
   *
   *  Optional: remote connections don't implement it (the recipient
   *  is fixed at the network layer). */
  setRecipientPlayerId?(playerId: PlayerId | undefined): void;
  /** Re-aim ONLY the snapshot filter at a new player; command
   *  attribution stays at whatever the connection was constructed
   *  with. A spectator client constructed with playerId=undefined
   *  uses this to follow a specific player's POV without being able
   *  to issue orders as that player (issues.txt FOW-07). */
  setSpectatorTarget?(playerId: PlayerId | undefined): void;
};

export type GameServerConfig = {
  playerIds: PlayerId[];
  /** CENTER terrain shape selected by the host/lobby. */
  terrainCenter?: TerrainShape;
  /** DIVIDERS terrain shape selected by the host/lobby. */
  terrainDividers?: TerrainShape;
  terrainMapShape?: TerrainMapShape;
  /** Map width in canonical LAND_CELL_SIZE cells. */
  mapWidthLandCells?: number;
  /** Map length/height in canonical LAND_CELL_SIZE cells. */
  mapLengthLandCells?: number;
  backgroundMode?: boolean;
  aiPlayerIds?: PlayerId[];
  /** Background/demo battles can still use the rich prebuilt RTS
   *  opening state even when no players are AI-controlled. Lobby
   *  previews pass false so they stay commander-only. */
  spawnDemoInitialState?: boolean;
  maxSnapshotsPerSec?: number;
  /** Restrict the demo battle's initial-unit spawn to this set of unit
   *  types. When omitted the server falls back to "all background unit
   *  types allowed" — but a caller restoring user-saved demo settings
   *  should pass them here so the initial spawn doesn't create units
   *  the user has deselected (which would then be wiped a tick later
   *  by setBackgroundUnitTypeEnabled, leaving the player with far
   *  fewer initial units than the cap-derived per-team count). */
  initialAllowedTypes?: ReadonlySet<string>;
  /** Initial unit cap for the world, applied BEFORE the demo's
   *  initial-spawn pass so the spawn count tracks the user's stored
   *  cap (now that the demo fills `maxTotalUnits / numPlayers` slots
   *  per team). Without this the world boots at the BATTLE_CONFIG
   *  default (4096), the spawn fills to that, and only AFTER does
   *  `setMaxTotalUnits` arrive from the stored value — leaving a
   *  mismatch like "4075 units / 16 cap" on screen. */
  initialMaxTotalUnits?: number;
};

export type EmaConfig = {
  avg: number;
  low: { drop: number; recovery: number };
};
