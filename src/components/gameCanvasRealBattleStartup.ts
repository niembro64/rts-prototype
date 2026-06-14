import { getMapSize } from '../config';
import {
  ARCHITECTURE_CONFIG,
  ARCHITECTURE_CONFIG_READ_MODE,
  assertNeverArchitecture,
  type ArchitectureBackend,
} from '../architectureConfig';
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
import { RemoteGameConnection } from '../game/server/RemoteGameConnection';
import { applyStoredBattleServerSettings } from '../game/server/battleServerSettings';
import type { NetworkManager, NetworkRole } from '../game/network/NetworkManager';
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
  onLoadingProgress?: (progress: number, phase?: string) => void | Promise<void>;
};

export type StartRealBattleServerOptions = {
  ipAddress: string;
};

export type RealBattleBackendDiagnostics = {
  architecture: ArchitectureBackend;
  architectureConfigReadMode: typeof ARCHITECTURE_CONFIG_READ_MODE;
  networkRole: NetworkRole | null;
  hasLocalServer: boolean;
  renderConnection: 'local' | 'remote';
  snapshotSource: 'local' | 'remote';
  snapshotTruth:
    | 'authoritative-server'
    | 'command-frame-stream-local-presentation';
  snapshotWireMode:
    | 'direct-in-memory'
    | 'wire-loopback'
    | 'network-wire';
  remoteSnapshotComparison: 'disabled' | 'enabled';
  lockstepSupport?: LockstepSupportBoundaries;
  lockstepInputDelayTicks?: number;
  lockstepInitializationHash?: string;
  lockstepChecksums?: LockstepChecksumDiagnostics;
  lockstepNetwork?: NetworkLockstepTransportDiagnostics | null;
  lockstepPerformanceBudget?: LockstepPerformanceBudget;
  lockstepSnapshotPerformance?: LockstepSnapshotPerformanceTelemetry;
  desyncReport?: LockstepDesyncReport | null;
  lockstep?: LockstepFrameSchedulerDiagnostics;
};

export type RealBattleBackendRuntime = {
  readonly architecture: ArchitectureBackend;
  readonly server: GameServer | null;
  readonly gameConnection: GameConnection;
  readonly startupGateRequiresServer: boolean;
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
  sendHostCommand?: (command: Command, fromPlayerId: PlayerId) => boolean;
  network?: NetworkManager;
  onLoadingProgress?: (progress: number, phase?: string) => void | Promise<void>;
};

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

export function createRemoteRealBattleConnection(): GameConnection {
  return new RemoteGameConnection();
}

export function createLocalRealBattleConnection(
  server: GameServer,
  localPlayerId: PlayerId | undefined,
  commandAuthorityMode: LocalCommandAuthorityMode = 'player',
  options: LocalGameConnectionOptions = {},
): GameConnection {
  return new LocalGameConnection(server, localPlayerId, commandAuthorityMode, options);
}

export async function createRealBattleServer({
  playerIds,
  aiPlayerIds,
  terrain,
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
      converterTax: loadStoredConverterTax('real'),
    },
    {
      onProgress: onLoadingProgress,
    },
  );
}

export function applySettingsAndStartRealBattleServer(
  server: GameServer,
  options: StartRealBattleServerOptions,
): void {
  applyStoredBattleServerSettings(server, 'real', {
    ipAddress: options.ipAddress,
    maxTotalUnits: loadStoredRealCap(),
    // Real battles always run with fog of war on, regardless of any
    // lingering 'real-battle-fog-of-war-enabled' storage value.
    fogOfWarEnabled: true,
  });
  server.start();
}

export async function createAuthoritativeServerBackend({
  playerIds,
  aiPlayerIds,
  terrain,
  networkRole,
  localPlayerId,
  localIpAddress,
  sendHostCommand,
  onLoadingProgress,
}: CreateRealBattleBackendOptions): Promise<RealBattleBackendRuntime> {
  if (networkRole === 'client') {
    const remoteConnection = createRemoteRealBattleConnection();
    return {
      architecture: 'authoritative-server',
      server: null,
      gameConnection: remoteConnection,
      startupGateRequiresServer: false,
      start() {},
      stop() {
        remoteConnection.disconnect();
      },
      getDiagnostics() {
        return {
          architecture: 'authoritative-server',
          architectureConfigReadMode: ARCHITECTURE_CONFIG_READ_MODE,
          networkRole,
          hasLocalServer: false,
          renderConnection: 'remote',
          snapshotSource: 'remote',
          snapshotTruth: 'authoritative-server',
          snapshotWireMode: 'network-wire',
          remoteSnapshotComparison: 'disabled',
        };
      },
    };
  }

  const server = await createRealBattleServer({
    playerIds,
    aiPlayerIds,
    terrain,
    onLoadingProgress,
  });
  const onlineHost = networkRole === 'host';
  const localConnection = createLocalRealBattleConnection(
    server,
    localPlayerId,
    networkRole === null ? 'local-offline' : 'player',
    {
      commandDoorway: onlineHost ? sendHostCommand : undefined,
      loopbackSnapshotsThroughWire: onlineHost,
    },
  );

  return {
    architecture: 'authoritative-server',
    server,
    gameConnection: localConnection,
    startupGateRequiresServer: onlineHost,
    start() {
      applySettingsAndStartRealBattleServer(server, {
        ipAddress: localIpAddress,
      });
    },
    stop() {
      localConnection.disconnect();
      server.stop();
    },
    getDiagnostics() {
      return {
        architecture: 'authoritative-server',
        architectureConfigReadMode: ARCHITECTURE_CONFIG_READ_MODE,
        networkRole,
        hasLocalServer: true,
        renderConnection: 'local',
        snapshotSource: 'local',
        snapshotTruth: 'authoritative-server',
        snapshotWireMode: onlineHost ? 'wire-loopback' : 'direct-in-memory',
        remoteSnapshotComparison: 'disabled',
      };
    },
  };
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
  onLoadingProgress,
}: CreateRealBattleBackendOptions): Promise<RealBattleBackendRuntime> {
  const server = await createRealBattleServer({
    playerIds,
    aiPlayerIds,
    terrain,
    onLoadingProgress,
  });
  const pendingCommandsByFrame = new Map<number, LockstepCommandEnvelope[]>();
  const gameId = `local-lockstep:${playerIds.join(',')}:${terrain.mapSize.width}x${terrain.mapSize.height}`;
  const initialMaxTotalUnits = loadStoredRealCap();
  const initializationHash = hashCanonicalMatchInitialization(buildCanonicalMatchInitialization({
    gameId,
    roomCode: 'local-lockstep',
    hostPlayerId: playerIds[0] ?? localPlayerId,
    playerIds,
    aiPlayerIds,
    settings: {
      centerMagnitude: terrain.terrainRuntimeConfig.centerMagnitude,
      dividersMagnitude: terrain.terrainRuntimeConfig.dividersMagnitude,
      terrainMapShape: terrain.terrainMapShape,
      terrainDTerrain: terrain.terrainRuntimeConfig.terrainDTerrain,
      metalDepositStep: terrain.terrainRuntimeConfig.metalDepositStep,
      terrainDetail: terrain.terrainRuntimeConfig.terrainDetail,
      mapWidthLandCells: terrain.mapDimensions.widthLandCells,
      mapLengthLandCells: terrain.mapDimensions.lengthLandCells,
      maxTotalUnits: initialMaxTotalUnits,
      converterTax: loadStoredConverterTax('real'),
    },
  }));
  let nextLocalPlayerSequence = 0;
  let nextFrameSequence = 0;
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let desyncMonitor: LockstepDesyncMonitor | null = null;
  let snapshotMsAvg = 0;
  let snapshotMsHi = 0;
  let snapshotMsInitialized = false;
  let snapshotsEmitted = 0;
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
    core: server.getLockstepSimulationCore(),
    expectedPlayerIds: playerIds,
    nowMs: () => performance.now(),
    onFrameAdvanced: () => {
      const snapshotStartMs = performance.now();
      server.emitLockstepPresentationSnapshot();
      recordSnapshotMs(performance.now() - snapshotStartMs);
    },
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
      network?.getLockstepTransport().broadcastDesync(
        report.frame,
        report.localHash,
        report.remotePlayerId,
        report.remoteHash,
      );
    },
  });
  const previousLockstepHandler = network?.onLockstepMessage;
  const handleLockstepMessage: NonNullable<NetworkManager['onLockstepMessage']> = (message, fromPlayerId) => {
    previousLockstepHandler?.(message, fromPlayerId);
    switch (message.type) {
      case 'lockstepChecksum':
        desyncMonitor?.recordChecksum({
          playerId: message.playerId,
          frame: message.frame,
          stateHash: message.stateHash,
        });
        break;
      case 'lockstepPause':
        scheduler.pause(message.frame, message.reason);
        break;
      case 'lockstepResume':
        scheduler.resume(message.resumeFrame);
        break;
      case 'lockstepDesync':
        scheduler.markDesynced(`peer ${fromPlayerId} reported desync at frame ${message.frame}`);
        break;
      default:
        break;
    }
  };

  const scheduleCommand = (command: Command, fromPlayerId: PlayerId): boolean => {
    const category = classifyCommandForArchitecture(command);
    if (category === 'local-presentation') {
      server.receiveCommand(command, { mode: 'host-admin' });
      return true;
    }
    if (category === 'architecture-control') {
      if (command.type === 'setPaused') {
        if (command.paused) {
          scheduler.pause(scheduler.getDiagnostics().nextFrame, 'local pause command');
        } else {
          scheduler.resume(scheduler.getDiagnostics().nextFrame);
        }
        return true;
      }
      if (command.type === 'setTickRate') {
        return true;
      }
      server.receiveCommand(command, { mode: 'host-admin' });
      return true;
    }

    try {
      const envelope = createLockstepCommandEnvelope({
        gameId,
        currentKnownFrame: scheduler.getDiagnostics().nextFrame,
        playerId: fromPlayerId,
        playerSequence: nextLocalPlayerSequence++,
        command,
      });
      const pending = pendingCommandsByFrame.get(envelope.executeFrame);
      if (pending !== undefined) {
        pending.push(envelope);
      } else {
        pendingCommandsByFrame.set(envelope.executeFrame, [envelope]);
      }
    } catch (err) {
      console.warn('[LOCKSTEP] Rejected local command:', err);
    }
    return true;
  };

  const localConnection = createLocalRealBattleConnection(
    server,
    localPlayerId,
    networkRole === null ? 'local-offline' : 'player',
    {
      commandDoorway: scheduleCommand,
      // Lockstep snapshots are local presentation data. The canonical
      // multiplayer truth is the command-frame stream, so keep the fast
      // in-memory path unless an explicit future diagnostics mode asks
      // to loop snapshots through the wire codec for comparison.
      loopbackSnapshotsThroughWire: false,
    },
  );

  const pumpFrame = (): void => {
    const diagnostics = scheduler.getDiagnostics();
    if (diagnostics.status === 'protocol-paused' || diagnostics.status === 'desynced') return;
    const frame = diagnostics.nextFrame;
    const commands = pendingCommandsByFrame.get(frame) ?? [];
    pendingCommandsByFrame.delete(frame);
    scheduler.receiveCommandFrame({
      frame,
      frameSequence: nextFrameSequence++,
      commands,
    });
    scheduler.advanceReadyFrames(1);
  };

  return {
    architecture: 'deterministic-lockstep',
    server,
    gameConnection: localConnection,
    startupGateRequiresServer: false,
    start() {
      applyStoredBattleServerSettings(server, 'real', {
        ipAddress: localIpAddress,
        maxTotalUnits: initialMaxTotalUnits,
        fogOfWarEnabled: true,
      });
      if (network !== undefined) {
        network.onLockstepMessage = handleLockstepMessage;
        network.getLockstepTransport().sendHello(
          initializationHash,
          scheduler.getDiagnostics().nextFrame,
        );
        network.getLockstepTransport().sendReady(
          initializationHash,
          scheduler.getDiagnostics().nextFrame,
        );
      }
      server.startLockstepPresentation();
      pumpTimer = setInterval(pumpFrame, LOCKSTEP_FIXED_DT_MS);
    },
    stop() {
      if (pumpTimer !== null) {
        clearInterval(pumpTimer);
        pumpTimer = null;
      }
      if (network !== undefined && network.onLockstepMessage === handleLockstepMessage) {
        network.onLockstepMessage = previousLockstepHandler;
      }
      localConnection.disconnect();
      server.stop();
    },
    getDiagnostics() {
      return {
        architecture: 'deterministic-lockstep',
        architectureConfigReadMode: ARCHITECTURE_CONFIG_READ_MODE,
        networkRole,
        hasLocalServer: true,
        renderConnection: 'local',
        snapshotSource: 'local',
        snapshotTruth: 'command-frame-stream-local-presentation',
        snapshotWireMode: 'direct-in-memory',
        remoteSnapshotComparison: 'disabled',
        lockstepSupport: LOCKSTEP_SUPPORT_BOUNDARIES,
        lockstepInputDelayTicks: ARCHITECTURE_CONFIG.lockstep.inputDelayTicks,
        lockstepInitializationHash: initializationHash,
        lockstepChecksums: desyncMonitor?.getDiagnostics(),
        lockstepNetwork: network?.getLockstepTransport().getDiagnostics() ?? null,
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

export function getConfiguredArchitectureBackend(): ArchitectureBackend {
  return ARCHITECTURE_CONFIG.backend;
}

export async function createRealBattleBackend(
  options: CreateRealBattleBackendOptions,
): Promise<RealBattleBackendRuntime> {
  switch (ARCHITECTURE_CONFIG.backend) {
    case 'authoritative-server':
      return createAuthoritativeServerBackend(options);
    case 'deterministic-lockstep':
      return createDeterministicLockstepBackend(options);
    default:
      return assertNeverArchitecture(ARCHITECTURE_CONFIG.backend);
  }
}
