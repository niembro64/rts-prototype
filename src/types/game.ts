// Top-level game types extracted from game/createGame.ts and server files

import type { PlayerId } from './sim';
import type { Command } from './commands';
import type { NetworkServerSnapshot } from './network';
import type { SimEvent } from './combat';
import type { SnapshotWirePayload } from '../game/network/SnapshotWirePayload';

export type { SnapshotWirePayload } from '../game/network/SnapshotWirePayload';

export type GameConfig = {
  parent: HTMLElement;
  width: number;
  height: number;
  playerIds?: PlayerId[];
  localPlayerId?: PlayerId;
  gameConnection: GameConnection;
  /** ClientViewState owned by GameCanvas so its contents (units, buildings,
   *  prediction, selection, etc.) survive a scene rebuild without waiting
   *  on a fresh snapshot. On first boot the caller creates a fresh one. */
  clientViewState: import('../game/network/ClientViewState').ClientViewState;
  mapWidth: number;
  mapHeight: number;
  /** Signed CENTER amplitude used for the central terrain heightmap and
   *  terrain-polarized metal-deposit dTerrain levels. Sign decides
   *  ripple polarity (negative dishes a valley, positive raises a
   *  mountain), magnitude decides height. */
  centerMagnitude?: number;
  /** Signed DIVIDERS amplitude used for team-separator ridges/trenches.
   *  Same sign convention as `centerMagnitude`. */
  dividersMagnitude?: number;
  /** Signed PERIMETER ring amplitude. 0 = flat square; negative sinks the
   *  outer ring below water (round-island); positive raises a rim. Same
   *  sign convention as `centerMagnitude`. */
  perimeterMagnitude?: number;
  backgroundMode?: boolean;
  /** Lobby-preview rendering: select the lobby camera defaults and
   *  skip the usual demo base spawn so the small pane in the GAME
   *  LOBBY shows commanders only (no units, no buildings). The
   *  caller is responsible for matching the GameServer config
   *  (empty `aiPlayerIds`, etc.) so the simulation matches what
   *  the renderer expects. Defaults to false. */
  lobbyPreview?: boolean;
  /** Resolves a player ID to its display name. Hooked up by the host
   *  app from the lobby roster (LobbyPlayer.name); render-side passes
   *  the result to NameLabel3D so commander owner labels track edits
   *  without having to plumb the entire roster through the scene.
   *  Returns null when the player isn't in the roster. */
  lookupPlayerName?: (playerId: PlayerId) => string | null;
  /** Emits true while the 3D renderer is warming shader programs for a
   *  newly-created scene, and false once the scene is ready to reveal. */
  onRendererWarmupChange?: (warming: boolean) => void;
  /** Fired after the server startup gate has opened and the first
   *  post-start snapshot has been applied. */
  onStartupReady?: () => void;
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

export type SnapshotRelease = () => void;
export type SnapshotCallback = (
  state: NetworkServerSnapshot,
  releaseSnapshot?: SnapshotRelease,
  wirePayload?: SnapshotWirePayload,
) => void;
export type SnapshotUnsubscribe = () => void;
export type SimEventCallback = (event: SimEvent) => void;
export type GameOverCallback = (winnerId: PlayerId) => void;

export type GameConnection = {
  /** True for in-memory connections where the client scene and
   *  local server share process-level simulation singletons. */
  readonly sharesAuthoritativeState?: boolean;
  sendCommand(command: Command): void;
  markClientReady(): void;
  onSnapshot(callback: SnapshotCallback): SnapshotUnsubscribe;
  clearSnapshotCallback(): void;
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
   *  to issue orders as that player (FOW-07). */
  setSpectatorTarget?(playerId: PlayerId | undefined): void;
};

export type GameServerConfig = {
  playerIds: PlayerId[];
  /** Signed CENTER amplitude selected by the host/lobby. */
  centerMagnitude?: number;
  /** Signed DIVIDERS amplitude selected by the host/lobby. */
  dividersMagnitude?: number;
  /** Signed PERIMETER ring amplitude selected by the host/lobby. 0 = flat
   *  square; negative = round-island; positive = rim. */
  perimeterMagnitude?: number;
  /** Plateau lattice step (world units). 0 = NONE (no terracing). */
  terrainDTerrain?: number;
  /** Metal-extractor pad altitude step (world units). */
  metalDepositStep?: number;
  /** Fine-triangle subdivisions per land cell. 0 = off; higher values
   *  refine the terrain mesh inside each cell. */
  terrainDetail?: number;
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
   *  blueprint ids. When omitted the server falls back to "all background
   *  unit blueprints allowed" — but a caller restoring user-saved demo settings
   *  should pass them here so the initial spawn doesn't create units
   *  the user has deselected (which would then be wiped a tick later
   *  by setBackgroundUnitBlueprintEnabled, leaving the player with far
   *  fewer initial units than the cap-derived per-team count). */
  initialAllowedUnitBlueprintIds?: ReadonlySet<string>;
  /** Restrict the demo battle's initial base-spawn to these building /
   *  tower blueprint ids (BUILDINGS / TOWERS bar groups). When omitted
   *  the server falls back to "all structures allowed". A caller
   *  restoring user-saved demo settings passes them so disabled
   *  structures are skipped at base spawn. */
  initialAllowedBuildingBlueprintIds?: ReadonlySet<string>;
  initialAllowedTowerBlueprintIds?: ReadonlySet<string>;
  /** Initial unit cap for the world, applied BEFORE the demo's
   *  initial-spawn pass so the spawn count tracks the user's stored
   *  cap (now that the demo fills `maxTotalUnits / numPlayers` slots
   *  per team). Without this the world boots at the BATTLE_CONFIG
   *  default (4096), the spawn fills to that, and only AFTER does
   *  `setMaxTotalUnits` arrive from the stored value — leaving a
   *  mismatch like "4075 units / 16 cap" on screen. */
  initialMaxTotalUnits?: number;
  /** Initial CONVERTER TAX value (fraction in [0, 1)). Lobby /
   *  battle-bar selections feed this so each new battle starts with
   *  the configured tax instead of the WorldState default 0.0. */
  converterTax?: number;
};

export type EmaConfig = {
  avg: number;
  low: { drop: number; recovery: number };
};
