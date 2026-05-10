import type { NetworkServerSnapshot } from '../game/network/NetworkTypes';
import type { Command } from '../game/sim/commands';
import type { PlayerId } from '../game/sim/types';
import type { GameServer } from '../game/server/GameServer';

type RealBattleNetworkBridge = {
  getConnectedPlayerIds(): PlayerId[];
  sendStateTo(playerId: PlayerId, state: NetworkServerSnapshot): boolean;
  onCommandReceived?: (command: Command, fromPlayerId: PlayerId) => void;
};

export type GameCanvasRealBattleLifecycle = {
  beginStart(): number;
  clearTimers(): void;
  setStartTimeout(timeout: ReturnType<typeof setTimeout>): void;
  markStartTimeoutFired(): void;
  isCurrentStart(generation: number): boolean;
  bindHostNetwork(
    server: GameServer,
    network: RealBattleNetworkBridge,
    getCurrentServer: () => GameServer | null,
  ): void;
  scheduleRecoveryKeyframes(
    server: GameServer,
    generation: number,
    getCurrentServer: () => GameServer | null,
  ): void;
  removeSnapshotListener(server: GameServer | null, playerId: PlayerId): void;
  clearSnapshotListeners(server: GameServer | null): void;
};

const RECOVERY_KEYFRAME_DELAYS_MS = [500, 1500] as const;

export function useGameCanvasRealBattleLifecycle(): GameCanvasRealBattleLifecycle {
  let startGeneration = 0;
  let startTimeout: ReturnType<typeof setTimeout> | null = null;
  let recoveryKeyframeTimeouts: ReturnType<typeof setTimeout>[] = [];
  const snapshotListenerKeys = new Map<PlayerId, string>();

  function clearTimers(): void {
    startGeneration++;
    if (startTimeout) {
      clearTimeout(startTimeout);
      startTimeout = null;
    }
    for (const timeout of recoveryKeyframeTimeouts) clearTimeout(timeout);
    recoveryKeyframeTimeouts = [];
  }

  function beginStart(): number {
    clearTimers();
    return startGeneration;
  }

  function removeSnapshotListener(server: GameServer | null, playerId: PlayerId): void {
    const key = snapshotListenerKeys.get(playerId);
    if (!key) return;
    server?.removeSnapshotListener(key);
    snapshotListenerKeys.delete(playerId);
  }

  function clearSnapshotListeners(server: GameServer | null): void {
    if (server) {
      for (const key of snapshotListenerKeys.values()) {
        server.removeSnapshotListener(key);
      }
    }
    snapshotListenerKeys.clear();
  }

  function bindHostNetwork(
    server: GameServer,
    network: RealBattleNetworkBridge,
    getCurrentServer: () => GameServer | null,
  ): void {
    clearSnapshotListeners(server);
    for (const playerId of network.getConnectedPlayerIds()) {
      const trackingKey = server.addSnapshotListener((state) => {
        const sent = network.sendStateTo(playerId, state);
        if (!sent && getCurrentServer() === server) {
          server.forceNextSnapshotKeyframe();
        }
      }, playerId);
      snapshotListenerKeys.set(playerId, trackingKey);
    }

    network.onCommandReceived = (command, fromPlayerId) => {
      getCurrentServer()?.receiveCommand(command, fromPlayerId);
    };
  }

  function scheduleRecoveryKeyframes(
    server: GameServer,
    generation: number,
    getCurrentServer: () => GameServer | null,
  ): void {
    for (const delayMs of RECOVERY_KEYFRAME_DELAYS_MS) {
      const timeout = setTimeout(() => {
        recoveryKeyframeTimeouts = recoveryKeyframeTimeouts.filter(
          (item) => item !== timeout,
        );
        if (startGeneration === generation && getCurrentServer() === server) {
          server.forceNextSnapshotKeyframe();
        }
      }, delayMs);
      recoveryKeyframeTimeouts.push(timeout);
    }
  }

  return {
    beginStart,
    clearTimers,
    setStartTimeout(timeout) {
      if (startTimeout) clearTimeout(startTimeout);
      startTimeout = timeout;
    },
    markStartTimeoutFired() {
      startTimeout = null;
    },
    isCurrentStart(generation) {
      return startGeneration === generation;
    },
    bindHostNetwork,
    scheduleRecoveryKeyframes,
    removeSnapshotListener,
    clearSnapshotListeners,
  };
}
