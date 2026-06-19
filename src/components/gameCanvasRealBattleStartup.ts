import { getMapSize } from '../config';
import { ARCHITECTURE_CONFIG } from '../architectureConfig';
import {
  loadStoredConverterTax,
  loadStoredMapLandDimensions,
  loadStoredRealCap,
  loadStoredTerrainMapShape,
  loadStoredTerrainRuntimeConfig,
  type BattleTerrainRuntimeConfig,
} from '../battleBarConfig';
import {
  setTerrainCenterMagnitude,
  setTerrainDividersMagnitude,
  setTerrainMapShape,
  setTerrainRuntimeConfig,
} from '../game/sim/Terrain';
import { GameServer } from '../game/server/GameServer';
import { assertDeterministicLockstepRuntimeReady } from '../game/architecture/DeterministicLockstepRuntimeGuards';
import {
  LockstepFrameScheduler,
  LOCKSTEP_FIXED_DT_MS,
  LOCKSTEP_FIXED_STEP_HZ,
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
  LOCKSTEP_PERFORMANCE_BUDGET,
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
  buildStoredBattleServerSettingCommands,
} from '../game/server/battleServerSettings';
import { WorkerGameServerConnection } from '../game/server/WorkerGameServerConnection';
import { isTauriRuntime } from '../browserRuntime';
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
import type { MapLandCellDimensions } from '../mapSizeConfig';
import type { TerrainMapShape } from '../types/terrain';

export type RealBattleStartupTerrain = {
  terrainMapShape: TerrainMapShape;
  terrainRuntimeConfig: BattleTerrainRuntimeConfig;
  mapDimensions: MapLandCellDimensions;
  mapSize: { width: number; height: number };
};

export type CreateRealBattleServerOptions = {
  playerIds: PlayerId[];
  aiPlayerIds?: PlayerId[];
  terrain: RealBattleStartupTerrain;
  converterTax?: number;
  onLoadingProgress?: (progress: number, phase?: string) => void | Promise<void>;
};

export type RealBattleBackendDiagnostics = {
  networkRole: NetworkRole | null;
  threadedServer?: {
    readonly enabled: boolean;
    readonly transport: 'worker';
    readonly snapshotsDecoded: number;
    readonly pendingRequests: number;
  };
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
  lockstepSnapshotPerformance?: LockstepSnapshotPerformanceTelemetry;
  desyncReport?: LockstepDesyncReport | null;
  lockstep?: LockstepFrameSchedulerDiagnostics;
};

export type RealBattleBackendRuntime = {
  readonly server: GameServer | null;
  readonly ownsServer?: boolean;
  readonly gameConnection: GameConnection;
  start(): void;
  stop(): void;
  getDiagnostics(): RealBattleBackendDiagnostics;
};

export type CreateRealBattleBackendOptions = {
  playerIds: PlayerId[];
  aiPlayerIds?: PlayerId[];
  terrain: RealBattleStartupTerrain;
  networkRole: NetworkRole | null;
  localPlayerId: PlayerId;
  localIpAddress: string;
  network?: NetworkManager;
  battleHandoff?: BattleHandoff;
  onLoadingProgress?: (progress: number, phase?: string) => void | Promise<void>;
};

type RealBattleMatchContext = {
  readonly gameId: string;
  readonly roomCode: string;
  readonly hostPlayerId: PlayerId;
  readonly settings: LobbySettings;
  readonly initializationHash: string;
};

type CreateRealBattleMatchContextOptions = {
  readonly playerIds: readonly PlayerId[];
  readonly aiPlayerIds: readonly PlayerId[] | undefined;
  readonly terrain: RealBattleStartupTerrain;
  readonly localPlayerId: PlayerId;
  readonly networkRole: NetworkRole | null;
  readonly network: NetworkManager | undefined;
  readonly battleHandoff: BattleHandoff | undefined;
  readonly requireHandoff: boolean;
  readonly contextLabel: string;
};

const LOCKSTEP_COORDINATOR_RESEND_INTERVAL_MS = 250;
const LOCKSTEP_COORDINATOR_RESEND_FRAME_LIMIT = 300;
const LOCKSTEP_CLIENT_RESYNC_REQUEST_INTERVAL_MS = 500;
const LOCKSTEP_MAX_PUMP_ADVANCE_FRAMES = 300;

export function loadAndApplyRealBattleTerrain(): RealBattleStartupTerrain {
  const terrainMapShape = loadStoredTerrainMapShape('real');
  const terrainRuntimeConfig = loadStoredTerrainRuntimeConfig('real');
  const mapDimensions = loadStoredMapLandDimensions('real');
  const mapSize = getMapSize(
    false,
    mapDimensions.widthLandCells,
    mapDimensions.lengthLandCells,
  );
  setTerrainRuntimeConfig(terrainRuntimeConfig);
  setTerrainCenterMagnitude(terrainRuntimeConfig.centerMagnitude);
  setTerrainDividersMagnitude(terrainRuntimeConfig.dividersMagnitude);
  setTerrainMapShape(terrainMapShape);
  return {
    terrainMapShape,
    terrainRuntimeConfig,
    mapDimensions,
    mapSize,
  };
}

function buildRealBattleLobbySettingsFromTerrain(
  terrain: RealBattleStartupTerrain,
): LobbySettings {
  return {
    centerMagnitude: terrain.terrainRuntimeConfig.centerMagnitude,
    dividersMagnitude: terrain.terrainRuntimeConfig.dividersMagnitude,
    terrainMapShape: terrain.terrainMapShape,
    terrainDTerrain: terrain.terrainRuntimeConfig.terrainDTerrain,
    metalDepositStep: terrain.terrainRuntimeConfig.metalDepositStep,
    terrainDetail: terrain.terrainRuntimeConfig.terrainDetail,
    mapWidthLandCells: terrain.mapDimensions.widthLandCells,
    mapLengthLandCells: terrain.mapDimensions.lengthLandCells,
    maxTotalUnits: loadStoredRealCap(),
    converterTax: loadStoredConverterTax('real'),
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
    if (requireHandoff && battleHandoff.settings === undefined) {
      throw new Error(
        `[${contextLabel}] deterministic-lockstep handoff is missing lobby settings. ` +
          'Lockstep cannot safely start from per-browser stored settings.',
      );
    }
    const settings = battleHandoff.settings ?? fallbackSettings;
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
      aiPlayerIds: battleHandoff.initialization.aiPlayerIds,
      settings,
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
      initializationHash: battleHandoff.initializationHash,
    };
  }

  const gameId = networkRole === null || network === undefined
    ? `local-lockstep:${playerIds.join(',')}:${terrain.mapSize.width}x${terrain.mapSize.height}`
    : network.getUniversalGameId();
  const roomCode = networkRole === null || network === undefined
    ? 'local-lockstep'
    : network.getRoomCode();
  const hostPlayerId = playerIds[0] ?? localPlayerId;
  const initialization = buildCanonicalMatchInitialization({
    gameId,
    roomCode,
    hostPlayerId,
    playerIds,
    aiPlayerIds,
    settings: fallbackSettings,
  });
  return {
    gameId,
    roomCode,
    hostPlayerId,
    settings: fallbackSettings,
    initializationHash: hashCanonicalMatchInitialization(initialization),
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
  pushMismatch(mismatches, 'dividersMagnitude', terrain.terrainRuntimeConfig.dividersMagnitude, settings.dividersMagnitude);
  pushMismatch(mismatches, 'terrainMapShape', terrain.terrainMapShape, settings.terrainMapShape);
  pushMismatch(mismatches, 'terrainDTerrain', terrain.terrainRuntimeConfig.terrainDTerrain, settings.terrainDTerrain);
  pushMismatch(mismatches, 'metalDepositStep', terrain.terrainRuntimeConfig.metalDepositStep, settings.metalDepositStep);
  pushMismatch(mismatches, 'terrainDetail', terrain.terrainRuntimeConfig.terrainDetail, settings.terrainDetail);
  pushMismatch(mismatches, 'mapWidthLandCells', terrain.mapDimensions.widthLandCells, settings.mapWidthLandCells);
  pushMismatch(mismatches, 'mapLengthLandCells', terrain.mapDimensions.lengthLandCells, settings.mapLengthLandCells);
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
  aiPlayerIds,
  terrain,
  converterTax,
  onLoadingProgress,
}: CreateRealBattleServerOptions): Promise<GameServer> {
  return GameServer.create(
    {
      playerIds,
      aiPlayerIds,
      centerMagnitude: terrain.terrainRuntimeConfig.centerMagnitude,
      dividersMagnitude: terrain.terrainRuntimeConfig.dividersMagnitude,
      terrainMapShape: terrain.terrainMapShape,
      terrainDTerrain: terrain.terrainRuntimeConfig.terrainDTerrain,
      metalDepositStep: terrain.terrainRuntimeConfig.metalDepositStep,
      terrainDetail: terrain.terrainRuntimeConfig.terrainDetail,
      mapWidthLandCells: terrain.mapDimensions.widthLandCells,
      mapLengthLandCells: terrain.mapDimensions.lengthLandCells,
      converterTax: converterTax ?? loadStoredConverterTax('real'),
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
  onLoadingProgress,
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
    aiPlayerIds,
    terrain,
    converterTax: matchContext.settings.converterTax,
    onLoadingProgress,
  });
  const lockstepCore = server.getLockstepSimulationCore();
  const pendingCommandsByFrame = new Map<number, LockstepCommandEnvelope[]>();
  const isOnlineLockstep = networkRole !== null && network !== undefined;
  const isFrameCoordinator = networkRole !== 'client';
  const gameId = matchContext.gameId;
  const initializationHash = matchContext.initializationHash;
  const initialMaxTotalUnits = matchContext.settings.maxTotalUnits ?? loadStoredRealCap();
  let nextLocalPlayerSequence = 0;
  let nextFrameSequence = 0;
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let browserResumePumpHandler: (() => void) | null = null;
  let desyncMonitor: LockstepDesyncMonitor | null = null;
  const requiredReadyPlayerIds = new Set<PlayerId>(isOnlineLockstep ? playerIds : [localPlayerId]);
  const readyPlayerIds = new Set<PlayerId>([localPlayerId]);
  let broadcastCommandFrameCount = 0;
  let receivedCommandFrameCount = 0;
  let frameResendCount = 0;
  let resyncRequestCount = 0;
  let lastCoordinatorResendMs = Number.NEGATIVE_INFINITY;
  let lastClientResyncRequestMs = Number.NEGATIVE_INFINITY;
  let lastClientResyncRequestFrame: number | null = null;
  let snapshotMsAvg = 0;
  let snapshotMsHi = 0;
  let snapshotMsInitialized = false;
  let snapshotsEmitted = 0;
  let lastLockstepTelemetryPumpMs: number | null = null;
  let lastLockstepCommandPumpMs: number | null = null;
  let lockstepCommandPumpAccumulatorMs = LOCKSTEP_FIXED_DT_MS;
  const recordSnapshotMs = (sampleMs: number): void => {
    const sample = Number.isFinite(sampleMs) && sampleMs >= 0 ? sampleMs : 0;
    snapshotsEmitted++;
    if (!snapshotMsInitialized) {
      snapshotMsAvg = sample;
      snapshotMsHi = sample;
      snapshotMsInitialized = true;
      return;
    }
    snapshotMsAvg = snapshotMsAvg * 0.95 + sample * 0.05;
    snapshotMsHi = sample > snapshotMsHi
      ? snapshotMsHi * 0.5 + sample * 0.5
      : snapshotMsHi * 0.995 + sample * 0.005;
  };

  const scheduler = new LockstepFrameScheduler({
    core: lockstepCore,
    expectedPlayerIds: playerIds,
    nowMs: () => performance.now(),
    onChecksum: ({ frame, stateHash }) => {
      desyncMonitor?.recordChecksum({ playerId: localPlayerId, frame, stateHash });
      network?.getLockstepTransport().sendChecksum(frame, stateHash);
    },
  });
  desyncMonitor = new LockstepDesyncMonitor({
    localPlayerId,
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
      ARCHITECTURE_CONFIG.lockstep.inputDelayTicks;
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
    lockstepCommandPumpAccumulatorMs = LOCKSTEP_FIXED_DT_MS;
  };

  const takeLockstepCommandFrameBudget = (): number => {
    const nowMs = performance.now();
    const elapsedMs = lastLockstepCommandPumpMs === null
      ? 0
      : Math.max(0, nowMs - lastLockstepCommandPumpMs);
    lastLockstepCommandPumpMs = nowMs;
    lockstepCommandPumpAccumulatorMs = Math.min(
      lockstepCommandPumpAccumulatorMs + elapsedMs,
      LOCKSTEP_FIXED_DT_MS * LOCKSTEP_MAX_PUMP_ADVANCE_FRAMES,
    );
    const frames = Math.min(
      LOCKSTEP_MAX_PUMP_ADVANCE_FRAMES,
      Math.floor(lockstepCommandPumpAccumulatorMs / LOCKSTEP_FIXED_DT_MS),
    );
    lockstepCommandPumpAccumulatorMs = Math.max(
      0,
      lockstepCommandPumpAccumulatorMs - frames * LOCKSTEP_FIXED_DT_MS,
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
  const handleLockstepMessage: NonNullable<NetworkManager['onLockstepMessage']> = (message, fromPlayerId) => {
    previousLockstepHandler?.(message, fromPlayerId);
    switch (message.type) {
      case 'lockstepHello':
        if (message.initializationHash !== initializationHash) {
          reportInitializationMismatch(fromPlayerId, message.initializationHash);
          break;
        }
        markLockstepPeerReady(message.playerId);
        break;
      case 'lockstepReady':
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
      case 'lockstepResyncRequest':
        if (isFrameCoordinator && network !== undefined) {
          const fromFrame = Math.max(0, message.fromFrame);
          const resent = network.getLockstepTransport().resendCommandFramesAfter(
            fromFrame - 1,
            fromPlayerId,
            LOCKSTEP_COORDINATOR_RESEND_FRAME_LIMIT,
          );
          frameResendCount += resent;
          if (resent === 0) {
            console.warn('[LOCKSTEP] resync request could not resend command frames', {
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

  const scheduleCommand = (command: Command, fromPlayerId: PlayerId): boolean => {
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
      if (command.type === 'ping') return true;
      server.receiveCommand(command, { mode: 'host-admin' });
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
      // Lockstep snapshots are presentation data; the canonical
      // multiplayer truth is the command-frame stream. Decode snapshots
      // through the wire boundary so client presentation never shares
      // mutable objects with the local server simulation, while keeping
      // the economy singleton owned by the local server.
      loopbackSnapshotsThroughWire: true,
      sharesAuthoritativeState: true,
    },
  );

  const pumpFrame = (): void => {
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
      const frameBudget = takeLockstepCommandFrameBudget();
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
        ? advanceResult.advancedFrames * LOCKSTEP_FIXED_DT_MS
        : Math.max(0.001, nowMs - lastLockstepTelemetryPumpMs);
      lastLockstepTelemetryPumpMs = nowMs;
      const postAdvanceDiagnostics = scheduler.getDiagnostics();
      server.recordExternalSimulationTelemetry({
        elapsedMs,
        stepsRun: advanceResult.advancedFrames,
        workMs: postAdvanceDiagnostics.performance.simStepMsAvg,
        tickRateHz: LOCKSTEP_FIXED_STEP_HZ,
      });

      // Lockstep snapshots are local presentation only. Emit one after catch-up
      // instead of one per fixed sim frame so serialization cannot cap sim rate.
      const snapshotStartMs = performance.now();
      server.emitLockstepPresentationSnapshot();
      recordSnapshotMs(performance.now() - snapshotStartMs);
    }
    resendCommandFramesToLaggingPeers();
    requestMissingCommandFrameIfNeeded();
  };

  return {
    server,
    gameConnection: localConnection,
    start() {
      applyStoredBattleServerSettings(server, 'real', {
        ipAddress: localIpAddress,
        maxTotalUnits: initialMaxTotalUnits,
        fogOfWarEnabled: true,
      });
      scheduler.markPeerReady(localPlayerId);
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
      server.startLockstepPresentation();
      pumpTimer = setInterval(pumpFrame, LOCKSTEP_FIXED_DT_MS);
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
        lockstepInputDelayTicks: ARCHITECTURE_CONFIG.lockstep.inputDelayTicks,
        lockstepInitializationHash: initializationHash,
        lockstepGameId: matchContext.gameId,
        lockstepRoomCode: matchContext.roomCode,
        lockstepCoordinatorPlayerId: matchContext.hostPlayerId,
        lockstepReadyPlayerIds: [...readyPlayerIds].sort((a, b) => a - b),
        lockstepRequiredReadyPlayerIds: [...requiredReadyPlayerIds].sort((a, b) => a - b),
        lockstepFixedStepHz: ARCHITECTURE_CONFIG.lockstep.fixedStepHz,
        lockstepChecksumIntervalTicks: ARCHITECTURE_CONFIG.lockstep.checksumIntervalTicks,
        lockstepChecksums: desyncMonitor?.getDiagnostics(),
        lockstepNetwork: network?.getLockstepTransport().getDiagnostics() ?? null,
        lockstepPendingNetworkMessages:
          network?.getPendingLockstepMessageDiagnostics() ?? null,
        lockstepFrameResendCount: frameResendCount,
        lockstepResyncRequestCount: resyncRequestCount,
        lockstepReceivedCommandFrameCount: receivedCommandFrameCount,
        lockstepBroadcastCommandFrameCount: broadcastCommandFrameCount,
        lockstepPerformanceBudget: LOCKSTEP_PERFORMANCE_BUDGET,
        lockstepSnapshotPerformance: {
          snapshotMsAvg,
          snapshotMsHi,
          snapshotsEmitted,
        },
        desyncReport: desyncMonitor?.getReport() ?? null,
        lockstep: scheduler.getDiagnostics(),
      };
    },
  };
}

export async function createRealBattleBackend(
  options: CreateRealBattleBackendOptions,
): Promise<RealBattleBackendRuntime> {
  if (shouldUseWorkerAuthoritativeBackend(options)) {
    try {
      return await createWorkerAuthoritativeBackendRuntime(options);
    } catch (error) {
      console.warn('[WorkerGameServer] falling back to main-thread backend:', error);
    }
  }
  return createDeterministicLockstepBackend(options);
}

function shouldUseWorkerAuthoritativeBackend(
  options: CreateRealBattleBackendOptions,
): boolean {
  return (
    options.networkRole === null &&
    typeof Worker !== 'undefined' &&
    isTauriRuntime()
  );
}

async function createWorkerAuthoritativeBackendRuntime({
  playerIds,
  aiPlayerIds,
  terrain,
  localPlayerId,
  localIpAddress,
  onLoadingProgress,
}: CreateRealBattleBackendOptions): Promise<RealBattleBackendRuntime> {
  const connection = await WorkerGameServerConnection.create({
    config: {
      playerIds,
      aiPlayerIds,
      centerMagnitude: terrain.terrainRuntimeConfig.centerMagnitude,
      dividersMagnitude: terrain.terrainRuntimeConfig.dividersMagnitude,
      terrainMapShape: terrain.terrainMapShape,
      terrainDTerrain: terrain.terrainRuntimeConfig.terrainDTerrain,
      metalDepositStep: terrain.terrainRuntimeConfig.metalDepositStep,
      terrainDetail: terrain.terrainRuntimeConfig.terrainDetail,
      mapWidthLandCells: terrain.mapDimensions.widthLandCells,
      mapLengthLandCells: terrain.mapDimensions.lengthLandCells,
      converterTax: loadStoredConverterTax('real'),
    },
    localPlayerId,
    commandAuthorityMode: 'local-offline',
    onProgress: onLoadingProgress,
  });
  const initialMaxTotalUnits = loadStoredRealCap();

  return {
    server: null,
    ownsServer: true,
    gameConnection: connection,
    start() {
      connection.setIpAddress(localIpAddress);
      for (const command of buildStoredBattleServerSettingCommands('real', {
        ipAddress: localIpAddress,
        maxTotalUnits: initialMaxTotalUnits,
        fogOfWarEnabled: true,
      })) {
        connection.sendHostCommand(command);
      }
      void connection.startServer();
    },
    stop() {
      connection.disconnect();
    },
    getDiagnostics() {
      const diagnostics = connection.getDiagnostics();
      return {
        networkRole: null,
        threadedServer: {
          enabled: true,
          transport: 'worker',
          snapshotsDecoded: diagnostics.snapshotsDecoded,
          pendingRequests: diagnostics.pendingRequests,
        },
      };
    },
  };
}
