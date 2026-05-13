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

/** Deep-merge `src` into the reactive `dest` field by field. The
 *  obvious `Object.assign(dest, src)` would swap each top-level nested
 *  reference (stockpile/income/mana/...) with a fresh plain object
 *  from buildEconomyInfo, which forces Vue to invalidate every
 *  consumer of the parent path even when the leaf scalars are
 *  unchanged — TopBar paid the cost of re-evaluating ~12 computed
 *  displays per economy tick. Per-field assignment lets the reactive
 *  proxy compare value-by-value so only actual deltas re-fire
 *  reactivity. */
function applyEconomyInfo(dest: EconomyInfo, src: EconomyInfo): void {
  dest.stockpile.curr = src.stockpile.curr;
  dest.stockpile.max = src.stockpile.max;
  dest.income.base = src.income.base;
  dest.income.production = src.income.production;
  dest.income.total = src.income.total;
  dest.expenditure = src.expenditure;
  dest.netFlow = src.netFlow;
  dest.mana.stockpile.curr = src.mana.stockpile.curr;
  dest.mana.stockpile.max = src.mana.stockpile.max;
  dest.mana.income.base = src.mana.income.base;
  dest.mana.income.territory = src.mana.income.territory;
  dest.mana.income.total = src.mana.income.total;
  dest.mana.expenditure = src.mana.expenditure;
  dest.mana.netFlow = src.mana.netFlow;
  dest.metal.stockpile.curr = src.metal.stockpile.curr;
  dest.metal.stockpile.max = src.metal.stockpile.max;
  dest.metal.income.base = src.metal.income.base;
  dest.metal.income.extraction = src.metal.income.extraction;
  dest.metal.income.total = src.metal.income.total;
  dest.metal.expenditure = src.metal.expenditure;
  dest.metal.netFlow = src.metal.netFlow;
  dest.units.count = src.units.count;
  dest.units.cap = src.units.cap;
  dest.buildings.solar = src.buildings.solar;
  dest.buildings.wind = src.buildings.wind;
  dest.buildings.factory = src.buildings.factory;
  dest.buildings.extractor = src.buildings.extractor;
}

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
    hasJump: false,
    jumpEnabled: false,
    hasFireControl: false,
    fireEnabled: false,
    isWaiting: false,
    hasQueuedOrders: false,
    hasFactory: false,
    factoryId: undefined,
    commanderId: undefined,
    waypointMode: 'move',
    isBuildMode: false,
    selectedBuildingType: null,
    isDGunMode: false,
    isRepairAreaMode: false,
    isAttackAreaMode: false,
    isAttackGroundMode: false,
    isGuardMode: false,
    isReclaimMode: false,
    isPingMode: false,
    factoryQueue: [],
    factoryProgress: 0,
    factoryIsProducing: false,
    controlGroups: [],
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
        applyEconomyInfo(economyInfo, info);
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
    stopSelectedUnits: () => {
      getActiveBattleScene()?.stopSelectedUnits();
    },
    clearQueuedOrders: () => {
      getActiveBattleScene()?.clearQueuedOrders();
    },
    removeLastQueuedOrder: () => {
      getActiveBattleScene()?.removeLastQueuedOrder();
    },
    toggleSelectedWait: () => {
      getActiveBattleScene()?.toggleSelectedWait();
    },
    toggleSelectedJump: () => {
      getActiveBattleScene()?.toggleSelectedJump();
    },
    toggleSelectedFire: () => {
      getActiveBattleScene()?.toggleSelectedFire();
    },
    toggleAttackArea: () => {
      getActiveBattleScene()?.toggleAttackAreaMode();
    },
    toggleAttackGround: () => {
      getActiveBattleScene()?.toggleAttackGroundMode();
    },
    toggleGuard: () => {
      getActiveBattleScene()?.toggleGuardMode();
    },
    toggleReclaim: () => {
      getActiveBattleScene()?.toggleReclaimMode();
    },
    togglePing: () => {
      getActiveBattleScene()?.togglePingMode();
    },
    storeControlGroup: (index) => {
      getActiveBattleScene()?.storeControlGroup(index);
    },
    recallControlGroup: (index, additive) => {
      getActiveBattleScene()?.recallControlGroup(index, additive);
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
    toggleRepairArea: () => {
      getActiveBattleScene()?.toggleRepairAreaMode();
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
