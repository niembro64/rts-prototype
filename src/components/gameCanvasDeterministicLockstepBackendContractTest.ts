import {
  buildCanonicalMatchInitialization,
  hashCanonicalMatchInitialization,
} from '../game/architecture/CanonicalMatchInitialization';
import type { CanonicalServerStateHash } from '../game/architecture/CanonicalStateHash';
import {
  compareLockstepCommandEnvelopes,
  createLockstepCommandEnvelope,
  type LockstepCommandEnvelope,
} from '../game/architecture/LockstepCommandProtocol';
import type { NetworkManager } from '../game/network/NetworkManager';
import type { NetworkLockstepTransportDiagnostics } from '../game/network/NetworkLockstepTransport';
import {
  BATTLE_HANDOFF_PROTOCOL,
  LOCKSTEP_PROTOCOL_VERSION,
  type BattleHandoff,
  type LockstepCommandFrameBatchFrame,
  type LockstepCommandFrameMessage,
  type LobbySettings,
  type NetworkLockstepMessage,
  type NetworkServerSnapshot,
} from '../game/network/NetworkTypes';
import type { PlayerId } from '../game/sim/types';
import {
  createDeterministicLockstepBackend,
  type RealBattleStartupTerrain,
} from './gameCanvasRealBattleStartup';

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[deterministic lockstep backend contract] ${message}`);
  }
}

export async function runDeterministicLockstepBackendContractTest(): Promise<void> {
  assertInitializationHashMismatch();
  const terrain = createTerrain();
  const backend = await createDeterministicLockstepBackend({
    playerIds: [1 as PlayerId, 2 as PlayerId],
    aiPlayerIds: undefined,
    terrain,
    networkRole: null,
    localPlayerId: 1 as PlayerId,
    localIpAddress: 'contract',
    onLoadingProgress: undefined,
  });

  try {
    assertContract(backend.server !== null, 'lockstep backend must create a local server');
    assertContract(
      backend.server.getLockstepSimulationCore().world.metalCoverage === 'all'
        && backend.server.getLockstepSimulationCore().world.liquidSurfaceMode === 'lava',
      'server bootstrap must install the selected WORLD modes before frame 0',
    );

    const snapshots: NetworkServerSnapshot[] = [];
    const unsubscribe = backend.gameConnection.onSnapshot((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      backend.start();
      backend.gameConnection.markClientReady();
      await waitMs(140);
      assertContract(snapshots.length > 0, 'lockstep backend must generate local render snapshots');
      assertContract(
        backend.getDiagnostics().lockstep?.nextFrame !== undefined &&
          backend.getDiagnostics().lockstep!.nextFrame > 0,
        'lockstep scheduler must advance local frames',
      );
      assertContract(
        backend.getDiagnostics().lockstepPerformanceBudget?.slowClientPolicy ===
          'stall-and-resync-lockstep-frames' &&
          (backend.getDiagnostics().lockstepSnapshotPerformance?.snapshotsEmitted ?? 0) > 0 &&
          (backend.getDiagnostics().lockstepSnapshotPerformance?.rich.snapshotsEmitted ?? 0) > 0 &&
          backend.getDiagnostics().lockstepSnapshotPerformance?.delta.snapshotsEmitted !== undefined,
        'lockstep diagnostics must expose performance budget and snapshot timing',
      );

      const server = backend.server;
      assertContract(server !== null, 'lockstep local server must remain available');
      const commander = server.getLockstepSimulationCore().world.getCommander(1 as PlayerId);
      assertContract(commander !== undefined, 'player commander fixture must exist');
      const beforeSelectionHash = server.getLockstepSimulationCore().getCanonicalStateHash();
      assertContract(commander.selectable !== null, 'commander fixture must be selectable');
      const previousSelected = commander.selectable.selected;
      commander.selectable.selected = !previousSelected;
      const afterSelectionHash = server.getLockstepSimulationCore().getCanonicalStateHash();
      commander.selectable.selected = previousSelected;
      assertContract(
        afterSelectionHash.hash === beforeSelectionHash.hash &&
          afterSelectionHash.sections.entities === beforeSelectionHash.sections.entities,
        'canonical lockstep state hash must ignore local selection presentation state',
      );
      assertContract(commander.unit !== null, 'commander fixture must have a unit component');
      const beforeActivePathHash = server.getLockstepSimulationCore().getCanonicalStateHash();
      const previousActivePath = commander.unit.activePath;
      commander.unit.activePath = {
        resolution: 'complete',
        plannedAtTick: 0,
        buildingGridVersion: 0,
        points: [
          {
            x: commander.transform.x + 16,
            y: commander.transform.y,
            z: commander.transform.z,
          },
        ],
        index: 0,
        actionHash: 123,
        terrainVersion: 456,
        goalX: commander.transform.x + 16,
        goalY: commander.transform.y,
        goalZ: commander.transform.z,
        actionType: 'move',
      };
      const afterActivePathHash = server.getLockstepSimulationCore().getCanonicalStateHash();
      commander.unit.activePath = previousActivePath;
      assertContract(
        afterActivePathHash.hash === beforeActivePathHash.hash &&
          afterActivePathHash.sections.entities === beforeActivePathHash.sections.entities,
        'canonical lockstep state hash must ignore transient activePath cache state',
      );
      backend.gameConnection.sendCommand({
        type: 'move',
        tick: 0,
        entityIds: [commander.id],
        targetX: commander.transform.x + 64,
        targetY: commander.transform.y,
        targetZ: commander.transform.z,
        waypointType: 'move',
        queue: false,
      });
      await waitMs(140);
      assertContract(
        backend.getDiagnostics().lockstep?.lastAdvancedFrame !== null,
        'lockstep backend must keep advancing after scheduled local input',
      );
    } finally {
      unsubscribe();
    }
  } finally {
    backend.stop();
  }
  await assertSelectedSimulationTickRateApplied();
  await assertOnlineLockstepRoutesClientCommandsThroughCoordinator();
}

async function assertSelectedSimulationTickRateApplied(): Promise<void> {
  const terrain = createTerrain();
  const handoff = createBattleHandoff(terrain, 60);
  const backend = await createDeterministicLockstepBackend({
    playerIds: [1 as PlayerId, 2 as PlayerId],
    aiPlayerIds: undefined,
    terrain,
    networkRole: null,
    localPlayerId: 1 as PlayerId,
    localIpAddress: 'contract-60hz',
    battleHandoff: handoff,
    onLoadingProgress: undefined,
  });
  try {
    const diagnostics = backend.getDiagnostics();
    assertContract(
      backend.server?.getLockstepSimulationCore().world.simulationTickRateHz === 60 &&
        Math.abs((diagnostics.lockstep?.fixedDtMs ?? 0) - 1000 / 60) < 1e-9 &&
        diagnostics.lockstepPerformanceBudget?.fixedSimulationHz === 60,
      'selected simulation tick rate must drive world state, scheduler dt, and diagnostics',
    );
    backend.start();
    backend.gameConnection.markClientReady();
    await waitUntil(
      () => (backend.getDiagnostics().lockstep?.nextFrame ?? 0) >= 3,
      500,
      '60 Hz lockstep backend must advance at the selected cadence',
    );
  } finally {
    backend.stop();
  }
}

function assertInitializationHashMismatch(): void {
  const base = {
    gameId: 'contract-game',
    roomCode: 'CONTRACT',
    hostPlayerId: 1 as PlayerId,
    playerIds: [1 as PlayerId, 2 as PlayerId],
    aiPlayerIds: [],
    settings: {
      centerMagnitude: 0,
      dividersMagnitude: 0,
      perimeterMagnitude: -800,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 0,
      terrainDetail: 1,
      mapWidthLandCells: 9,
      mapLengthLandCells: 9,
      entityCountCap: 128,
      allyTeamCount: 2,
      pathfindingCellConsolidationMultiplier: 3,
      simulationTickRateHz: 20,
      converterTax: 0,
      slowDownAtFinalWaypoint: false,
      metalCoverage: 'more' as const,
      liquidSurfaceMode: 'water' as const,
    },
  };
  const firstInitialization = buildCanonicalMatchInitialization(base);
  assertContract(
    /^sha256:[0-9a-f]{64}$/.test(firstInitialization.content.buildFingerprint),
    'canonical initialization must bind the exact JS/WASM build fingerprint',
  );
  const first = hashCanonicalMatchInitialization(firstInitialization);
  const second = hashCanonicalMatchInitialization(buildCanonicalMatchInitialization({
    ...base,
      settings: {
        ...base.settings,
        converterTax: 0.25,
      },
    }));
  assertContract(first !== second, 'canonical initialization hash must catch config mismatches');
  const third = hashCanonicalMatchInitialization(buildCanonicalMatchInitialization({
    ...base,
    settings: {
      ...base.settings,
      slowDownAtFinalWaypoint: true,
    },
  }));
  assertContract(
    first !== third,
    'canonical initialization hash must include final-waypoint slowdown',
  );
  const fourth = hashCanonicalMatchInitialization(buildCanonicalMatchInitialization({
    ...base,
    settings: {
      ...base.settings,
      metalCoverage: 'all',
      liquidSurfaceMode: 'lava',
    },
  }));
  assertContract(
    first !== fourth,
    'canonical initialization hash must include WORLD material modes',
  );
  const fifth = hashCanonicalMatchInitialization(buildCanonicalMatchInitialization({
    ...base,
    settings: {
      ...base.settings,
      pathfindingCellConsolidationMultiplier: 4,
    },
  }));
  assertContract(
    first !== fifth,
    'canonical initialization hash must include pathfinding-cell resolution',
  );
  const sixthInitialization = buildCanonicalMatchInitialization({
    ...base,
    settings: {
      ...base.settings,
      simulationTickRateHz: 60,
    },
  });
  const sixth = hashCanonicalMatchInitialization(sixthInitialization);
  assertContract(
    first !== sixth,
    'canonical initialization hash must include simulation tick rate',
  );
  assertContract(
    sixthInitialization.lockstep.fixedStepHz === 60 &&
      sixthInitialization.lockstep.inputDelayTicks === 45 &&
      sixthInitialization.lockstep.checksumIntervalTicks === 540,
    'canonical initialization must scale fixed-step tick policies with the selected rate',
  );
}

function createTerrain(): RealBattleStartupTerrain {
  return {
    terrainRuntimeConfig: {
      centerMagnitude: 0,
      dividersMagnitude: 0,
      perimeterMagnitude: -800,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 0,
      terrainDetail: 1,
    },
    mapDimensions: {
      widthLandCells: 9,
      lengthLandCells: 9,
    },
    mapSize: {
      width: 9 * 128,
      height: 9 * 128,
    },
    metalCoverage: 'all',
    liquidSurfaceMode: 'lava',
  };
}

function createLobbySettings(
  terrain: RealBattleStartupTerrain,
  simulationTickRateHz = 20,
): LobbySettings {
  return {
    centerMagnitude: terrain.terrainRuntimeConfig.centerMagnitude,
    dividersMagnitude: terrain.terrainRuntimeConfig.dividersMagnitude,
    perimeterMagnitude: terrain.terrainRuntimeConfig.perimeterMagnitude,
    terrainDTerrain: terrain.terrainRuntimeConfig.terrainDTerrain,
    plateauWallSlopeDegrees:
      terrain.terrainRuntimeConfig.plateauWallSlopeDegrees,
    metalDepositStep: terrain.terrainRuntimeConfig.metalDepositStep,
    terrainDetail: terrain.terrainRuntimeConfig.terrainDetail,
    mapWidthLandCells: terrain.mapDimensions.widthLandCells,
    mapLengthLandCells: terrain.mapDimensions.lengthLandCells,
    entityCountCap: 128,
    allyTeamCount: 2,
    pathfindingCellConsolidationMultiplier: 3,
    simulationTickRateHz,
    converterTax: 0,
    slowDownAtFinalWaypoint: false,
    metalCoverage: terrain.metalCoverage,
    liquidSurfaceMode: terrain.liquidSurfaceMode,
  };
}

function createBattleHandoff(
  terrain: RealBattleStartupTerrain,
  simulationTickRateHz = 20,
): BattleHandoff {
  const settings = createLobbySettings(terrain, simulationTickRateHz);
  const initialization = buildCanonicalMatchInitialization({
    gameId: 'contract-game',
    roomCode: 'CONTRACT',
    hostPlayerId: 1 as PlayerId,
    playerIds: [1 as PlayerId, 2 as PlayerId],
    settings,
  });
  return {
    protocol: BATTLE_HANDOFF_PROTOCOL,
    gameId: 'contract-game',
    roomCode: 'CONTRACT',
    initialization,
    initializationHash: hashCanonicalMatchInitialization(initialization),
    hostPlayerId: 1 as PlayerId,
    playerIds: [1 as PlayerId, 2 as PlayerId],
    players: [
      {
        playerId: 1 as PlayerId,
        name: 'Player 1',
        isHost: true,
      allyTeamId: 1,
        ipAddress: undefined,
        location: undefined,
        timezone: undefined,
        localTime: undefined,
      },
      {
        playerId: 2 as PlayerId,
        name: 'Player 2',
        isHost: false,
      allyTeamId: 2,
        ipAddress: undefined,
        location: undefined,
        timezone: undefined,
        localTime: undefined,
      },
    ],
    settings,
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  message: string | (() => string),
): Promise<void> {
  const startMs = Date.now();
  while (Date.now() - startMs < timeoutMs) {
    if (predicate()) return;
    await waitMs(16);
  }
  assertContract(predicate(), typeof message === 'function' ? message() : message);
}

async function assertOnlineLockstepRoutesClientCommandsThroughCoordinator(): Promise<void> {
  await assertOnlineHostFramesRemoteClientCommands();
  await assertOnlineClientWaitsForCoordinatorFrames();
}

async function assertOnlineHostFramesRemoteClientCommands(): Promise<void> {
  const terrain = createTerrain();
  const handoff = createBattleHandoff(terrain);
  const hostNetwork = new FakeLockstepNetwork(1 as PlayerId);
  const clientNetwork = new FakeLockstepNetwork(2 as PlayerId);
  hostNetwork.connect(clientNetwork);
  const host = await createDeterministicLockstepBackend({
    playerIds: [1 as PlayerId, 2 as PlayerId],
    aiPlayerIds: undefined,
    terrain,
    networkRole: 'host',
    localPlayerId: 1 as PlayerId,
    localIpAddress: 'contract-host',
    network: hostNetwork.asNetworkManager(),
    battleHandoff: handoff,
    onLoadingProgress: undefined,
  });

  try {
    host.start();
    host.gameConnection.markClientReady();
    clientNetwork.transport.sendHello(handoff.initializationHash, 0);
    clientNetwork.transport.sendReady(handoff.initializationHash, 0);

    await waitUntil(
      () => (host.getDiagnostics().lockstep?.nextFrame ?? 0) > 4,
      1_500,
      'online lockstep host must advance coordinator command frames',
    );

    const commander = host.server?.getLockstepSimulationCore().world.getCommander(2 as PlayerId);
    assertContract(commander !== undefined, 'remote client commander fixture must exist on host');
    const previousFrameCount = hostNetwork.transport.commandFrames.length;
    const envelope = createLockstepCommandEnvelope({
      gameId: 'contract-game',
      currentKnownFrame: host.getDiagnostics().lockstep?.nextFrame ?? 0,
      playerId: 2 as PlayerId,
      playerSequence: 0,
      command: {
        type: 'move',
        tick: 0,
        entityIds: [commander.id],
        targetX: commander.transform.x + 64,
        targetY: commander.transform.y,
        targetZ: commander.transform.z,
        waypointType: 'move',
        queue: false,
      },
    });
    assertContract(
      clientNetwork.transport.sendCommand(envelope),
      'fake remote client must deliver command to host coordinator',
    );

    await waitUntil(
      () =>
        hostNetwork.transport.commandFrames
          .slice(previousFrameCount)
          .some((frame) =>
            frame.commands.some((candidate) =>
              candidate.playerId === 2 &&
              candidate.command.type === 'move',
            ),
          ),
      1_500,
      () =>
        'host coordinator must return remote client commands in a command frame; ' +
        `envelope=${JSON.stringify(envelope)}, ` +
        `diagnostics=${JSON.stringify(host.getDiagnostics().lockstep)}, ` +
        `newFrames=${JSON.stringify(hostNetwork.transport.commandFrames.slice(previousFrameCount))}`,
    );
    assertContract(
      host.getDiagnostics().lockstep?.status !== 'desynced',
      'host coordinator must not desync after framing a remote client command',
    );
  } finally {
    host.stop();
  }
}

async function assertOnlineClientWaitsForCoordinatorFrames(): Promise<void> {
  const terrain = createTerrain();
  const handoff = createBattleHandoff(terrain);
  const hostNetwork = new FakeLockstepNetwork(1 as PlayerId);
  const clientNetwork = new FakeLockstepNetwork(2 as PlayerId);
  hostNetwork.connect(clientNetwork);
  hostNetwork.onLockstepMessage = () => undefined;
  const client = await createDeterministicLockstepBackend({
    playerIds: [1 as PlayerId, 2 as PlayerId],
    aiPlayerIds: undefined,
    terrain,
    networkRole: 'client',
    localPlayerId: 2 as PlayerId,
    localIpAddress: 'contract-client',
    network: clientNetwork.asNetworkManager(),
    battleHandoff: handoff,
    onLoadingProgress: undefined,
  });

  try {
    client.start();
    client.gameConnection.markClientReady();

    await waitMs(80);
    assertContract(
      (client.getDiagnostics().lockstep?.nextFrame ?? -1) === 0,
      'online lockstep clients must not create local command frames while waiting for coordinator',
    );

    const commander = client.server?.getLockstepSimulationCore().world.getCommander(2 as PlayerId);
    assertContract(commander !== undefined, 'online client commander fixture must exist');
    client.gameConnection.sendCommand({
      type: 'move',
      tick: 0,
      entityIds: [commander.id],
      targetX: commander.transform.x + 64,
      targetY: commander.transform.y,
      targetZ: commander.transform.z,
      waypointType: 'move',
      queue: false,
    });
    const envelope = clientNetwork.transport.commandEnvelopes[0];
    assertContract(envelope !== undefined, 'online client must send local gameplay commands to coordinator');

    for (let frame = 0; frame <= envelope.executeFrame; frame++) {
      hostNetwork.transport.broadcastCommandFrame(
        frame,
        frame,
        frame === envelope.executeFrame ? [envelope] : [],
      );
    }

    await waitUntil(
      () => (client.getDiagnostics().lockstep?.nextFrame ?? 0) > envelope.executeFrame,
      800,
      'online lockstep clients must advance from coordinator command frames',
    );
    assertContract(
      client.getDiagnostics().lockstep?.status !== 'desynced',
      'online lockstep client must not desync after receiving its command in a coordinator frame',
    );
  } finally {
    client.stop();
  }
}

class FakeLockstepNetwork {
  public onLockstepMessage: NetworkManager['onLockstepMessage'] = undefined;
  public readonly transport: FakeLockstepTransport;
  private peer: FakeLockstepNetwork | null = null;

  constructor(public readonly playerId: PlayerId) {
    this.transport = new FakeLockstepTransport(this);
  }

  connect(peer: FakeLockstepNetwork): void {
    this.peer = peer;
    peer.peer = this;
  }

  getLockstepTransport(): FakeLockstepTransport {
    return this.transport;
  }

  asNetworkManager(): NetworkManager {
    return this as unknown as NetworkManager;
  }

  getPendingLockstepMessageDiagnostics(): { readonly queued: number; readonly dropped: number } {
    return { queued: 0, dropped: 0 };
  }

  getLocalMemberId(): number {
    return this.playerId;
  }

  deliverToPeer(message: NetworkLockstepMessage): boolean {
    if (this.peer?.onLockstepMessage === undefined) return false;
    // Seat and member coincide in this fixture: both fake peers are seated,
    // which is the case the lockstep backend is being exercised for.
    this.peer.onLockstepMessage(message, {
      memberId: this.playerId,
      playerId: this.playerId,
    });
    return true;
  }
}

class FakeLockstepTransport {
  public readonly commandFrames: LockstepCommandFrameMessage[] = [];
  public readonly commandEnvelopes: LockstepCommandEnvelope[] = [];

  constructor(private readonly network: FakeLockstepNetwork) {}

  sendHello(initializationHash: string, lastReceivedFrame: number): boolean {
    return this.network.deliverToPeer({
      ...this.base(),
      type: 'lockstepHello',
      playerId: this.network.playerId,
      initializationHash,
      lastReceivedFrame,
      receivedPeerSequences: [],
    });
  }

  sendReady(initializationHash: string, readyFrame: number): boolean {
    return this.network.deliverToPeer({
      ...this.base(),
      type: 'lockstepReady',
      playerId: this.network.playerId,
      readyFrame,
      initializationHash,
    });
  }

  sendCommand(envelope: LockstepCommandEnvelope): boolean {
    this.commandEnvelopes.push(envelope);
    return this.network.deliverToPeer({
      ...this.base(),
      type: 'lockstepCommand',
      envelope,
    });
  }

  broadcastCommandFrame(
    frame: number,
    frameSequence: number,
    commands: readonly LockstepCommandEnvelope[],
  ): boolean {
    const message: LockstepCommandFrameMessage = {
      ...this.base(),
      type: 'lockstepCommandFrame',
      coordinatorPlayerId: this.network.playerId,
      frame,
      frameSequence,
      commands: [...commands].sort(compareLockstepCommandEnvelopes),
    };
    this.commandFrames.push(message);
    return this.network.deliverToPeer(message);
  }

  broadcastCommandFrameBatch(
    frames: readonly {
      frame: number;
      frameSequence: number;
      commands: readonly LockstepCommandEnvelope[];
    }[],
  ): boolean {
    if (frames.length === 0) return false;
    if (frames.length === 1) {
      const frame = frames[0];
      return this.broadcastCommandFrame(frame.frame, frame.frameSequence, frame.commands);
    }
    const batchFrames = new Array<LockstepCommandFrameBatchFrame>(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const commands = [...frame.commands].sort(compareLockstepCommandEnvelopes);
      batchFrames[i] = {
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commands,
      };
      this.commandFrames.push({
        ...this.base(),
        type: 'lockstepCommandFrame',
        coordinatorPlayerId: this.network.playerId,
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commands,
      });
    }
    return this.network.deliverToPeer({
      ...this.base(),
      type: 'lockstepCommandFrameBatch',
      coordinatorPlayerId: this.network.playerId,
      frames: batchFrames,
    });
  }

  sendAck(ackFrame: number, ackFrameSequence: number): boolean {
    return this.network.deliverToPeer({
      ...this.base(),
      type: 'lockstepAck',
      playerId: this.network.playerId,
      ackFrame,
      ackFrameSequence,
      receivedPeerSequences: [],
    });
  }

  latestAckForPlayer(): undefined {
    return undefined;
  }

  resendCommandFramesAfter(
    lastAckedFrame: number,
    _targetPlayerId: PlayerId,
    maxFrames: number,
  ): number {
    const frames = this.commandFrames
      .filter((frame) => frame.frame > lastAckedFrame)
      .slice(0, maxFrames);
    let sent = 0;
    for (const frame of frames) {
      if (this.network.deliverToPeer(frame)) sent++;
    }
    return sent;
  }

  sendResyncRequest(fromFrame: number, reason: string): boolean {
    return this.network.deliverToPeer({
      ...this.base(),
      type: 'lockstepResyncRequest',
      requestedByPlayerId: this.network.playerId,
      fromFrame,
      reason,
    });
  }

  sendChecksum(frame: number, stateHash: CanonicalServerStateHash): boolean {
    return this.network.deliverToPeer({
      ...this.base(),
      type: 'lockstepChecksum',
      playerId: this.network.playerId,
      frame,
      stateHash,
    });
  }

  broadcastPause(frame: number, reason: string): boolean {
    return this.network.deliverToPeer({
      ...this.base(),
      type: 'lockstepPause',
      requestedByPlayerId: this.network.playerId,
      frame,
      reason,
    });
  }

  broadcastResume(resumeFrame: number): boolean {
    return this.network.deliverToPeer({
      ...this.base(),
      type: 'lockstepResume',
      requestedByPlayerId: this.network.playerId,
      resumeFrame,
    });
  }

  broadcastDesync(
    frame: number,
    localHash: CanonicalServerStateHash,
    remotePlayerId: PlayerId | null,
    remoteHash: CanonicalServerStateHash | null,
  ): boolean {
    return this.network.deliverToPeer({
      ...this.base(),
      type: 'lockstepDesync',
      detectedByPlayerId: this.network.playerId,
      frame,
      localHash,
      remotePlayerId,
      remoteHash,
    });
  }

  getDiagnostics(): NetworkLockstepTransportDiagnostics {
    return {
      receivedPeerSequences: [],
      latestAcks: [],
      storedOutboundFrames: this.commandFrames.map((frame) => ({
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commandCount: frame.commands.length,
      })),
      resendCount: 0,
    };
  }

  private base() {
    return {
      gameId: 'contract-game',
      protocolVersion: LOCKSTEP_PROTOCOL_VERSION,
    };
  }
}
