import { reactive, ref, type Ref } from 'vue';
import type { GameScene } from '@/types/game';
import type { GamePhase, NetworkServerSnapshotMeta } from '@/types/network';
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
  assignLeafValues(dest, src);
}

/** Recursively copy every leaf scalar from src into dest, writing only
 *  changed values. Generic on purpose: a field added to EconomyInfo is
 *  covered automatically instead of silently dropped by a hand-written
 *  copy list, while unchanged leaves still skip the reactive write. */
function assignLeafValues<T extends object>(dest: T, src: T): void {
  for (const key in src) {
    const sv = src[key];
    if (typeof sv === 'object' && sv !== null) {
      assignLeafValues(dest[key] as object, sv as object);
    } else if (dest[key] !== sv) {
      dest[key] = sv;
    }
  }
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
    forceFieldsVisible: meta.forceFieldsVisible,
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
    hasTransport: false,
    allowedBuildBlueprintIds: [],
    canUpgradeMetalExtractors: false,
    hasUpgradeableMetalExtractor: false,
    hasDGun: false,
    hasFireControl: false,
    fireEnabled: false,
    fireState: 'fireAtWill',
    hasTrajectoryControl: false,
    trajectoryMode: 'auto',
    hasCloakControl: false,
    wantsCloak: false,
    isCloaked: false,
    hasBuildingActiveControl: false,
    buildingsActive: false,
    hasSelfDestructable: false,
    hasReclaimableSelection: false,
    hasTowerTargetControl: false,
    hasTowerTargetActive: false,
    isTowerTargetMode: false,
    isWaiting: false,
    isGatherWaiting: false,
    isRepeatQueue: false,
    isHoldPosition: false,
    unitMoveState: 'maneuver',
    hasQueuedOrders: false,
    queueInsertIndex: null,
    queueInsertOptions: [],
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
    isManualLaunchMode: false,
    isGuardMode: false,
    isReclaimMode: false,
    isCaptureMode: false,
    isResurrectMode: false,
    isResurrectAreaMode: false,
    isLoadTransportMode: false,
    isUnloadTransportMode: false,
    isMexUpgradeMode: false,
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

  /** Authoritative game phase from snapshots — drives the HUD pause
   *  toggle/indicator. */
  const gamePhase = ref<GamePhase>('init');

  function bindGameSceneUi(scene: GameScene, includeGameLifecycle = false): void {
    bindSceneUiCallbacks(scene, {
      onPlayerChange: (playerId) => {
        activePlayer.value = playerId;
      },
      onGamePhaseChange: (phase) => {
        gamePhase.value = phase;
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

  /** Minimap right-click (BAR convention): issue the standard
   *  right-click command at the minimap world point. */
  function handleMinimapCommand(x: number, y: number, queue: boolean): void {
    getActiveBattleScene()?.issueMinimapCommand(x, y, queue);
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
    setQueueInsertIndex: (index) => {
      getActiveBattleScene()?.setQueueInsertIndex(index);
    },
    toggleUnitMoveState: () => {
      getActiveBattleScene()?.toggleUnitMoveState();
    },
    toggleTrajectoryMode: () => {
      getActiveBattleScene()?.toggleTrajectoryMode();
    },
    toggleCloakState: () => {
      getActiveBattleScene()?.toggleCloakState();
    },
    toggleSelectedWait: (queue, queueFront, queueInsertIndex) => {
      getActiveBattleScene()?.toggleSelectedWait(queue, queueFront, queueInsertIndex);
    },
    toggleSelectedGatherWait: (queue, queueFront, queueInsertIndex) => {
      getActiveBattleScene()?.toggleSelectedGatherWait(queue, queueFront, queueInsertIndex);
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
    selectIdleTransports: () => {
      getActiveBattleScene()?.selectIdleTransports();
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
    toggleManualLaunch: () => {
      getActiveBattleScene()?.toggleManualLaunchMode();
    },
    toggleGuard: () => {
      getActiveBattleScene()?.toggleGuardMode();
    },
    toggleReclaim: () => {
      getActiveBattleScene()?.toggleReclaimMode();
    },
    toggleCapture: () => {
      getActiveBattleScene()?.toggleCaptureMode();
    },
    toggleResurrect: () => {
      getActiveBattleScene()?.toggleResurrectMode();
    },
    toggleResurrectArea: () => {
      getActiveBattleScene()?.toggleResurrectAreaMode();
    },
    toggleLoadTransport: () => {
      getActiveBattleScene()?.toggleLoadTransportMode();
    },
    toggleUnloadTransport: () => {
      getActiveBattleScene()?.toggleUnloadTransportMode();
    },
    reclaimSelected: () => {
      getActiveBattleScene()?.reclaimSelected();
    },
    toggleMexUpgrade: () => {
      getActiveBattleScene()?.toggleMexUpgradeMode();
    },
    upgradeSelectedMetalExtractors: () => {
      getActiveBattleScene()?.upgradeSelectedMetalExtractors();
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
    handleMinimapCommand,
    gamePhase,
    selectionActions,
  };
}
