// Top-level game types extracted from game/createGame.ts and server files

import type { EntityId, PlayerId } from './sim';
import type { Command } from './commands';
import type { TerrainPrecedence } from './terrainPrecedence';
import type { NetworkServerSnapshot } from './network';
import type { SimEvent } from './combat';
import type { SnapshotWirePayload } from '../game/network/SnapshotWirePayload';
import type {
  LiquidSurfaceMode,
  MetalCoverage,
} from './worldSurfaceMode';

export type { SnapshotWirePayload } from '../game/network/SnapshotWirePayload';

export type GameConfig = {
  parent: HTMLElement;
  width: number;
  height: number;
  playerIds?: PlayerId[];
  /** Sides the seats are split into; see GameServerConfig.allyTeamCount.
   *  The client rebuilds the same roster from this so its terrain
   *  dividers and camera pre-framing match the host’s layout exactly. */
  allyTeamCount?: number;
  /** Seats per side, one entry per ally team; see
   *  GameServerConfig.allyTeamSeats. Takes precedence over
   *  `allyTeamCount` and is the only form that can declare an empty side. */
  allyTeamSeats?: readonly number[];
  /** Explicit per-seat side assignment from the lobby, when players have
   *  moved themselves between teams. Takes precedence over
   *  `allyTeamCount`. Seats missing here fall back to their own side. */
  allyTeamByPlayerId?: Readonly<Record<number, number>>;
  localPlayerId?: PlayerId;
  /** 'spectator' boots the scene watching the whole battle (fog shade off,
   *  ALL view) instead of posing as the first seat. Omitted = 'player'. */
  localRole?: 'player' | 'spectator';
  gameConnection: GameConnection;
  /** ClientViewState owned by GameCanvas so its contents (units, buildings,
   *  prediction, selection, etc.) survive a scene rebuild without waiting
   *  on a fresh snapshot. On first boot the caller creates a fresh one. */
  clientViewState: import('../game/network/ClientViewState').ClientViewState;
  mapWidth: number;
  mapHeight: number;
  /** Signed CENTER amplitude used for the central terrain heightmap and
   *  terrain-polarized metal-deposit dTerrain levels. Sign decides
   *  dome/dish polarity (negative dishes a valley, positive raises a
   *  mountain), magnitude decides the centre height. */
  centerMagnitude?: number;
  /** Signed RING annulus crest amplitude (RING bar). Same sign
   *  convention as `centerMagnitude`. */
  ringMagnitude?: number;
  /** Signed DIVIDERS amplitude used for team-separator ridges/trenches.
   *  Same sign convention as `centerMagnitude`. */
  dividersMagnitude?: number;
  /** Signed PERIMETER ring amplitude. Negative sinks the outer ring below
   *  water (round-island), positive raises a rim, 0 flattens it to ground
   *  level. Same sign convention as `centerMagnitude`. */
  perimeterMagnitude?: number;
  /** Which of DIVIDERS/PERIMETER applies last in terrain generation
   *  (PRECEDENCE bar) — last wins where they overlap. */
  terrainPrecedence?: TerrainPrecedence;
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
export type PresentationFrameEvent = {
  /** Authoritative fixed-tick number now held as the current endpoint. */
  tick: number;
  /** Main-thread wall-clock time at which the endpoint became available. */
  capturedAtMs: number;
  /** Fixed cadence that produced the adjacent authoritative endpoints. */
  simulationTickRateHz: number;
};
export type PresentationFrameCallback = (event: PresentationFrameEvent) => void;
export type PresentationFrameUnsubscribe = () => void;

export type SurfaceLiftProbeDebugSample = {
  x: number;
  y: number;
  bodyZ: number;
  isCenter: boolean;
  /** Exact clamped distance used by any inverse ground/solid contribution. */
  groundInverseDistanceWorld: number;
  usesGroundInverseDistance: boolean;
  /** Exact clamped distance used by air's inverse lift over exposed water. */
  waterSurfaceInverseDistanceWorld: number | null;
  usesWaterSurfaceInverseDistance: boolean;
  /** Exact non-negative depth used by water's proportional surface support. */
  waterSurfaceDepthWorld: number | null;
  usesWaterSurfaceDepth: boolean;
};

export type SurfaceLiftProbeDebugFrame = {
  tick: number;
  entityId: EntityId;
  samples: SurfaceLiftProbeDebugSample[];
};

export type GameConnection = {
  /** True for in-memory connections where the client scene and
   *  local server share process-level simulation singletons. */
  readonly sharesAuthoritativeState?: boolean;
  sendCommand(command: Command): void;
  markClientReady(): void;
  onSnapshot(callback: SnapshotCallback): SnapshotUnsubscribe;
  /** Same-process deterministic lockstep only. The motion data itself stays
   *  in Rust/WASM; this event advances the renderer's one shared alpha clock. */
  onPresentationFrame?(callback: PresentationFrameCallback): PresentationFrameUnsubscribe;
  /** Same-process authoritative lift-probe diagnostics. The renderer supplies
   *  only selected IDs so ordinary ticks do not allocate debug samples. */
  setSurfaceLiftProbeDebugEntityIds?(entityIds: readonly EntityId[]): void;
  getSurfaceLiftProbeDebugFrame?(entityId: EntityId): SurfaceLiftProbeDebugFrame | undefined;
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
  /** Number of ALLY TEAMS (sides) the seats are split into, in contiguous
   *  lobby order. Omitted means free-for-all: one side per seat. Terrain
   *  dividers carve one slice per side, and a side’s seats share that
   *  slice. See src/game/sim/teamRoster.ts. */
  allyTeamCount?: number;
  /** Seats per side, one entry per ally team, filled in lobby order —
   *  `[2, 2, 2]` is a 2v2v2. Takes precedence over `allyTeamCount`, and is
   *  the only form that can declare an EMPTY side: a zero still carves that
   *  side’s terrain slice, deposits and spawn arc, and leaves it unoccupied.
   *  See src/game/sim/teamRoster.ts. */
  allyTeamSeats?: readonly number[];
  /** Explicit per-seat side assignment from the lobby, when players have
   *  moved themselves between teams. Takes precedence over
   *  `allyTeamCount`. Seats missing here fall back to their own side. */
  allyTeamByPlayerId?: Readonly<Record<number, number>>;
  /** Immutable uint32 sampled once by the match host and distributed through
   * canonical initialization. Omitted only by deterministic tests/fixtures. */
  gameGenerationSeed?: number;
  /** Signed CENTER amplitude selected by the host/lobby. */
  centerMagnitude?: number;
  /** Signed RING annulus crest amplitude selected by the host/lobby. */
  ringMagnitude?: number;
  /** Signed DIVIDERS amplitude selected by the host/lobby. */
  dividersMagnitude?: number;
  /** Signed PERIMETER ring amplitude selected by the host/lobby. Negative =
   *  round-island; positive = rim; 0 = flat rim at ground level. */
  perimeterMagnitude?: number;
  /** Which of DIVIDERS/PERIMETER applies last in terrain generation
   *  (PRECEDENCE bar) — last wins where they overlap. */
  terrainPrecedence?: TerrainPrecedence;
  /** Plateau lattice step (world units). 0 = NONE (no terracing). */
  terrainDTerrain?: number;
  /** D-PLATEAU wall slope angle in degrees from horizontal. */
  plateauWallSlopeDegrees?: number;
  /** Signed metal-extractor pad altitude step (world units). Negative values
   *  lower positive authored deposit levels. */
  metalDepositStep?: number;
  /** Fine-triangle subdivisions per land cell. 0 = off; higher values
   *  refine the terrain mesh inside each cell. */
  terrainDetail?: number;
  /** Map width in canonical LAND_CELL_SIZE cells. */
  mapWidthLandCells?: number;
  /** Map length/height in canonical LAND_CELL_SIZE cells. */
  mapLengthLandCells?: number;
  /** Initial authoritative ground and liquid materials. They are applied
   *  before terrain-dependent simulation state and vegetation are built. */
  metalCoverage?: MetalCoverage;
  liquidSurfaceMode?: LiquidSurfaceMode;
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
  /** Restrict the demo battle's initial base-spawn to these building
   *  blueprint ids. When omitted the server falls back to all buildings.
   *  A caller
   *  restoring user-saved demo settings passes them so disabled
   *  structures are skipped at base spawn. */
  initialAllowedBuildingBlueprintIds?: ReadonlySet<string>;
  /** Initial ENTITY COUNT CAP for the world (units + buildings, match
   *  total), applied BEFORE the demo's initial-spawn pass so the spawn
   *  count tracks the user's stored cap — the demo fills each SIDE's
   *  share (`entityCountCap / seated sides`) and splits it across that
   *  side's seats. Without this the world boots at the BATTLE_CONFIG
   *  default, the spawn fills to that, and only AFTER does
   *  `setEntityCountCap` arrive from the stored value — leaving a
   *  mismatch like "4075 entities / 16 cap" on screen. */
  initialEntityCountCap?: number;
  /** Initial CONVERTER TAX value (fraction in [0, 1)). Lobby /
   *  battle-bar selections feed this so each new battle starts with
   *  the configured tax instead of the WorldState default 0.0. */
  converterTax?: number;
  /** Number of build-grid cells consolidated into one authoritative path cell
   *  along each axis. Match-static and included in lockstep initialization. */
  pathfindingCellConsolidationMultiplier?: number;
  /** Authoritative fixed simulation cadence for this match. */
  simulationTickRateHz?: number;
};

export type EmaConfig = {
  avg: number;
  low: { drop: number; recovery: number };
};
