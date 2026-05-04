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
   *  user makes in the TopBar without having to plumb the entire
   *  roster through the scene. Returns null when the player isn't in
   *  the roster (renderer falls back to a deterministic funny default). */
  lookupPlayerName?: (playerId: PlayerId) => string | null;
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
  sendCommand(command: Command): void;
  onSnapshot(callback: SnapshotCallback): void;
  onSimEvent(callback: SimEventCallback): void;
  onGameOver(callback: GameOverCallback): void;
  disconnect(): void;
};

export type GameServerConfig = {
  playerIds: PlayerId[];
  /** CENTER terrain shape selected by the host/lobby. */
  terrainCenter?: TerrainShape;
  /** DIVIDERS terrain shape selected by the host/lobby. */
  terrainDividers?: TerrainShape;
  terrainMapShape?: TerrainMapShape;
  backgroundMode?: boolean;
  aiPlayerIds?: PlayerId[];
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
