import { computed, nextTick, onUnmounted, watch, type ComputedRef, type Ref } from 'vue';
import {
  loadStoredCenterMagnitude,
  loadStoredDividersMagnitude,
  loadStoredMapLandDimensions,
  loadStoredMetalDepositStep,
  loadStoredTerrainDTerrain,
  loadStoredTerrainDetail,
  loadStoredTerrainMapShape,
  type BattleMode,
} from '../battleBarConfig';
import type { PlayerId } from '../game/sim/types';
import type { TerrainMapShape } from '../types/terrain';

type GameCanvasLobbyPreviewOptions = {
  backgroundContainerRef: Ref<HTMLDivElement | null>;
  gameAreaRef: Ref<HTMLDivElement | null>;
  currentBattleMode: ComputedRef<BattleMode>;
  lobbyModalVisible: ComputedRef<boolean>;
  roomCode: Ref<string>;
  gameStarted: Ref<boolean>;
  lobbyPlayerCount: ComputedRef<number>;
  localPlayerId: Ref<PlayerId>;
  centerMagnitude: Ref<number>;
  dividersMagnitude: Ref<number>;
  terrainMapShape: Ref<TerrainMapShape>;
  terrainDTerrain: Ref<number>;
  metalDepositStep: Ref<number>;
  terrainDetail: Ref<number>;
  mapWidthLandCells: Ref<number>;
  mapLengthLandCells: Ref<number>;
  stopBackgroundBattle: () => void;
  startBackgroundBattle: () => void;
};

export function useGameCanvasLobbyPreview({
  backgroundContainerRef,
  gameAreaRef,
  currentBattleMode,
  lobbyModalVisible,
  roomCode,
  gameStarted,
  lobbyPlayerCount,
  localPlayerId,
  centerMagnitude,
  dividersMagnitude,
  terrainMapShape,
  terrainDTerrain,
  metalDepositStep,
  terrainDetail,
  mapWidthLandCells,
  mapLengthLandCells,
  stopBackgroundBattle,
  startBackgroundBattle,
}: GameCanvasLobbyPreviewOptions): void {
  const inGameLobby = computed(
    () => roomCode.value !== '' && lobbyModalVisible.value,
  );
  let disposed = false;

  function restartPreviewBattle(): void {
    stopBackgroundBattle();
    nextTick(() => {
      if (disposed) return;
      startBackgroundBattle();
    });
  }

  watch(currentBattleMode, (mode) => {
    centerMagnitude.value = loadStoredCenterMagnitude(mode);
    dividersMagnitude.value = loadStoredDividersMagnitude(mode);
    terrainMapShape.value = loadStoredTerrainMapShape(mode);
    terrainDTerrain.value = loadStoredTerrainDTerrain(mode);
    metalDepositStep.value = loadStoredMetalDepositStep(mode);
    terrainDetail.value = loadStoredTerrainDetail(mode);
    const mapDimensions = loadStoredMapLandDimensions(mode);
    mapWidthLandCells.value = mapDimensions.widthLandCells;
    mapLengthLandCells.value = mapDimensions.lengthLandCells;
    if (!gameStarted.value) restartPreviewBattle();
  });

  watch(lobbyPlayerCount, () => {
    if (
      currentBattleMode.value === 'real' &&
      !gameStarted.value &&
      inGameLobby.value
    ) {
      restartPreviewBattle();
    }
  });

  watch(localPlayerId, () => {
    if (
      currentBattleMode.value === 'real' &&
      !gameStarted.value &&
      inGameLobby.value
    ) {
      restartPreviewBattle();
    }
  });

  watch(inGameLobby, (active) => {
    const container = backgroundContainerRef.value;
    if (!container) return;
    nextTick(() => {
      if (disposed || !container.isConnected) return;
      if (active) {
        const target = document.getElementById('lobby-preview-target');
        if (target && container.parentElement !== target) {
          target.appendChild(container);
        }
        return;
      }
      const home = gameAreaRef.value;
      if (home && container.parentElement !== home) {
        home.appendChild(container);
      }
    });
  });

  onUnmounted(() => {
    disposed = true;
  });
}
