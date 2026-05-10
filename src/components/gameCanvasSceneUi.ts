import { reactive, type Ref } from 'vue';
import type { GameScene } from '@/types/game';
import type { NetworkServerSnapshotMeta } from '@/types/network';
import type { EconomyInfo, MinimapData, SelectionActions, SelectionInfo } from '@/types/ui';
import type { BackgroundBattleState } from '../game/lobby/LobbyManager';
import type { PlayerId } from '../game/sim/types';
import {
  applyMinimapCameraQuad,
  applyMinimapContentData,
  createInitialMinimapData,
} from './minimapHelpers';
import { bindSceneUiCallbacks } from './gameSceneBindings';
import type { GameCanvasForegroundGame } from './gameCanvasForegroundGame';

type UseGameCanvasSceneUiOptions = {
  activePlayer: Ref<PlayerId>;
  gameOverWinner: Ref<PlayerId | null>;
  serverMetaFromSnapshot: Ref<NetworkServerSnapshotMeta | null>;
  foregroundGame: GameCanvasForegroundGame;
  getBackgroundBattle: () => BackgroundBattleState | null;
};

export function useGameCanvasSceneUi({
  activePlayer,
  gameOverWinner,
  serverMetaFromSnapshot,
  foregroundGame,
  getBackgroundBattle,
}: UseGameCanvasSceneUiOptions) {
  const selectionInfo = reactive<SelectionInfo>({
    unitCount: 0,
    hasCommander: false,
    hasBuilder: false,
    hasDGun: false,
    hasFactory: false,
    factoryId: undefined,
    commanderId: undefined,
    waypointMode: 'move',
    isBuildMode: false,
    selectedBuildingType: null,
    isDGunMode: false,
    factoryQueue: [],
    factoryProgress: 0,
    factoryIsProducing: false,
  });

  const economyInfo = reactive<EconomyInfo>({
    stockpile: { curr: 250, max: 1000 },
    income: { base: 5, production: 0, total: 5 },
    expenditure: 0,
    netFlow: 5,
    mana: {
      stockpile: { curr: 200, max: 1000 },
      income: { base: 5, territory: 0, total: 5 },
      expenditure: 0,
      netFlow: 5,
    },
    metal: {
      stockpile: { curr: 200, max: 1000 },
      income: { base: 2, extraction: 0, total: 2 },
      expenditure: 0,
      netFlow: 2,
    },
    units: { count: 1, cap: 120 },
    buildings: { solar: 0, wind: 0, factory: 0, extractor: 0 },
  });

  const minimapData = reactive<MinimapData>(createInitialMinimapData());

  function bindGameSceneUi(scene: GameScene, includeGameLifecycle = false): void {
    bindSceneUiCallbacks(scene, {
      onPlayerChange: (playerId) => {
        activePlayer.value = playerId;
      },
      onSelectionChange: (info) => {
        Object.assign(selectionInfo, info);
      },
      onEconomyChange: (info) => {
        Object.assign(economyInfo, info);
      },
      onMinimapUpdate: (data) => {
        applyMinimapContentData(minimapData, data);
      },
      onCameraQuadUpdate: (quad, cameraYaw) => {
        applyMinimapCameraQuad(minimapData, quad, cameraYaw);
      },
      onServerMetaUpdate: (meta) => {
        serverMetaFromSnapshot.value = meta;
      },
      ...(includeGameLifecycle
        ? {
            onGameOver: (winnerId: PlayerId) => {
              gameOverWinner.value = winnerId;
            },
            onGameRestart: () => {
              gameOverWinner.value = null;
            },
          }
        : {}),
    });
  }

  function getActiveBattleScene(): GameScene | null {
    return foregroundGame.getScene() ?? getBackgroundBattle()?.gameInstance?.getScene() ?? null;
  }

  function togglePlayer(): void {
    const scene = getActiveBattleScene();
    if (scene) {
      scene.togglePlayer();
      activePlayer.value = scene.getActivePlayer();
    }
  }

  function handleMinimapClick(x: number, y: number): void {
    getActiveBattleScene()?.centerCameraOn(x, y);
  }

  const selectionActions: SelectionActions = {
    setWaypointMode: (mode) => {
      getActiveBattleScene()?.setWaypointMode(mode);
    },
    startBuild: (buildingType) => {
      getActiveBattleScene()?.startBuildMode(buildingType);
    },
    cancelBuild: () => {
      getActiveBattleScene()?.cancelBuildMode();
    },
    toggleDGun: () => {
      getActiveBattleScene()?.toggleDGunMode();
    },
    queueUnit: (factoryId, unitId) => {
      getActiveBattleScene()?.queueFactoryUnit(factoryId, unitId);
    },
    cancelQueueItem: (factoryId, index) => {
      getActiveBattleScene()?.cancelFactoryQueueItem(factoryId, index);
    },
  };

  return {
    selectionInfo,
    economyInfo,
    minimapData,
    bindGameSceneUi,
    togglePlayer,
    handleMinimapClick,
    selectionActions,
  };
}
