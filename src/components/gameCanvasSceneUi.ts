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
 *  reference (stockpile/income/metal/...) with a fresh plain object
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

function cloneServerMeta(meta: NetworkServerSnapshotMeta): NetworkServerSnapshotMeta {
  // Full-snapshot buffering can reuse and mutate this object; publish a
  // fresh graph so Vue invalidates bar computed values every snapshot.
  return {
    ticks: { ...meta.ticks },
    snaps: { ...meta.snaps },
    server: { ...meta.server },
    grid: meta.grid,
    units: {
      allowed: meta.units.allowed ? [...meta.units.allowed] : undefined,
      max: meta.units.max,
      count: meta.units.count,
    },
    turretShieldPanelsEnabled: meta.turretShieldPanelsEnabled,
    turretShieldSpheresEnabled: meta.turretShieldSpheresEnabled,
    shieldsObstructSight: meta.shieldsObstructSight,
    shieldReflectionMode: meta.shieldReflectionMode,
    fogOfWarEnabled: meta.fogOfWarEnabled,
    converterTax: meta.converterTax,
    cpu: meta.cpu ? { ...meta.cpu } : undefined,
    wind: meta.wind ? { ...meta.wind } : undefined,
    unitGroundNormalEma: meta.unitGroundNormalEma,
  };
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
    towerCount: 0,
    buildingCount: 0,
    hasCommander: false,
    hasBuilder: false,
    allowedBuildBlueprintIds: [],
    hasDGun: false,
    hasFireControl: false,
    fireEnabled: false,
    hasTrajectoryControl: false,
    trajectoryMode: 'auto',
    hasBuildingActiveControl: false,
    buildingsActive: false,
    hasSelfDestructable: false,
    hasReclaimableSelection: false,
    hasTowerTargetControl: false,
    hasTowerTargetActive: false,
    isTowerTargetMode: false,
    isWaiting: false,
    isRepeatQueue: false,
    isHoldPosition: false,
    hasQueuedOrders: false,
    hasFactory: false,
    factoryId: undefined,
    commanderId: undefined,
    waypointMode: 'move',
    isBuildMode: false,
    selectedBuildingBlueprintId: null,
    buildLineSpacingMultiplier: 1,
    buildFacingDegrees: 0,
    isDGunMode: false,
    isRepairAreaMode: false,
    isFormationAssumeMode: false,
    isFormationMoveMode: false,
    isAttackMode: false,
    isAttackAreaMode: false,
    isAttackGroundMode: false,
    isGuardMode: false,
    isReclaimMode: false,
    isPingMode: false,
    factorySelectedUnit: null,
    factoryProgress: 0,
    factoryIsProducing: false,
    factoryRepeatsProduction: true,
    factoryProductionQueue: [],
    factoryGuardTargetId: null,
    controlGroups: [],
    details: [],
  });

  const economyInfo = reactive<EconomyInfo>({
    stockpile: { curr: 250, max: 1000 },
    income: { base: 5, production: 0, total: 5 },
    expenditure: 0,
    netFlow: 5,
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
        serverMetaFromSnapshot.value = cloneServerMeta(meta);
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
    skipCurrentOrder: () => {
      getActiveBattleScene()?.skipCurrentOrder();
    },
    clearQueuedOrders: () => {
      getActiveBattleScene()?.clearQueuedOrders();
    },
    removeLastQueuedOrder: () => {
      getActiveBattleScene()?.removeLastQueuedOrder();
    },
    toggleRepeatQueue: () => {
      getActiveBattleScene()?.toggleRepeatQueue();
    },
    toggleUnitMoveState: () => {
      getActiveBattleScene()?.toggleUnitMoveState();
    },
    toggleTrajectoryMode: () => {
      getActiveBattleScene()?.toggleTrajectoryMode();
    },
    toggleSelectedWait: (queue, queueFront) => {
      getActiveBattleScene()?.toggleSelectedWait(queue, queueFront);
    },
    toggleSelectedFire: () => {
      getActiveBattleScene()?.toggleSelectedFire();
    },
    toggleBuildingActive: () => {
      getActiveBattleScene()?.toggleBuildingActive();
    },
    selfDestructSelected: () => {
      getActiveBattleScene()?.selfDestructSelected();
    },
    selectOnlyEntityType: (entityType) => {
      getActiveBattleScene()?.selectOnlyEntityType(entityType);
    },
    selectAllOwnedUnits: () => {
      getActiveBattleScene()?.selectAllOwnedUnits();
    },
    selectAllMatching: () => {
      getActiveBattleScene()?.selectAllMatching();
    },
    selectAllMatchingInView: () => {
      getActiveBattleScene()?.selectAllMatchingInView();
    },
    selectPreviousSelection: () => {
      getActiveBattleScene()?.selectPreviousSelection();
    },
    selectIdleBuilders: () => {
      getActiveBattleScene()?.selectIdleBuilders();
    },
    selectWaitingUnits: () => {
      getActiveBattleScene()?.selectWaitingUnits();
    },
    selectSameTypeOnly: () => {
      getActiveBattleScene()?.selectSameTypeOnly();
    },
    selectMobileOnly: () => {
      getActiveBattleScene()?.selectMobileOnly();
    },
    invertSelection: () => {
      getActiveBattleScene()?.invertSelection();
    },
    splitArmySelection: () => {
      getActiveBattleScene()?.splitArmySelection();
    },
    loopSelection: () => {
      getActiveBattleScene()?.loopSelection();
    },
    setTowerTargetMode: () => {
      getActiveBattleScene()?.toggleTowerTargetMode();
    },
    clearTowerTarget: () => {
      getActiveBattleScene()?.clearTowerTarget();
    },
    toggleAttackArea: () => {
      getActiveBattleScene()?.toggleAttackAreaMode();
    },
    toggleAttack: () => {
      getActiveBattleScene()?.toggleAttackMode();
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
    reclaimSelected: () => {
      getActiveBattleScene()?.reclaimSelected();
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
    startBuild: (buildingBlueprintId) => {
      getActiveBattleScene()?.startBuildMode(buildingBlueprintId);
    },
    cancelBuild: () => {
      getActiveBattleScene()?.cancelBuildMode();
    },
    increaseBuildLineSpacing: () => {
      getActiveBattleScene()?.increaseBuildLineSpacing();
    },
    decreaseBuildLineSpacing: () => {
      getActiveBattleScene()?.decreaseBuildLineSpacing();
    },
    rotateBuildFacingClockwise: () => {
      getActiveBattleScene()?.rotateBuildFacingClockwise();
    },
    rotateBuildFacingCounterClockwise: () => {
      getActiveBattleScene()?.rotateBuildFacingCounterClockwise();
    },
    toggleDGun: () => {
      getActiveBattleScene()?.toggleDGunMode();
    },
    toggleRepairArea: () => {
      getActiveBattleScene()?.toggleRepairAreaMode();
    },
    toggleFormationAssume: () => {
      getActiveBattleScene()?.toggleFormationAssumeMode();
    },
    toggleFormationMove: () => {
      getActiveBattleScene()?.toggleFormationMoveMode();
    },
    queueUnit: (factoryId, unitBlueprintId, repeat = true, count = 1) => {
      getActiveBattleScene()?.queueFactoryUnit(factoryId, unitBlueprintId, repeat, count);
    },
    editFactoryQueue: (factoryId, operation, index, length, toIndex, count) => {
      getActiveBattleScene()?.editFactoryQueue(factoryId, operation, index, length, toIndex, count);
    },
    stopFactoryProduction: (factoryId) => {
      getActiveBattleScene()?.stopFactoryProduction(factoryId);
    },
    clearFactoryGuard: (factoryId) => {
      getActiveBattleScene()?.clearFactoryGuard(factoryId);
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
