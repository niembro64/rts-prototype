import { computed, nextTick, watch, type ComputedRef, type Ref } from 'vue';
import {
  loadStoredMapLandDimensions,
  loadStoredTerrainCenter,
  loadStoredTerrainDividers,
  loadStoredTerrainMapShape,
  type BattleMode,
} from '../battleBarConfig';
import type { PlayerId } from '../game/sim/types';
import type { TerrainMapShape, TerrainShape } from '../types/terrain';

export type GameCanvasLobbyPreviewOptions = {
  backgroundContainerRef: Ref<HTMLDivElement | null>;
  gameAreaRef: Ref<HTMLDivElement | null>;
  currentBattleMode: ComputedRef<BattleMode>;
  lobbyModalVisible: ComputedRef<boolean>;
  roomCode: Ref<string>;
  gameStarted: Ref<boolean>;
  lobbyPlayerCount: ComputedRef<number>;
  localPlayerId: Ref<PlayerId>;
  terrainCenter: Ref<TerrainShape>;
  terrainDividers: Ref<TerrainShape>;
  terrainMapShape: Ref<TerrainMapShape>;
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
  terrainCenter,
  terrainDividers,
  terrainMapShape,
  mapWidthLandCells,
  mapLengthLandCells,
  stopBackgroundBattle,
  startBackgroundBattle,
}: GameCanvasLobbyPreviewOptions): void {
  const inGameLobby = computed(
    () => roomCode.value !== '' && lobbyModalVisible.value,
  );

  function restartPreviewBattle(): void {
    stopBackgroundBattle();
    nextTick(() => {
      startBackgroundBattle();
    });
  }

  watch(currentBattleMode, (mode) => {
    terrainCenter.value = loadStoredTerrainCenter(mode);
    terrainDividers.value = loadStoredTerrainDividers(mode);
    terrainMapShape.value = loadStoredTerrainMapShape(mode);
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
}
