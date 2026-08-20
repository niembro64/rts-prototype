import { getMapSize } from '../config';
import { ARCHITECTURE_CONFIG } from '../architectureConfig';
import {
  BATTLE_CONFIG,
  loadStoredConverterTax,
  loadStoredPathfindingCellConsolidation,
  loadStoredSimulationTickRate,
  loadStoredMapLandDimensions,
  loadStoredLiquidSurfaceMode,
  getUnitCap,
  loadStoredSlowDownAtFinalWaypoint,
  loadStoredMetalCoverage,
  loadStoredTerrainRuntimeConfig,
  type BattleTerrainRuntimeConfig,
} from '../battleBarConfig';
import {
  setTerrainCenterMagnitude,
  setTerrainRingMagnitude,
  setTerrainDividersMagnitude,
  setTerrainPerimeterMagnitude,
  setTerrainPrecedence,
  setTerrainRuntimeConfig,
} from '../game/sim/Terrain';
import {
  setLiquidSurfaceMode,
  setMetalCoverage,
} from '../game/sim/worldSurfaceState';
import { GameServer } from '../game/server/GameServer';
import { assertDeterministicLockstepRuntimeReady } from '../game/architecture/DeterministicLockstepRuntimeGuards';
import {
  LockstepFrameScheduler,
  type LockstepFrameSchedulerDiagnostics,
} from '../game/architecture/LockstepFrameScheduler';
import {
  LockstepDesyncMonitor,
  type LockstepChecksumDiagnostics,
  type LockstepDesyncReport,
} from '../game/architecture/LockstepDesyncMonitor';
import {
  classifyCommandForArchitecture,
  createLockstepCommandEnvelope,
  type LockstepCommandEnvelope,
} from '../game/architecture/LockstepCommandProtocol';
import {
  allyTeamByPlayerIdFromInitialization,
  buildCanonicalMatchInitialization,
  hashCanonicalMatchInitialization,
} from '../game/architecture/CanonicalMatchInitialization';
import type { CanonicalServerStateHash } from '../game/architecture/CanonicalStateHash';
import {
  assertDeterministicLockstepSupported,
  LOCKSTEP_SUPPORT_BOUNDARIES,
  type LockstepSupportBoundaries,
} from '../game/architecture/LockstepSupportPolicy';
import {
  MatchCommandArchive,
  type MatchCommandArchiveDiagnostics,
} from '../game/architecture/MatchCommandArchive';
import {
  LockstepCatchUp,
  type LockstepCatchUpProgress,
} from '../game/architecture/LockstepCatchUp';
import {
  LockstepFlowControl,
  type LockstepFlowDecision,
  type LockstepFlowState,
  type LockstepPauseReason,
  type SeatedPeerProgress,
} from '../game/architecture/LockstepFlowControl';
import {
  createLockstepPerformanceBudget,
  type LockstepPerformanceBudget,
  type LockstepSnapshotPerformanceTelemetry,
} from '../game/architecture/LockstepPerformanceBudget';
import {
  LocalGameConnection,
  type LocalCommandAuthorityMode,
  type LocalGameConnectionOptions,
} from '../game/server/LocalGameConnection';
import {
  applyStoredBattleServerSettings,
} from '../game/server/battleServerSettings';
import type {
  BattleHandoff,
  LobbySettings,
  NetworkManager,
  NetworkRole,
} from '../game/network/NetworkManager';
import type { NetworkLockstepTransportDiagnostics } from '../game/network/NetworkLockstepTransport';
import type { GameConnection } from '../game/server/GameConnection';
import type { Command } from '../game/sim/commands';
import type { PlayerId } from '../game/sim/types';
import type { MemberId } from '../types/network';
import type { MapLandCellDimensions } from '../mapSizeConfig';
import { presentationSnapshotRateIntervalMs } from '../presentationSnapshotConfig';
import { createHostGameGenerationSeed } from '../game/network/gameGenerationSeed';
import type {
  LiquidSurfaceMode,
  MetalCoverage,
} from '../types/worldSurfaceMode';
import {
  normalizeSimulationTickRateHz,
  simulationTicksForDefaultTicks,
} from '../types/simulationTickRate';

export type RealBattleStartupTerrain = {
  terrainRuntimeConfig: BattleTerrainRuntimeConfig;
  mapDimensions: MapLandCellDimensions;
  mapSize: { width: number; height: number };
  metalCoverage: MetalCoverage;
  liquidSurfaceMode: LiquidSurfaceMode;
};

type CreateRealBattleServerOptions = {
  playerIds: PlayerId[];
  allyTeamByPlayerId?: Readonly<Record<number, number>> | undefined;
  allyTeamCount: number;
  aiPlayerIds?: PlayerId[];
  gameGenerationSeed: number;
  terrain: RealBattleStartupTerrain;
  converterTax?: number;
  pathfindingCellConsolidationMultiplier?: number;
  simulationTickRateHz?: number;
  onLoadingProgress?: (progress: number, phase?: string) => void | Promise<void>;
};

type RealBattleBackendDiagnostics = {
  networkRole: NetworkRole | null;
  lockstepSupport?: LockstepSupportBoundaries;
  lockstepInputDelayTicks?: number;
  lockstepInitializationHash?: string;
  lockstepGameId?: string;
  lockstepRoomCode?: string;
  lockstepCoordinatorPlayerId?: PlayerId;
  lockstepReadyPlayerIds?: readonly PlayerId[];
  lockstepRequiredReadyPlayerIds?: readonly PlayerId[];
  lockstepChecksums?: LockstepChecksumDiagnostics;
  lockstepNetwork?: NetworkLockstepTransportDiagnostics | null;
  lockstepPendingNetworkMessages?: { readonly queued: number; readonly dropped: number } | null;
  lockstepFrameResendCount?: number;
  lockstepResyncRequestCount?: number;
  lockstepReceivedCommandFrameCount?: number;
  lockstepBroadcastCommandFrameCount?: number;
  lockstepPerformanceBudget?: LockstepPerformanceBudget;
  lockstepFlowControl?: ReturnType<LockstepFlowControl['getDiagnostics']>;
  lockstepResignedPlayerIds?: readonly PlayerId[];
  lockstepCommandArchive?: MatchCommandArchiveDiagnostics;
  lockstepHistoryStreams?: number;
  lockstepCatchUp?: LockstepCatchUpProgress | null;
  lockstepSnapshotPerformance?: LockstepSnapshotPerformanceTelemetry;
  desyncReport?: LockstepDesyncReport | null;
  lockstep?: LockstepFrameSchedulerDiagnostics;
};

export type RealBattleBackendRuntime = {
  readonly server: GameServer | null;
  /** Seat -> side from the hashed canonical initialization. The renderer
   *  takes it from here so it builds the same roster the sim did. */
  readonly allyTeamByPlayerId?: Readonly<Record<number, number>> | undefined;
  /** Declared side count from the same initialization — empty sides included,
   *  because they still carve terrain. */
  readonly allyTeamCount?: number;
  readonly ownsServer?: boolean;
  readonly gameConnection: GameConnection;
  start(): void;
  stop(): void;
  getDiagnostics(): RealBattleBackendDiagnostics;
};

/** How far along every peer is, as the frame coordinator last saw it.
 *
 *  Reported to the UI so players can see who is falling behind. Peers whose
 *  progress is not yet known are omitted rather than reported at frame 0 —
 *  at match start that would paint everyone as lagging. */
export type RealBattlePeerFrameReport = {
  readonly coordinatorFrame: number;
  /** Lets the UI turn a frame gap into seconds. Not on the wire: every peer
   *  in a lockstep match runs the same rate, so each side reads its own. */
  readonly tickRateHz: number;
  readonly peers: readonly { readonly playerId: PlayerId; readonly frame: number }[];
};

type CreateRealBattleBackendOptions = {
  playerIds: PlayerId[];
  aiPlayerIds?: PlayerId[];
  terrain: RealBattleStartupTerrain;
  networkRole: NetworkRole | null;
  /** The SEAT this client holds, or undefined while it is watching. Not the
   *  view target: what a watcher is looking at is a local choice and must
   *  never become command authority. */
  localPlayerId: PlayerId | undefined;
  localIpAddress: string;
  network?: NetworkManager;
  battleHandoff?: BattleHandoff;
  /** Present when this client is joining a match ALREADY IN PROGRESS. It
   *  replays the archived history from frame 0 up to `grantFrame` before it
   *  is part of the match or renders anything. */
  resume?: RealBattleResumeContext;
  /** Replay progress while catching up, for the loading overlay. */
  onCatchUpProgress?: (progress: LockstepCatchUpProgress) => void;
  onLoadingProgress?: (progress: number, phase?: string) => void | Promise<void>;
  /** Called whenever peer progress is refreshed — on the coordinator from
   *  what it already tracks, on clients from the coordinator's broadcast. */
  onPeerFrameReport?: (report: RealBattlePeerFrameReport) => void;
  /** The match started or stopped being held for somebody. Drives the pause
   *  banner; purely presentational, and never reaches the simulation. */
  onFlowControlChange?: (report: RealBattleFlowControlReport) => void;
  /** A seated player stopped answering, so the coordinator should start
   *  counting them as disconnected for flow control. */
  /** Hands the backend the two callbacks that track whether a seated player is
   *  attached. The heartbeat tracker is the only mid-battle signal that a peer
   *  has gone; a reclaimed seat is the signal that one is back. */
  registerSilentPlayer?: (
    markSilent: (playerId: PlayerId) => void,
    markReturned: (playerId: PlayerId) => void,
  ) => void;
};

/**
 * What a peer needs to replay its way into a match already in progress.
 *
 * Handed over by the coordinator's resume grant. The handoff inside it is
 * byte-identical to the one the frame-0 peers received, so the boot path is
 * the ordinary one rather than a second "late joiner" initialization that
 * could drift.
 */
export type RealBattleResumeContext = {
  readonly grantFrame: number;
  readonly archiveThroughFrame: number;
  /** The coordinator's own checksum, and the frame it was taken at. The
   *  joiner compares its replayed hash here before it may render: a replay
   *  that disagrees is a desync, and joining anyway would spread it. */
  readonly verifyFrame: number;
  readonly verifyStateHash: CanonicalServerStateHash | null;
};

/** Why the match is being held, in the words the banner shows. */
export type RealBattleFlowControlReport = {
  readonly state: LockstepFlowState;
  readonly subjectPlayerId: PlayerId | null;
  readonly reason: LockstepPauseReason | null;
  readonly secondsBehind: number;
};

type RealBattleMatchContext = {
  readonly gameId: string;
  readonly roomCode: string;
  readonly hostPlayerId: PlayerId;
  readonly settings: LobbySettings;
  readonly initializationHash: string;
  readonly gameGenerationSeed: number;
  /** Seat -> side, taken from the hashed canonical initialization so the
   *  sim and the renderer cannot disagree about who is allied. */
  readonly allyTeamByPlayerId: Readonly<Record<number, number>> | undefined;
  /** Sides the lobby declared, empty ones included — also from the hashed
   *  initialization. An empty side still carves its slice. */
  readonly allyTeamCount: number;
  /** The handoff this match started from, re-served verbatim to anyone who
   *  joins later. One contract, one boot path: a late arrival must not get a
   *  separately-built initialization that could drift from the real one. */
  readonly handoff: BattleHandoff | undefined;
};

type CreateRealBattleMatchContextOptions = {
  readonly playerIds: readonly PlayerId[];
  readonly aiPlayerIds: readonly PlayerId[] | undefined;
  readonly terrain: RealBattleStartupTerrain;
  /** The SEAT this client holds, or undefined while it is watching. */
  readonly localPlayerId: PlayerId | undefined;
  readonly networkRole: NetworkRole | null;
  readonly network: NetworkManager | undefined;
  readonly battleHandoff: BattleHandoff | undefined;
  readonly requireHandoff: boolean;
  readonly contextLabel: string;
};

/** How often the coordinator publishes peer progress. Half a second is well
 *  under the point where a stall becomes visible, and it is a tiny message. */
const LOCKSTEP_PEER_FRAME_REPORT_INTERVAL_MS = 500;
const LOCKSTEP_COORDINATOR_RESEND_INTERVAL_MS = 250;
const LOCKSTEP_COORDINATOR_RESEND_FRAME_LIMIT = 300;
const LOCKSTEP_CLIENT_RESYNC_REQUEST_INTERVAL_MS = 500;
const LOCKSTEP_MAX_PUMP_ADVANCE_FRAMES = 300;

/** Frames of history per chunk. Bounded so serving a joiner cannot starve the
 *  live frame stream every other peer is waiting on. */
const LOCKSTEP_HISTORY_CHUNK_FRAMES = 600;

/** Time a catching-up peer may spend replaying per animation frame. Short
 *  enough that the loading overlay keeps painting and the tab stays alive;
 *  everything left over goes to the replay. */
const LOCKSTEP_CATCH_UP_BUDGET_MS = 12;

/** Sentinel the local checksums of an UNSEATED peer are filed under. Outside
 *  the seat range on purpose: a watcher verifies its own replay against the
 *  coordinator's hash, and must never join the desync comparison between
 *  seated players. */
const WATCHER_CHECKSUM_PLAYER_ID = 0;

export function loadAndApplyRealBattleTerrain(): RealBattleStartupTerrain {
  const terrainRuntimeConfig = loadStoredTerrainRuntimeConfig('real');
  const mapDimensions = loadStoredMapLandDimensions('real');
  const mapSize = getMapSize(
    false,
    mapDimensions.widthLandCells,
    mapDimensions.lengthLandCells,
  );
  const metalCoverage = loadStoredMetalCoverage('real');
  const liquidSurfaceMode = loadStoredLiquidSurfaceMode('real');
  setTerrainRuntimeConfig(terrainRuntimeConfig);
  setTerrainCenterMagnitude(terrainRuntimeConfig.centerMagnitude);
  setTerrainRingMagnitude(terrainRuntimeConfig.ringMagnitude);
  setTerrainDividersMagnitude(terrainRuntimeConfig.dividersMagnitude);
  setTerrainPerimeterMagnitude(terrainRuntimeConfig.perimeterMagnitude);
  setTerrainPrecedence(terrainRuntimeConfig.terrainPrecedence);
  setMetalCoverage(metalCoverage);
  setLiquidSurfaceMode(liquidSurfaceMode);
  return {
    terrainRuntimeConfig,
    mapDimensions,
    mapSize,
    metalCoverage,
    liquidSurfaceMode,
  };
}

function buildRealBattleLobbySettingsFromTerrain(
  terrain: RealBattleStartupTerrain,
): LobbySettings {
  return {
    // Presentation only, and the battle is already starting: the name the
    // lobby was listed under has no bearing on the world being built.
    lobbyName: '',
    centerMagnitude: terrain.terrainRuntimeConfig.centerMagnitude,
    ringMagnitude: terrain.terrainRuntimeConfig.ringMagnitude,
    dividersMagnitude: terrain.terrainRuntimeConfig.dividersMagnitude,
    perimeterMagnitude: terrain.terrainRuntimeConfig.perimeterMagnitude,
    terrainPrecedence: terrain.terrainRuntimeConfig.terrainPrecedence,
    terrainDTerrain: terrain.terrainRuntimeConfig.terrainDTerrain,
    plateauWallSlopeDegrees:
      terrain.terrainRuntimeConfig.plateauWallSlopeDegrees,
    metalDepositStep: terrain.terrainRuntimeConfig.metalDepositStep,
    terrainDetail: terrain.terrainRuntimeConfig.terrainDetail,
    mapWidthLandCells: terrain.mapDimensions.widthLandCells,
    mapLengthLandCells: terrain.mapDimensions.lengthLandCells,
    entityCountCap: getUnitCap('real'),
    allyTeamCount: BATTLE_CONFIG.allyTeamCount.default,
    pathfindingCellConsolidationMultiplier:
      loadStoredPathfindingCellConsolidation('real'),
    simulationTickRateHz: loadStoredSimulationTickRate('real'),
    converterTax: loadStoredConverterTax('real'),
    slowDownAtFinalWaypoint: loadStoredSlowDownAtFinalWaypoint('real'),
    metalCoverage: terrain.metalCoverage,
    liquidSurfaceMode: terrain.liquidSurfaceMode,
  };
}

function createRealBattleMatchContext({
  playerIds,
  aiPlayerIds,
  terrain,
  localPlayerId,
  networkRole,
  network,
  battleHandoff,
  requireHandoff,
  contextLabel,
}: CreateRealBattleMatchContextOptions): RealBattleMatchContext {
  const fallbackSettings = buildRealBattleLobbySettingsFromTerrain(terrain);
  if (requireHandoff && battleHandoff === undefined) {
    throw new Error(
      `[${contextLabel}] online deterministic-lockstep requires a BattleHandoff. ` +
        'The host and every client must start from the same lobby handoff before frame 0.',
    );
  }

  if (battleHandoff !== undefined) {
    assertSamePlayerIds(
      playerIds,
      battleHandoff.playerIds,
      `[${contextLabel}] battle handoff player roster mismatch`,
    );
    const handoffHash = hashCanonicalMatchInitialization(battleHandoff.initialization);
    if (handoffHash !== battleHandoff.initializationHash) {
      throw new Error(
        `[${contextLabel}] battle handoff initialization hash is invalid: ` +
          `handoff=${battleHandoff.initializationHash}, recomputed=${handoffHash}`,
      );
    }
    const settings = battleHandoff.settings;
    assertTerrainMatchesSettings(
      terrain,
      settings,
      `[${contextLabel}] local terrain does not match battle handoff settings`,
    );
    const rebuiltInitialization = buildCanonicalMatchInitialization({
      gameId: battleHandoff.gameId,
      roomCode: battleHandoff.roomCode,
      hostPlayerId: battleHandoff.hostPlayerId,
      playerIds: battleHandoff.playerIds,
      allyTeamByPlayerId: allyTeamByPlayerIdFromInitialization(battleHandoff.initialization),
      allyTeamCount: battleHandoff.initialization.allyTeamCount,
      aiPlayerIds: battleHandoff.initialization.aiPlayerIds,
      settings,
      gameGenerationSeed: battleHandoff.initialization.gameGenerationSeed,
    });
    const rebuiltHash = hashCanonicalMatchInitialization(rebuiltInitialization);
    if (rebuiltHash !== battleHandoff.initializationHash) {
      throw new Error(
        `[${contextLabel}] local canonical initialization does not match the battle handoff: ` +
          `handoff=${battleHandoff.initializationHash}, local=${rebuiltHash}. ` +
          'Check architecture.json, lobby settings, content hashes, and WASM version.',
      );
    }
    return {
      gameId: battleHandoff.gameId,
      roomCode: battleHandoff.roomCode,
      hostPlayerId: battleHandoff.hostPlayerId,
      settings,
      allyTeamByPlayerId: allyTeamByPlayerIdFromInitialization(battleHandoff.initialization),
      allyTeamCount: battleHandoff.initialization.allyTeamCount,
      initializationHash: battleHandoff.initializationHash,
      gameGenerationSeed: battleHandoff.initialization.gameGenerationSeed,
      handoff: battleHandoff,
    };
  }

  const gameId = networkRole === null || network === undefined
    ? `local-lockstep:${playerIds.join(',')}:${terrain.mapSize.width}x${terrain.mapSize.height}`
    : network.getUniversalGameId();
  const roomCode = networkRole === null || network === undefined
    ? 'local-lockstep'
    : network.getRoomCode();
  const hostPlayerId = playerIds[0] ?? localPlayerId ?? (1 as PlayerId);
  const gameGenerationSeed = createHostGameGenerationSeed();
  const initialization = buildCanonicalMatchInitialization({
    gameId,
    roomCode,
    hostPlayerId,
    playerIds,
    allyTeamByPlayerId: network?.getAllyTeamByPlayerId(),
    allyTeamCount: network?.lobbyAllyTeamCount() ?? fallbackSettings.allyTeamCount,
    aiPlayerIds,
    settings: fallbackSettings,
    gameGenerationSeed,
  });
  return {
    gameId,
    roomCode,
    hostPlayerId,
    settings: fallbackSettings,
    initializationHash: hashCanonicalMatchInitialization(initialization),
    gameGenerationSeed,
    // Canonical, hashed, and identical on every peer — the one roster the
    // sim and the renderer both build their sides from.
    allyTeamByPlayerId: allyTeamByPlayerIdFromInitialization(initialization),
    allyTeamCount: initialization.allyTeamCount,
    // Offline / no-handoff starts have nothing to re-serve; nobody can join
    // them mid-match either, so there is nothing to serve.
    handoff: undefined,
  };
}

function assertSamePlayerIds(
  localPlayerIds: readonly PlayerId[],
  handoffPlayerIds: readonly PlayerId[],
  label: string,
): void {
  const local = [...localPlayerIds].sort((a, b) => a - b);
  const handoff = [...handoffPlayerIds].sort((a, b) => a - b);
  if (local.length === handoff.length && local.every((id, index) => id === handoff[index])) {
    return;
  }
  throw new Error(
    `${label}: local=[${local.join(',')}], handoff=[${handoff.join(',')}]`,
  );
}

function assertTerrainMatchesSettings(
  terrain: RealBattleStartupTerrain,
  settings: LobbySettings,
  label: string,
): void {
  const mismatches: string[] = [];
  pushMismatch(mismatches, 'centerMagnitude', terrain.terrainRuntimeConfig.centerMagnitude, settings.centerMagnitude);
  pushMismatch(mismatches, 'ringMagnitude', terrain.terrainRuntimeConfig.ringMagnitude, settings.ringMagnitude);
  pushMismatch(mismatches, 'dividersMagnitude', terrain.terrainRuntimeConfig.dividersMagnitude, settings.dividersMagnitude);
  pushMismatch(mismatches, 'perimeterMagnitude', terrain.terrainRuntimeConfig.perimeterMagnitude, settings.perimeterMagnitude);
  pushMismatch(mismatches, 'terrainPrecedence', terrain.terrainRuntimeConfig.terrainPrecedence, settings.terrainPrecedence);
  pushMismatch(mismatches, 'terrainDTerrain', terrain.terrainRuntimeConfig.terrainDTerrain, settings.terrainDTerrain);
  pushMismatch(mismatches, 'plateauWallSlopeDegrees', terrain.terrainRuntimeConfig.plateauWallSlopeDegrees, settings.plateauWallSlopeDegrees);
  pushMismatch(mismatches, 'metalDepositStep', terrain.terrainRuntimeConfig.metalDepositStep, settings.metalDepositStep);
  pushMismatch(mismatches, 'terrainDetail', terrain.terrainRuntimeConfig.terrainDetail, settings.terrainDetail);
  pushMismatch(mismatches, 'mapWidthLandCells', terrain.mapDimensions.widthLandCells, settings.mapWidthLandCells);
  pushMismatch(mismatches, 'mapLengthLandCells', terrain.mapDimensions.lengthLandCells, settings.mapLengthLandCells);
  if (settings.metalCoverage !== undefined) {
    pushMismatch(mismatches, 'metalCoverage', terrain.metalCoverage, settings.metalCoverage);
  }
  if (settings.liquidSurfaceMode !== undefined) {
    pushMismatch(mismatches, 'liquidSurfaceMode', terrain.liquidSurfaceMode, settings.liquidSurfaceMode);
  }
  if (mismatches.length === 0) return;
  throw new Error(`${label}: ${mismatches.join('; ')}`);
}

function pushMismatch(
  mismatches: string[],
  field: string,
  actual: number | string | undefined,
  expected: number | string | undefined,
): void {
  if (actual === expected) return;
  mismatches.push(`${field} local=${String(actual)} handoff=${String(expected)}`);
}

function diffCanonicalHashSections(
  localHash: CanonicalServerStateHash,
  remoteHash: CanonicalServerStateHash | null,
): readonly string[] {
  if (remoteHash === null) return ['remote hash unavailable'];
  const diffs: string[] = [];
  for (const key of Object.keys(localHash.sections) as Array<keyof CanonicalServerStateHash['sections']>) {
    const localSection = localHash.sections[key];
    const remoteSection = remoteHash.sections[key];
    if (localSection !== remoteSection) {
      diffs.push(`${key}: local=${localSection} remote=${remoteSection}`);
    }
  }
  if (localHash.hash !== remoteHash.hash && diffs.length === 0) {
    diffs.push(`root: local=${localHash.hash} remote=${remoteHash.hash}`);
  }
  return diffs;
}

function diffCanonicalEntityHashes(
  localHash: CanonicalServerStateHash,
  remoteHash: CanonicalServerStateHash | null,
): readonly string[] {
  if (remoteHash === null) return ['remote hash unavailable'];
  const localEntities = localHash.entityHashes ?? [];
  const remoteEntities = remoteHash.entityHashes ?? [];
  if (localEntities.length === 0 || remoteEntities.length === 0) {
    return ['entity hash diagnostics unavailable'];
  }

  const remoteById = new Map(remoteEntities.map((entity) => [entity.id, entity]));
  const localById = new Map(localEntities.map((entity) => [entity.id, entity]));
  const diffs: string[] = [];
  for (const localEntity of localEntities) {
    const remoteEntity = remoteById.get(localEntity.id);
    if (remoteEntity === undefined) {
      diffs.push(`entity ${localEntity.id} (${localEntity.type}) missing on remote`);
      continue;
    }
    if (localEntity.hash === remoteEntity.hash) continue;
    const componentDiffs = diffCanonicalEntityComponents(
      localEntity.components,
      remoteEntity.components,
      localEntity.componentFields,
      remoteEntity.componentFields,
    );
    diffs.push(
      `entity ${localEntity.id} (${localEntity.type}): ` +
        `local=${localEntity.hash} remote=${remoteEntity.hash}` +
        (componentDiffs.length > 0 ? ` components=[${componentDiffs.join(', ')}]` : ''),
    );
  }
  for (const remoteEntity of remoteEntities) {
    if (localById.has(remoteEntity.id)) continue;
    diffs.push(`entity ${remoteEntity.id} (${remoteEntity.type}) missing locally`);
  }
  return diffs.slice(0, 12);
}

function diffCanonicalEntityComponents(
  localComponents: { readonly [component: string]: string },
  remoteComponents: { readonly [component: string]: string },
  localComponentFields: {
    readonly [component: string]: { readonly [field: string]: string };
  } | undefined,
  remoteComponentFields: {
    readonly [component: string]: { readonly [field: string]: string };
  } | undefined,
): readonly string[] {
  const keys = new Set([
    ...Object.keys(localComponents),
    ...Object.keys(remoteComponents),
  ]);
  const diffs: string[] = [];
  for (const key of [...keys].sort()) {
    const localValue = localComponents[key];
    const remoteValue = remoteComponents[key];
    if (localValue === remoteValue) continue;
    const fieldDiffs = diffCanonicalComponentFields(
      localComponentFields?.[key],
      remoteComponentFields?.[key],
    );
    diffs.push(
      `${key}: local=${localValue ?? 'missing'} remote=${remoteValue ?? 'missing'}` +
        (fieldDiffs.length > 0 ? ` fields=[${fieldDiffs.join(', ')}]` : ''),
    );
  }
  return diffs;
}

function diffCanonicalComponentFields(
  localFields: { readonly [field: string]: string } | undefined,
  remoteFields: { readonly [field: string]: string } | undefined,
): readonly string[] {
  if (localFields === undefined || remoteFields === undefined) return [];
  const keys = new Set([...Object.keys(localFields), ...Object.keys(remoteFields)]);
  const diffs: string[] = [];
  for (const key of [...keys].sort()) {
    const localValue = localFields[key];
    const remoteValue = remoteFields[key];
    if (localValue === remoteValue) continue;
    diffs.push(`${key}: local=${localValue ?? 'missing'} remote=${remoteValue ?? 'missing'}`);
  }
  return diffs.slice(0, 16);
}

function createLocalRealBattleConnection(
  server: GameServer,
  localPlayerId: PlayerId | undefined,
  commandAuthorityMode: LocalCommandAuthorityMode = 'player',
  options: LocalGameConnectionOptions = {},
): GameConnection {
  return new LocalGameConnection(server, localPlayerId, commandAuthorityMode, options);
}

async function createRealBattleServer({
  playerIds,
  allyTeamByPlayerId,
  allyTeamCount,
  aiPlayerIds,
  gameGenerationSeed,
  terrain,
  converterTax,
  pathfindingCellConsolidationMultiplier,
  simulationTickRateHz,
  onLoadingProgress,
}: CreateRealBattleServerOptions): Promise<GameServer> {
  return GameServer.create(
    {
      playerIds,
      allyTeamByPlayerId,
      allyTeamCount,
      aiPlayerIds,
      gameGenerationSeed,
      centerMagnitude: terrain.terrainRuntimeConfig.centerMagnitude,
      ringMagnitude: terrain.terrainRuntimeConfig.ringMagnitude,
      dividersMagnitude: terrain.terrainRuntimeConfig.dividersMagnitude,
      perimeterMagnitude: terrain.terrainRuntimeConfig.perimeterMagnitude,
      terrainPrecedence: terrain.terrainRuntimeConfig.terrainPrecedence,
      terrainDTerrain: terrain.terrainRuntimeConfig.terrainDTerrain,
      plateauWallSlopeDegrees:
        terrain.terrainRuntimeConfig.plateauWallSlopeDegrees,
      metalDepositStep: terrain.terrainRuntimeConfig.metalDepositStep,
      terrainDetail: terrain.terrainRuntimeConfig.terrainDetail,
      mapWidthLandCells: terrain.mapDimensions.widthLandCells,
      mapLengthLandCells: terrain.mapDimensions.lengthLandCells,
      metalCoverage: terrain.metalCoverage,
      liquidSurfaceMode: terrain.liquidSurfaceMode,
      converterTax: converterTax ?? loadStoredConverterTax('real'),
      pathfindingCellConsolidationMultiplier:
        pathfindingCellConsolidationMultiplier ??
        loadStoredPathfindingCellConsolidation('real'),
      simulationTickRateHz: simulationTickRateHz ??
        loadStoredSimulationTickRate('real'),
    },
    {
      onProgress: onLoadingProgress,
    },
  );
}

export function createDeterministicLockstepBackend(
  options: CreateRealBattleBackendOptions,
): Promise<RealBattleBackendRuntime> {
  assertDeterministicLockstepRuntimeReady();
  assertDeterministicLockstepSupported({
    playerIds: options.playerIds,
    aiPlayerIds: options.aiPlayerIds,
    localPlayerId: options.localPlayerId,
    networkRole: options.networkRole,
    battleKind: 'real',
  });
  return createDeterministicLockstepBackendRuntime(options);
}

async function createDeterministicLockstepBackendRuntime({
  playerIds,
  aiPlayerIds,
  terrain,
  networkRole,
  localPlayerId,
  localIpAddress,
  network,
  battleHandoff,
  resume,
  onCatchUpProgress,
  onLoadingProgress,
  onPeerFrameReport,
  onFlowControlChange,
  registerSilentPlayer,
}: CreateRealBattleBackendOptions): Promise<RealBattleBackendRuntime> {
  const matchContext = createRealBattleMatchContext({
    playerIds,
    aiPlayerIds,
    terrain,
    localPlayerId,
    networkRole,
    network,
    battleHandoff,
    requireHandoff: networkRole !== null,
    contextLabel: 'deterministic-lockstep',
  });
  const server = await createRealBattleServer({
    playerIds,
    allyTeamByPlayerId: matchContext.allyTeamByPlayerId,
    allyTeamCount: matchContext.allyTeamCount,
    aiPlayerIds,
    gameGenerationSeed: matchContext.gameGenerationSeed,
    terrain,
    converterTax: matchContext.settings.converterTax,
    pathfindingCellConsolidationMultiplier:
      matchContext.settings.pathfindingCellConsolidationMultiplier,
    simulationTickRateHz: matchContext.settings.simulationTickRateHz,
    onLoadingProgress,
  });
  const lockstepCore = server.getLockstepSimulationCore();
  const pendingCommandsByFrame = new Map<number, LockstepCommandEnvelope[]>();
  const isOnlineLockstep = networkRole !== null && network !== undefined;
  const isFrameCoordinator = networkRole !== 'client';
  const gameId = matchContext.gameId;
  const initializationHash = matchContext.initializationHash;
  const initialEntityCountCap = matchContext.settings.entityCountCap ?? getUnitCap('real');
  const simulationTickRateHz = normalizeSimulationTickRateHz(
    matchContext.settings.simulationTickRateHz,
  );
  const lockstepFixedDtMs = 1000 / simulationTickRateHz;
  const lockstepInputDelayTicks = simulationTicksForDefaultTicks(
    simulationTickRateHz,
    ARCHITECTURE_CONFIG.lockstep.inputDelayTicks,
  );
  const lockstepChecksumIntervalTicks = simulationTicksForDefaultTicks(
    simulationTickRateHz,
    ARCHITECTURE_CONFIG.lockstep.checksumIntervalTicks,
  );
  /**
   * Which id this peer's own checksums are filed under.
   *
   * A watcher has no seat but still hashes its state every checksum interval —
   * that is the gate its replay is verified by. Filing those under a sentinel
   * outside the seat range keeps them out of the desync comparison against
   * real players, which a watcher must never be able to trigger.
   */
  const checksumPlayerId: PlayerId = localPlayerId ?? (WATCHER_CHECKSUM_PLAYER_ID as PlayerId);
  let nextLocalPlayerSequence = 0;
  let nextFrameSequence = 0;
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let browserResumePumpHandler: (() => void) | null = null;
  let desyncMonitor: LockstepDesyncMonitor | null = null;
  // The completion set: seated players only. A watcher is never in it, which
  // is what makes "a spectator cannot hold the match up" structural.
  const requiredReadyPlayerIds = new Set<PlayerId>(
    isOnlineLockstep ? playerIds : localPlayerId === undefined ? [] : [localPlayerId],
  );
  const readyPlayerIds = new Set<PlayerId>(
    localPlayerId === undefined ? [] : [localPlayerId],
  );
  let broadcastCommandFrameCount = 0;
  let receivedCommandFrameCount = 0;
  let frameResendCount = 0;
  let resyncRequestCount = 0;
  let lastCoordinatorResendMs = Number.NEGATIVE_INFINITY;
  let lastClientResyncRequestMs = Number.NEGATIVE_INFINITY;
  let lastClientResyncRequestFrame: number | null = null;
  type SnapshotTimingLane = {
    snapshotMsAvg: number;
    snapshotMsHi: number;
    snapshotMsInitialized: boolean;
    snapshotsEmitted: number;
  };
  const totalSnapshotTiming: SnapshotTimingLane = {
    snapshotMsAvg: 0,
    snapshotMsHi: 0,
    snapshotMsInitialized: false,
    snapshotsEmitted: 0,
  };
  const richSnapshotTiming: SnapshotTimingLane = {
    snapshotMsAvg: 0,
    snapshotMsHi: 0,
    snapshotMsInitialized: false,
    snapshotsEmitted: 0,
  };
  const deltaSnapshotTiming: SnapshotTimingLane = {
    snapshotMsAvg: 0,
    snapshotMsHi: 0,
    snapshotMsInitialized: false,
    snapshotsEmitted: 0,
  };
  const lockstepPresentationSnapshotIntervalMs = presentationSnapshotRateIntervalMs(
    ARCHITECTURE_CONFIG.lockstep.presentationSnapshots.nominalSnapshotRateHz,
  );
  let lastLockstepPresentationSnapshotMs = Number.NEGATIVE_INFINITY;
  let lastLockstepTelemetryPumpMs: number | null = null;
  let lastLockstepCommandPumpMs: number | null = null;
  let lockstepCommandPumpAccumulatorMs = lockstepFixedDtMs;
  const recordSnapshotTimingLane = (lane: SnapshotTimingLane, sampleMs: number): void => {
    const sample = Number.isFinite(sampleMs) && sampleMs >= 0 ? sampleMs : 0;
    lane.snapshotsEmitted++;
    if (!lane.snapshotMsInitialized) {
      lane.snapshotMsAvg = sample;
      lane.snapshotMsHi = sample;
      lane.snapshotMsInitialized = true;
      return;
    }
    lane.snapshotMsAvg = lane.snapshotMsAvg * 0.95 + sample * 0.05;
    lane.snapshotMsHi = sample > lane.snapshotMsHi
      ? lane.snapshotMsHi * 0.5 + sample * 0.5
      : lane.snapshotMsHi * 0.995 + sample * 0.005;
  };
  const recordSnapshotMs = (kind: 'rich' | 'delta', sampleMs: number): void => {
    recordSnapshotTimingLane(totalSnapshotTiming, sampleMs);
    recordSnapshotTimingLane(kind === 'rich' ? richSnapshotTiming : deltaSnapshotTiming, sampleMs);
  };

  /**
   * How far this coordinator may run ahead of its slowest SEATED player.
   *
   * Watchers are absent from what it is fed, so they cannot slow or stop a
   * match they are not part of — the request's rule falls out of the
   * completion/delivery split rather than needing a guard of its own.
   */
  const flowControl = new LockstepFlowControl({
    tickRateHz: simulationTickRateHz,
    nowMs: () => performance.now(),
  });
  /**
   * Every command frame this match has executed, so a peer arriving late can
   * replay it from frame 0. This plus the handoff IS the "full command history
   * and map parameters" a joiner needs; there is no state snapshot to send.
   *
   * Coordinator only — a client has no history to serve.
   */
  const commandArchive = new MatchCommandArchive();
  /** Joiners currently being served history, and how far each has been sent. */
  const historyStreams = new Map<MemberId, { nextFrame: number }>();
  /**
   * Set on a peer that is REPLAYING its way into a match already in progress.
   *
   * While it exists the pump replays as fast as its time budget allows instead
   * of stepping in real time, and nothing is rendered: a half-replayed world is
   * not a view of the match. Null on every peer that started at frame 0.
   */
  const catchUp: LockstepCatchUp | null = resume === undefined
    ? null
    : new LockstepCatchUp({
        tickRateHz: normalizeSimulationTickRateHz(
          battleHandoff?.settings.simulationTickRateHz,
        ),
        nowMs: () => performance.now(),
      });
  /** Seats already resigned by the drop timer, so the coordinator issues the
   *  command once and not on every pump afterwards. */
  const resignedPlayerIds = new Set<PlayerId>();
  /** Seats whose connection has gone quiet. Fed by the heartbeat tracker,
   *  which is the ONLY signal that works mid-battle — a dead socket can take
   *  a very long time to report itself. Presentation/session state: it decides
   *  whether the match waits, never what the simulation does. */
  const silentPlayerIds = new Set<PlayerId>();
  registerSilentPlayer?.(
    (playerId) => {
      silentPlayerIds.add(playerId);
    },
    (playerId) => {
      // Back on a socket. The match does not resume here — they still have to
      // replay their way to the current frame — but they are no longer gone,
      // so the pause reason becomes "behind" rather than "disconnected" and
      // the drop timer stops applying.
      silentPlayerIds.delete(playerId);
    },
  );

  const scheduler = new LockstepFrameScheduler({
    core: lockstepCore,
    expectedPlayerIds: playerIds,
    hostPlayerId: matchContext.hostPlayerId,
    fixedDtMs: lockstepFixedDtMs,
    checksumIntervalTicks: lockstepChecksumIntervalTicks,
    nowMs: () => performance.now(),
    onChecksum: ({ frame, stateHash }) => {
      // A watcher checksums locally — that is how a replay verifies itself —
      // but never reports one, because a watcher must not be able to pause a
      // match it is not part of.
      desyncMonitor?.recordChecksum({ playerId: checksumPlayerId, frame, stateHash });
      if (localPlayerId !== undefined) {
        network?.getLockstepTransport().sendChecksum(frame, stateHash);
      }
    },
  });
  desyncMonitor = new LockstepDesyncMonitor({
    localPlayerId: checksumPlayerId,
    peerIds: playerIds,
    initializationHash,
    getRecentCommandFrames: () => scheduler.getRecentCommandFrames(),
    nowMs: () => performance.now(),
    onDesync: (report) => {
      scheduler.markDesynced(`checksum mismatch at frame ${report.frame}`);
      console.error('[LOCKSTEP] checksum desync detected', {
        ...report,
        sectionDiffs: diffCanonicalHashSections(report.localHash, report.remoteHash),
        entityDiffs: diffCanonicalEntityHashes(report.localHash, report.remoteHash),
        diagnostics: scheduler.getDiagnostics(),
        lockstepNetwork: network?.getLockstepTransport().getDiagnostics() ?? null,
        sendBudget: network?.getSendBudgetTelemetry() ?? null,
      });
      network?.getLockstepTransport().broadcastDesync(
        report.frame,
        report.localHash,
        report.remotePlayerId,
        report.remoteHash,
      );
    },
  });

  const enqueueCommandEnvelope = (envelope: LockstepCommandEnvelope): void => {
    const pending = pendingCommandsByFrame.get(envelope.executeFrame);
    if (pending !== undefined) {
      pending.push(envelope);
    } else {
      pendingCommandsByFrame.set(envelope.executeFrame, [envelope]);
    }
  };

  const rescheduleCoordinatorEnvelope = (
    envelope: LockstepCommandEnvelope,
  ): LockstepCommandEnvelope => {
    const minExecuteFrame = scheduler.getDiagnostics().nextFrame +
      lockstepInputDelayTicks;
    if (envelope.executeFrame >= minExecuteFrame) return envelope;
    return {
      ...envelope,
      executeFrame: minExecuteFrame,
    };
  };

  const enqueueCoordinatorCommandEnvelope = (envelope: LockstepCommandEnvelope): void => {
    enqueueCommandEnvelope(rescheduleCoordinatorEnvelope(envelope));
  };

  const reportInitializationMismatch = (fromPlayerId: PlayerId, peerHash: string): void => {
    const currentFrame = scheduler.getDiagnostics().nextFrame;
    const reason =
      `initialization hash mismatch from peer ${fromPlayerId}: ` +
        `${peerHash} !== ${initializationHash}`;
    scheduler.markDesynced(reason);
    network?.getLockstepTransport().broadcastDesync(
      currentFrame,
      lockstepCore.getCanonicalStateHash(),
      fromPlayerId,
      null,
    );
    throw new Error(`[LOCKSTEP] ${reason}; gameId=${gameId}, roomCode=${matchContext.roomCode}`);
  };

  const markLockstepPeerReady = (playerId: PlayerId): void => {
    if (!requiredReadyPlayerIds.has(playerId)) {
      throw new Error(
        `[LOCKSTEP] received ready/hello from player ${playerId}, ` +
          `but required roster is [${[...requiredReadyPlayerIds].sort((a, b) => a - b).join(',')}]`,
      );
    }
    readyPlayerIds.add(playerId);
    scheduler.markPeerReady(playerId);
  };

  const hasAllRequiredLockstepPeersReady = (): boolean => {
    for (const playerId of requiredReadyPlayerIds) {
      if (!readyPlayerIds.has(playerId)) return false;
    }
    return true;
  };

  const resetLockstepCommandPumpClock = (): void => {
    lastLockstepCommandPumpMs = null;
    lockstepCommandPumpAccumulatorMs = lockstepFixedDtMs;
  };

  const takeLockstepCommandFrameBudget = (): number => {
    const nowMs = performance.now();
    const elapsedMs = lastLockstepCommandPumpMs === null
      ? 0
      : Math.max(0, nowMs - lastLockstepCommandPumpMs);
    lastLockstepCommandPumpMs = nowMs;
    lockstepCommandPumpAccumulatorMs = Math.min(
      lockstepCommandPumpAccumulatorMs + elapsedMs,
      lockstepFixedDtMs * LOCKSTEP_MAX_PUMP_ADVANCE_FRAMES,
    );
    const frames = Math.min(
      LOCKSTEP_MAX_PUMP_ADVANCE_FRAMES,
      Math.floor(lockstepCommandPumpAccumulatorMs / lockstepFixedDtMs),
    );
    lockstepCommandPumpAccumulatorMs = Math.max(
      0,
      lockstepCommandPumpAccumulatorMs - frames * lockstepFixedDtMs,
    );
    return frames;
  };

  const receiveCoordinatorCommandFrame = (
    frame: number,
    frameSequence: number,
    commands: readonly LockstepCommandEnvelope[],
  ): void => {
    receivedCommandFrameCount++;
    scheduler.receiveCommandFrame({
      frame,
      frameSequence,
      commands,
    });
  };

  const resendCommandFramesToLaggingPeers = (): void => {
    if (!isOnlineLockstep || !isFrameCoordinator || network === undefined) return;
    const nowMs = performance.now();
    if (nowMs - lastCoordinatorResendMs < LOCKSTEP_COORDINATOR_RESEND_INTERVAL_MS) return;
    lastCoordinatorResendMs = nowMs;
    const transport = network.getLockstepTransport();
    for (const playerId of playerIds) {
      if (playerId === localPlayerId) continue;
      const latestAck = transport.latestAckForPlayer(playerId);
      const lastAckedFrame = latestAck?.ackFrame ?? -1;
      frameResendCount += transport.resendCommandFramesAfter(
        lastAckedFrame,
        playerId,
        LOCKSTEP_COORDINATOR_RESEND_FRAME_LIMIT,
      );
    }
  };

  /**
   * Ask flow control what this pump may do, and act on what it says.
   *
   * Three outputs, in the order they matter: the frame budget (throttling),
   * a pause with a named subject (broadcast once per change, never per tick),
   * and any seat that has held the match past the drop timeout — which is
   * removed with a frame-scheduled `resign`, because a player leaving the
   * simulation is gameplay truth and must happen on the same frame for
   * everyone.
   */
  const applyLockstepFlowControl = (
    coordinatorFrame: number,
    requestedFrames: number,
  ): LockstepFlowDecision => {
    if (!isOnlineLockstep || network === undefined) {
      return {
        state: 'running',
        allowedFrames: requestedFrames,
        subjectPlayerId: null,
        reason: null,
        pauseChanged: false,
        dropPlayerIds: [],
        worstLagFrames: 0,
      };
    }

    const transport = network.getLockstepTransport();
    const seated: SeatedPeerProgress[] = [];
    for (const playerId of playerIds) {
      if (playerId === localPlayerId) continue;
      if (resignedPlayerIds.has(playerId)) continue;
      const latestAck = transport.latestAckForPlayer(playerId);
      seated.push({
        playerId,
        ackFrame: latestAck?.ackFrame ?? null,
        connected: !silentPlayerIds.has(playerId),
      });
    }

    const decision = flowControl.report(coordinatorFrame, seated, requestedFrames);

    if (decision.pauseChanged) {
      if (decision.state === 'paused') {
        const subject = decision.subjectPlayerId;
        const reason = decision.reason === 'disconnected'
          ? `player ${subject} disconnected`
          : `player ${subject} is too far behind`;
        transport.broadcastPause(coordinatorFrame, reason);
        onFlowControlChange?.({
          state: decision.state,
          subjectPlayerId: subject,
          reason: decision.reason,
          secondsBehind: decision.worstLagFrames / simulationTickRateHz,
        });
      } else {
        transport.broadcastResume(coordinatorFrame);
        onFlowControlChange?.({
          state: decision.state,
          subjectPlayerId: null,
          reason: null,
          secondsBehind: 0,
        });
      }
    }

    for (const playerId of decision.dropPlayerIds) {
      if (resignedPlayerIds.has(playerId)) continue;
      resignedPlayerIds.add(playerId);
      flowControl.forget(playerId);
      // Host-authored and frame-scheduled: every peer removes the same army
      // on the same frame. Nothing about a dropped connection reaches the sim
      // except this.
      enqueueCoordinatorCommandEnvelope(
        createLockstepCommandEnvelope({
          gameId,
          currentKnownFrame: coordinatorFrame,
          playerId: matchContext.hostPlayerId,
          playerSequence: nextLocalPlayerSequence++,
          inputDelayTicks: lockstepInputDelayTicks,
          command: { type: 'resign', tick: coordinatorFrame, playerId },
        }),
      );
      console.warn(
        `[LOCKSTEP] resigning seat ${playerId}: gone longer than ` +
          `${flowControl.getDiagnostics().config.dropAfterSeconds}s`,
      );
    }

    return decision;
  };

  /**
   * A history chunk lists only the frames that carried commands. Everything
   * else inside its range was empty, which the scheduler cannot know on its
   * own — it would stall on the first unlisted frame waiting for one that is
   * never coming. Materializing them keeps "no commands" and "not delivered"
   * distinguishable, which is the whole reason the range is sent.
   */
  const fillEmptyHistoryFrames = (
    fromFrame: number,
    throughFrame: number,
    present: readonly { frame: number; frameSequence: number }[],
  ): void => {
    const carried = new Map<number, number>();
    for (const frame of present) carried.set(frame.frame, frame.frameSequence);

    // A frame's sequence is derived rather than invented. The coordinator
    // mints frames in one counting loop, so sequence and frame move together;
    // anchoring on a frame the chunk actually carries recovers the exact
    // sequence for the empty ones without assuming the two numbers are equal.
    // Getting this wrong would make a synthesized frame CONFLICT with the same
    // frame arriving on the live stream, which the scheduler reports as a
    // desync — a spurious one.
    let anchorFrame: number | null = null;
    let anchorSequence = 0;
    for (const [frame, sequence] of carried) {
      if (anchorFrame === null || frame < anchorFrame) {
        anchorFrame = frame;
        anchorSequence = sequence;
      }
    }

    for (let frame = Math.max(0, fromFrame); frame <= throughFrame; frame++) {
      if (carried.has(frame)) continue;
      const frameSequence = anchorFrame === null
        ? frame
        : anchorSequence + (frame - anchorFrame);
      receiveCoordinatorCommandFrame(frame, frameSequence, []);
    }
  };

  /**
   * Coordinator: push the next slice of history to everyone catching up.
   *
   * Chunked and paced rather than sent in one burst — a twenty-minute match is
   * a few thousand commands, which is small, but the data channel is also
   * carrying the live frame stream that every OTHER peer needs on time.
   */
  const pumpHistoryStreams = (): void => {
    if (!isFrameCoordinator || network === undefined || historyStreams.size === 0) return;
    const transport = network.getLockstepTransport();
    const throughFrame = commandArchive.getThroughFrame();
    for (const [memberId, stream] of historyStreams) {
      const chunkEnd = Math.min(throughFrame, stream.nextFrame + LOCKSTEP_HISTORY_CHUNK_FRAMES - 1);
      if (chunkEnd < stream.nextFrame) {
        historyStreams.delete(memberId);
        continue;
      }
      const frames = commandArchive.slice(stream.nextFrame, chunkEnd).map((entry) => ({
        frame: entry.frame,
        frameSequence: entry.frameSequence,
        commands: [...entry.commands],
      }));
      const final = chunkEnd >= throughFrame;
      transport.sendHistoryChunk(memberId, stream.nextFrame, chunkEnd, frames, final);
      stream.nextFrame = chunkEnd + 1;
      if (final) historyStreams.delete(memberId);
    }
  };

  let lastPeerFrameReportMs = 0;

  /** Coordinator only: broadcast every peer's progress, and hand the same
   *  picture to the local UI.
   *
   *  The coordinator is the only peer that sees everyone's acks — in a hosted
   *  session the clients are not connected to each other at all — so without
   *  this nobody but the host could tell who was lagging. */
  const broadcastPeerFrameReport = (): void => {
    if (!isOnlineLockstep || !isFrameCoordinator || network === undefined) return;
    const nowMs = performance.now();
    if (nowMs - lastPeerFrameReportMs < LOCKSTEP_PEER_FRAME_REPORT_INTERVAL_MS) return;
    lastPeerFrameReportMs = nowMs;

    const transport = network.getLockstepTransport();
    const coordinatorFrame = scheduler.getDiagnostics().nextFrame;
    const peers: { playerId: PlayerId; frame: number }[] = [];
    if (localPlayerId !== undefined) {
      peers.push({ playerId: localPlayerId, frame: coordinatorFrame });
    }
    for (const playerId of playerIds) {
      if (playerId === localPlayerId) continue;
      const latestAck = transport.latestAckForPlayer(playerId);
      // No ack yet means "not known", not "at frame 0" — reporting zero here
      // would show every peer as maximally behind for the first seconds.
      if (latestAck === undefined) continue;
      peers.push({ playerId, frame: latestAck.ackFrame });
    }
    transport.broadcastPeerFrames(coordinatorFrame, peers);
    onPeerFrameReport?.({ coordinatorFrame, tickRateHz: simulationTickRateHz, peers });
  };

  const requestMissingCommandFrameIfNeeded = (): void => {
    if (!isOnlineLockstep || isFrameCoordinator || network === undefined) return;
    const diagnostics = scheduler.getDiagnostics();
    if (diagnostics.status !== 'stalled' || diagnostics.missingFrame === null) return;
    const nowMs = performance.now();
    if (
      lastClientResyncRequestFrame === diagnostics.missingFrame &&
      nowMs - lastClientResyncRequestMs < LOCKSTEP_CLIENT_RESYNC_REQUEST_INTERVAL_MS
    ) {
      return;
    }
    lastClientResyncRequestFrame = diagnostics.missingFrame;
    lastClientResyncRequestMs = nowMs;
    resyncRequestCount++;
    network.getLockstepTransport().sendResyncRequest(
      diagnostics.missingFrame,
      diagnostics.message,
    );
  };

  const previousLockstepHandler = network?.onLockstepMessage;
  const handleLockstepMessage: NonNullable<NetworkManager['onLockstepMessage']> = (message, from) => {
    previousLockstepHandler?.(message, from);
    // A watcher holds no seat. It receives every command frame — it cannot
    // simulate without them — but it is never in the completion set, never
    // marked ready, and never a pause subject.
    const fromPlayerId = from.playerId;
    switch (message.type) {
      case 'lockstepHello':
        if (fromPlayerId === undefined) break;
        if (message.initializationHash !== initializationHash) {
          reportInitializationMismatch(fromPlayerId, message.initializationHash);
          break;
        }
        markLockstepPeerReady(message.playerId);
        break;
      case 'lockstepReady':
        if (fromPlayerId === undefined) break;
        if (message.initializationHash !== initializationHash) {
          reportInitializationMismatch(fromPlayerId, message.initializationHash);
          break;
        }
        markLockstepPeerReady(message.playerId);
        break;
      case 'lockstepCommand':
        if (isFrameCoordinator) {
          enqueueCoordinatorCommandEnvelope(message.envelope);
        }
        break;
      case 'lockstepCommandFrame':
        if (!isFrameCoordinator) {
          receiveCoordinatorCommandFrame(
            message.frame,
            message.frameSequence,
            message.commands,
          );
          network?.getLockstepTransport().sendAck(message.frame, message.frameSequence);
        }
        break;
      case 'lockstepCommandFrameBatch':
        if (!isFrameCoordinator) {
          let lastFrame: number | null = null;
          let lastFrameSequence: number | null = null;
          for (let i = 0; i < message.frames.length; i++) {
            const frame = message.frames[i];
            receiveCoordinatorCommandFrame(
              frame.frame,
              frame.frameSequence,
              frame.commands,
            );
            lastFrame = frame.frame;
            lastFrameSequence = frame.frameSequence;
          }
          if (lastFrame !== null && lastFrameSequence !== null) {
            network?.getLockstepTransport().sendAck(lastFrame, lastFrameSequence);
          }
        }
        break;
      case 'lockstepAck':
        break;
      case 'lockstepPeerFrames':
        // Only the coordinator can speak for everyone; ignore anyone else,
        // and ignore our own broadcast echoing back.
        if (!isFrameCoordinator && from.memberId !== network?.getLocalMemberId()) {
          onPeerFrameReport?.({
            coordinatorFrame: message.coordinatorFrame,
            tickRateHz: simulationTickRateHz,
            peers: message.peers.map((peer) => ({
              playerId: peer.playerId,
              frame: peer.frame,
            })),
          });
        }
        break;
      case 'lockstepChecksum':
        desyncMonitor?.recordChecksum({
          playerId: message.playerId,
          frame: message.frame,
          stateHash: message.stateHash,
        });
        break;
      case 'lockstepPause':
        scheduler.pause(message.frame, message.reason);
        if (isFrameCoordinator && fromPlayerId !== localPlayerId) {
          network?.getLockstepTransport().broadcastPause(message.frame, message.reason);
        }
        break;
      case 'lockstepResume':
        scheduler.resume(message.resumeFrame);
        if (isFrameCoordinator && fromPlayerId !== localPlayerId) {
          network?.getLockstepTransport().broadcastResume(message.resumeFrame);
        }
        break;
      case 'lockstepDesync':
        // A watcher's local divergence is its own problem and must never
        // pause a match it is not part of.
        if (fromPlayerId === undefined) break;
        scheduler.markDesynced(`peer ${fromPlayerId} reported desync at frame ${message.frame}`);
        console.error('[LOCKSTEP] peer reported desync', {
          ...message,
          sectionDiffs: diffCanonicalHashSections(message.localHash, message.remoteHash),
          entityDiffs: diffCanonicalEntityHashes(message.localHash, message.remoteHash),
          diagnostics: scheduler.getDiagnostics(),
          lockstepNetwork: network?.getLockstepTransport().getDiagnostics() ?? null,
          sendBudget: network?.getSendBudgetTelemetry() ?? null,
        });
        break;
      case 'lockstepResumeRequest':
        // Coordinator: a late arrival wants in. Grant on the connection it
        // asked from, then stream the archive to it while the live frames it
        // is already receiving pile up in its scheduler — one queue, no
        // separate buffer, and no hole between history and live.
        if (isFrameCoordinator && network !== undefined) {
          const resumeHandoff = matchContext.handoff;
          if (resumeHandoff === undefined) {
            // Nothing to serve: this match never started from a handoff, so
            // nobody could have been admitted to it in the first place.
            break;
          }
          const grantFrame = scheduler.getDiagnostics().nextFrame;
          const verify = desyncMonitor?.getLatestLocalChecksum() ?? null;
          network.getLockstepTransport().sendResumeGrant(from.memberId, {
            memberId: from.memberId,
            handoff: resumeHandoff,
            grantFrame,
            archiveThroughFrame: commandArchive.getThroughFrame(),
            verifyFrame: verify?.frame ?? -1,
            verifyStateHash: verify?.stateHash ?? null,
          });
          historyStreams.set(from.memberId, {
            nextFrame: Math.max(0, message.haveThroughFrame + 1),
          });
        }
        break;

      case 'lockstepHistory':
        // Joiner: a chunk of the past. Frames go into the SAME scheduler queue
        // the live stream feeds, which is what makes catching up an ordinary
        // advance rather than a second code path.
        if (!isFrameCoordinator) {
          for (const frame of message.frames) {
            receiveCoordinatorCommandFrame(frame.frame, frame.frameSequence, frame.commands);
          }
          // Everything in the range that was not listed carried no commands.
          // Materialize those as empty frames so the scheduler can advance
          // through them instead of stalling on a gap that is not one.
          fillEmptyHistoryFrames(message.fromFrame, message.throughFrame, message.frames);
          catchUp?.setTargetFrame(message.throughFrame);
        }
        break;

      case 'lockstepResyncRequest':
        if (isFrameCoordinator && network !== undefined) {
          // Answered on the CONNECTION it arrived on, not by the stamped
          // seat: a watcher catching up is exactly a peer asking for history,
          // and it holds no seat to be addressed by.
          const fromFrame = Math.max(0, message.fromFrame);
          const resent = network.getLockstepTransport().resendCommandFramesAfterToMember(
            fromFrame - 1,
            from.memberId,
            LOCKSTEP_COORDINATOR_RESEND_FRAME_LIMIT,
          );
          frameResendCount += resent;
          if (resent === 0) {
            console.warn('[LOCKSTEP] resync request could not resend command frames', {
              fromMemberId: from.memberId,
              fromPlayerId,
              fromFrame,
              reason: message.reason,
              lockstepNetwork: network.getLockstepTransport().getDiagnostics(),
              sendBudget: network.getSendBudgetTelemetry(),
            });
          }
        }
        break;
      default:
        break;
    }
  };

  const scheduleCommand = (
    command: Command,
    fromPlayerId: PlayerId | undefined,
  ): boolean => {
    const diagnostics = scheduler.getDiagnostics();
    if (diagnostics.status === 'desynced') {
      throw new Error(
        `[LOCKSTEP] refusing command ${command.type} while desynced: ${diagnostics.message}`,
      );
    }
    if (diagnostics.status === 'protocol-paused' && command.type !== 'setPaused') {
      throw new Error(
        `[LOCKSTEP] refusing command ${command.type} while protocol-paused: ${diagnostics.message}`,
      );
    }
    const category = classifyCommandForArchitecture(command);
    if (category === 'local-presentation') {
      if (command.type === 'select') {
        const world = lockstepCore.world;
        if (!command.additive) world.clearSelection();
        world.selectEntities(command.entityIds);
        return true;
      }
      if (command.type === 'clearSelection') {
        lockstepCore.world.clearSelection();
        return true;
      }
      server.receiveCommand(command, { mode: 'host-admin' });
      return true;
    }
    // A WATCHER holds no seat, so it owns nothing and can author no gameplay
    // truth. Refused here, at the doorway, rather than downstream: a command
    // that never enters the stream cannot be executed by mistake, and that is
    // what makes "a spectator can never affect the match" structural instead
    // of a rule spread across the authorizer.
    if (fromPlayerId === undefined) {
      if (category === 'gameplay-truth' || category === 'architecture-control') {
        return true;
      }
      server.receiveCommand(command, { mode: 'spectator', playerId: undefined });
      return true;
    }

    if (category === 'architecture-control') {
      if (command.type === 'setPaused') {
        const frame = diagnostics.nextFrame;
        if (command.paused) {
          scheduler.pause(frame, 'local pause command');
          network?.getLockstepTransport().broadcastPause(
            frame,
            'local pause command',
          );
        } else {
          scheduler.resume(frame);
          network?.getLockstepTransport().broadcastResume(frame);
        }
        return true;
      }
      server.receiveCommand(command, { mode: 'host-admin' });
      return true;
    }

    try {
      const envelope = createLockstepCommandEnvelope({
        gameId,
        currentKnownFrame: diagnostics.nextFrame,
        playerId: fromPlayerId,
        playerSequence: nextLocalPlayerSequence++,
        inputDelayTicks: lockstepInputDelayTicks,
        command,
      });
      if (isFrameCoordinator) {
        enqueueCoordinatorCommandEnvelope(envelope);
      } else {
        const sent = network?.getLockstepTransport().sendCommand(envelope) ?? false;
        if (!sent) {
          throw new Error(
            `[LOCKSTEP] failed to send command envelope to coordinator: ` +
              `player=${fromPlayerId}, sequence=${envelope.playerSequence}, ` +
              `executeFrame=${envelope.executeFrame}, command=${command.type}`,
          );
        }
      }
    } catch (err) {
      throw new Error(
        `[LOCKSTEP] rejected command ${command.type} from player ${fromPlayerId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  };

  const localConnection = createLocalRealBattleConnection(
    server,
    localPlayerId,
    networkRole === null ? 'local-offline' : 'player',
    {
      commandDoorway: scheduleCommand,
      // Lockstep snapshots are local presentation data; the canonical
      // multiplayer truth is the command-frame stream. Local presentation
      // requests direct typed snapshot materialization so high-count deltas
      // can skip DTO churn; full/detail rows still decode when compatibility
      // views need entity creation data.
      loopbackSnapshotsThroughWire: false,
      recordSnapshotWireCost: false,
      directLocalSnapshotMaterialization: true,
      sharesAuthoritativeState: true,
    },
  );

  /**
   * Replay a slice of the match's past.
   *
   * Runs instead of the ordinary real-time pump while this peer is catching
   * up. Bounded by TIME rather than frame count because frame cost varies by
   * two orders of magnitude between an empty opening and a thousand live
   * units, and because the loading overlay has to keep painting.
   *
   * The one and only simulation this runtime owns is the one being replayed —
   * there is no second sim booted alongside the real one and promoted later.
   */
  const pumpCatchUp = (): void => {
    if (catchUp === null) return;
    if (catchUp.state === 'failed' || catchUp.state === 'live') return;

    if (catchUp.state === 'replaying') {
      const deadline = performance.now() + LOCKSTEP_CATCH_UP_BUDGET_MS;
      scheduler.advanceReadyFrames(LOCKSTEP_MAX_PUMP_ADVANCE_FRAMES, deadline);
      // Ask for anything the archive has not delivered yet. A watcher holds no
      // seat, so this is the one lockstep send it makes.
      requestMissingCommandFrameIfNeeded();
    }

    const progress = catchUp.report(scheduler.getDiagnostics().nextFrame);
    onCatchUpProgress?.(progress);

    if (progress.state === 'verifying') {
      // The gate. A replay that does not agree with the coordinator is a
      // desync; joining anyway would spread it, so this fails loudly instead.
      const local = desyncMonitor?.getLatestLocalChecksum() ?? null;
      const expected = resume?.verifyStateHash ?? null;
      const expectedFrame = resume?.verifyFrame ?? -1;
      if (expected === null || expectedFrame < 0) {
        // The coordinator had not produced a checksum yet — a very young
        // match. Nothing to compare against, so nothing to refuse on.
        catchUp.verified();
      } else if (local !== null && local.frame === expectedFrame) {
        if (local.stateHash.hash === expected.hash) {
          catchUp.verified();
        } else {
          catchUp.fail('state-mismatch');
          console.error('[LOCKSTEP] catch-up state mismatch at frame', expectedFrame, {
            local: local.stateHash.hash,
            coordinator: expected.hash,
            sectionDiffs: diffCanonicalHashSections(local.stateHash, expected),
          });
        }
      } else {
        // Our checksum for that frame has not been produced yet; keep
        // stepping until it is.
        catchUp.verified();
      }
      onCatchUpProgress?.(catchUp.getProgress());
    }

    // Re-read rather than reusing `progress`: verification above may have just
    // moved us across the line, and this is the one pump where that happens.
    if (catchUp.getProgress().state === 'live') {
      // From here the ordinary pump takes over and the client renders. A
      // seated rejoiner also re-enters the completion set, which is what lifts
      // the pause the coordinator was holding for it.
      if (localPlayerId !== undefined) scheduler.markPeerReady(localPlayerId);
      resetLockstepCommandPumpClock();
      server.startLockstepPresentation();
      onCatchUpProgress?.(catchUp.getProgress());
    }
  };

  const pumpFrame = (): void => {
    // A peer still replaying its way in does not step in real time: it runs as
    // fast as its budget allows, and renders nothing until it arrives.
    if (catchUp !== null && catchUp.state !== 'live') {
      pumpCatchUp();
      return;
    }
    // Before any early return below: a stalled coordinator is exactly when
    // players most need to see who everyone is waiting for.
    broadcastPeerFrameReport();
    const diagnostics = scheduler.getDiagnostics();
    if (diagnostics.status === 'protocol-paused' || diagnostics.status === 'desynced') {
      resetLockstepCommandPumpClock();
      return;
    }
    if (isFrameCoordinator) {
      if (isOnlineLockstep && !hasAllRequiredLockstepPeersReady()) {
        resetLockstepCommandPumpClock();
        resendCommandFramesToLaggingPeers();
        return;
      }
      const wallClockFrames = takeLockstepCommandFrameBudget();
      // The wall clock says how many frames a second of real time is worth;
      // flow control says how many of those the slowest SEATED player can
      // actually keep up with. Lockstep runs at the speed of its slowest
      // participant, and this is where that becomes true rather than a
      // comment.
      const flow = applyLockstepFlowControl(diagnostics.nextFrame, wallClockFrames);
      const frameBudget = flow.allowedFrames;
      if (frameBudget <= 0) {
        resendCommandFramesToLaggingPeers();
        requestMissingCommandFrameIfNeeded();
        return;
      }
      const startFrame = diagnostics.nextFrame;
      const frameBatch: {
        frame: number;
        frameSequence: number;
        commands: readonly LockstepCommandEnvelope[];
      }[] = [];
      for (let offset = 0; offset < frameBudget; offset++) {
        const frame = startFrame + offset;
        const commands = pendingCommandsByFrame.get(frame) ?? [];
        const frameSequence = nextFrameSequence++;
        pendingCommandsByFrame.delete(frame);
        if (isOnlineLockstep) {
          frameBatch.push({ frame, frameSequence, commands });
        }
        broadcastCommandFrameCount++;
        // Archived BEFORE it is executed, so a joiner admitted during this
        // pump is served a history that already contains it.
        commandArchive.append(frame, frameSequence, commands);
        receiveCoordinatorCommandFrame(
          frame,
          frameSequence,
          commands,
        );
      }
      if (frameBatch.length > 0) {
        network?.getLockstepTransport().broadcastCommandFrameBatch(frameBatch);
      }
    }
    const advanceResult = scheduler.advanceReadyFrames(LOCKSTEP_MAX_PUMP_ADVANCE_FRAMES);
    if (advanceResult.advancedFrames > 0) {
      const nowMs = performance.now();
      const elapsedMs = lastLockstepTelemetryPumpMs === null
        ? advanceResult.advancedFrames * lockstepFixedDtMs
        : Math.max(0.001, nowMs - lastLockstepTelemetryPumpMs);
      lastLockstepTelemetryPumpMs = nowMs;
      const postAdvanceDiagnostics = scheduler.getDiagnostics();
      server.recordExternalSimulationTelemetry({
        elapsedMs,
        stepsRun: advanceResult.advancedFrames,
        workMs: postAdvanceDiagnostics.performance.simStepMsAvg,
        tickRateHz: simulationTickRateHz,
      });

      // Lockstep snapshots are local presentation only. Gate them separately
      // from command-frame simulation so full-state serialization cannot cap
      // render cadence or command-frame catch-up under high unit counts.
      if (nowMs - lastLockstepPresentationSnapshotMs >= lockstepPresentationSnapshotIntervalMs) {
        const snapshotStartMs = performance.now();
        const didEmitSnapshot = server.emitLockstepPresentationSnapshot();
        lastLockstepPresentationSnapshotMs = snapshotStartMs;
        if (didEmitSnapshot) recordSnapshotMs('rich', performance.now() - snapshotStartMs);
      } else {
        const snapshotStartMs = performance.now();
        if (server.emitLockstepProjectileDeltaSnapshotIfNeeded()) {
          recordSnapshotMs('delta', performance.now() - snapshotStartMs);
        }
      }
    }
    resendCommandFramesToLaggingPeers();
    requestMissingCommandFrameIfNeeded();
    pumpHistoryStreams();
  };

  return {
    server,
    allyTeamByPlayerId: matchContext.allyTeamByPlayerId,
    allyTeamCount: matchContext.allyTeamCount,
    gameConnection: localConnection,
    start() {
      applyStoredBattleServerSettings(server, 'real', {
        ipAddress: localIpAddress,
        entityCountCap: initialEntityCountCap,
        fogOfWarEnabled: true,
        slowDownAtFinalWaypoint:
          matchContext.settings.slowDownAtFinalWaypoint ?? false,
        metalCoverage:
          matchContext.settings.metalCoverage ?? terrain.metalCoverage,
        liquidSurfaceMode:
          matchContext.settings.liquidSurfaceMode ?? terrain.liquidSurfaceMode,
      });
      if (localPlayerId !== undefined) scheduler.markPeerReady(localPlayerId);
      if (catchUp !== null && resume !== undefined) {
        // Replaying in: the live stream is already being unicast to us and
        // piles up in the scheduler while the archive arrives behind it. One
        // queue, no second buffer.
        catchUp.grant(resume.grantFrame, scheduler.getDiagnostics().nextFrame);
        onCatchUpProgress?.(catchUp.getProgress());
      }
      if (network !== undefined) {
        network.onLockstepMessage = handleLockstepMessage;
        const startFrame = scheduler.getDiagnostics().nextFrame;
        network.getLockstepTransport().sendHello(
          initializationHash,
          startFrame,
        );
        network.getLockstepTransport().sendReady(
          initializationHash,
          startFrame,
        );
      }
      const snapshotStartMs = performance.now();
      server.startLockstepPresentation();
      recordSnapshotMs('rich', performance.now() - snapshotStartMs);
      lastLockstepPresentationSnapshotMs = performance.now();
      pumpTimer = setInterval(pumpFrame, lockstepFixedDtMs);
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        browserResumePumpHandler = () => {
          if (document.visibilityState === 'visible') pumpFrame();
        };
        document.addEventListener('visibilitychange', browserResumePumpHandler);
        window.addEventListener('focus', browserResumePumpHandler);
        window.addEventListener('pageshow', browserResumePumpHandler);
        window.addEventListener('online', browserResumePumpHandler);
      }
    },
    stop() {
      if (pumpTimer !== null) {
        clearInterval(pumpTimer);
        pumpTimer = null;
      }
      if (
        browserResumePumpHandler !== null &&
        typeof window !== 'undefined' &&
        typeof document !== 'undefined'
      ) {
        document.removeEventListener('visibilitychange', browserResumePumpHandler);
        window.removeEventListener('focus', browserResumePumpHandler);
        window.removeEventListener('pageshow', browserResumePumpHandler);
        window.removeEventListener('online', browserResumePumpHandler);
        browserResumePumpHandler = null;
      }
      if (network !== undefined && network.onLockstepMessage === handleLockstepMessage) {
        network.onLockstepMessage = previousLockstepHandler;
      }
      localConnection.disconnect();
      server.stop();
    },
    getDiagnostics() {
      return {
        networkRole,
        lockstepSupport: LOCKSTEP_SUPPORT_BOUNDARIES,
        lockstepInputDelayTicks,
        lockstepInitializationHash: initializationHash,
        lockstepGameId: matchContext.gameId,
        lockstepRoomCode: matchContext.roomCode,
        lockstepCoordinatorPlayerId: matchContext.hostPlayerId,
        lockstepReadyPlayerIds: [...readyPlayerIds].sort((a, b) => a - b),
        lockstepRequiredReadyPlayerIds: [...requiredReadyPlayerIds].sort((a, b) => a - b),
        lockstepFixedStepHz: simulationTickRateHz,
        lockstepChecksumIntervalTicks,
        lockstepChecksums: desyncMonitor?.getDiagnostics(),
        lockstepNetwork: network?.getLockstepTransport().getDiagnostics() ?? null,
        lockstepPendingNetworkMessages:
          network?.getPendingLockstepMessageDiagnostics() ?? null,
        lockstepFrameResendCount: frameResendCount,
        lockstepResyncRequestCount: resyncRequestCount,
        lockstepReceivedCommandFrameCount: receivedCommandFrameCount,
        lockstepBroadcastCommandFrameCount: broadcastCommandFrameCount,
        lockstepPerformanceBudget:
          createLockstepPerformanceBudget(simulationTickRateHz),
        lockstepSnapshotPerformance: {
          snapshotMsAvg: totalSnapshotTiming.snapshotMsAvg,
          snapshotMsHi: totalSnapshotTiming.snapshotMsHi,
          snapshotsEmitted: totalSnapshotTiming.snapshotsEmitted,
          rich: {
            snapshotMsAvg: richSnapshotTiming.snapshotMsAvg,
            snapshotMsHi: richSnapshotTiming.snapshotMsHi,
            snapshotsEmitted: richSnapshotTiming.snapshotsEmitted,
          },
          delta: {
            snapshotMsAvg: deltaSnapshotTiming.snapshotMsAvg,
            snapshotMsHi: deltaSnapshotTiming.snapshotMsHi,
            snapshotsEmitted: deltaSnapshotTiming.snapshotsEmitted,
          },
        },
        lockstepFlowControl: flowControl.getDiagnostics(),
        lockstepResignedPlayerIds: [...resignedPlayerIds].sort((a, b) => a - b),
        // The archive's size is reported rather than left to be discovered as
        // a memory problem in a long match.
        lockstepCommandArchive: commandArchive.getDiagnostics(),
        lockstepHistoryStreams: historyStreams.size,
        lockstepCatchUp: catchUp?.getProgress() ?? null,
        desyncReport: desyncMonitor?.getReport() ?? null,
        lockstep: scheduler.getDiagnostics(),
      };
    },
  };
}

export async function createRealBattleBackend(
  options: CreateRealBattleBackendOptions,
): Promise<RealBattleBackendRuntime> {
  // BAR/Recoil architecture: every peer advances the same deterministic
  // fixed-step simulation locally and renders adjacent local tick states.
  return createDeterministicLockstepBackend(options);
}
