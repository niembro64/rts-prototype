import { computed, nextTick, onUnmounted, watch, type ComputedRef, type Ref } from 'vue';
import {
  loadStoredCenterMagnitude,
  loadStoredDividersMagnitude,
  loadStoredRingMagnitude,
  loadStoredMapLandDimensions,
  loadStoredMetalDepositStep,
  loadStoredPlateauWallSlopeDegrees,
  loadStoredPerimeterMagnitude,
  loadStoredTerrainPrecedence,
  loadStoredTerrainDTerrain,
  loadStoredTerrainDetail,
  loadStoredSimulationTickRate,
  type BattleMode,
} from '../battleBarConfig';
import type { TerrainPrecedence } from '../types/terrainPrecedence';
import type { PlayerId } from '../game/sim/types';

type GameCanvasLobbyPreviewOptions = {
  backgroundContainerRef: Ref<HTMLDivElement | null>;
  gameAreaRef: Ref<HTMLDivElement | null>;
  currentBattleMode: ComputedRef<BattleMode>;
  lobbyModalVisible: ComputedRef<boolean>;
  roomCode: Ref<string>;
  gameStarted: Ref<boolean>;
  /** The preview's SIDE layout: declared side count plus every seat's side.
   *  Terrain slices are carved per side, so this — not the seat count — is
   *  what a change must restart the preview on; cycling a seat to another
   *  team or adding a side redraws the map even when nobody joined. */
  lobbySidesKey: ComputedRef<string>;
  localPlayerId: Ref<PlayerId>;
  centerMagnitude: Ref<number>;
  ringMagnitude: Ref<number>;
  dividersMagnitude: Ref<number>;
  perimeterMagnitude: Ref<number>;
  terrainPrecedence: Ref<TerrainPrecedence>;
  terrainDTerrain: Ref<number>;
  plateauWallSlopeDegrees: Ref<number>;
  metalDepositStep: Ref<number>;
  terrainDetail: Ref<number>;
  simulationTickRateHz: Ref<number>;
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
  lobbySidesKey,
  localPlayerId,
  centerMagnitude,
  ringMagnitude,
  dividersMagnitude,
  perimeterMagnitude,
  terrainPrecedence,
  terrainDTerrain,
  plateauWallSlopeDegrees,
  metalDepositStep,
  terrainDetail,
  simulationTickRateHz,
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
    ringMagnitude.value = loadStoredRingMagnitude(mode);
    dividersMagnitude.value = loadStoredDividersMagnitude(mode);
    perimeterMagnitude.value = loadStoredPerimeterMagnitude(mode);
    terrainPrecedence.value = loadStoredTerrainPrecedence(mode);
    terrainDTerrain.value = loadStoredTerrainDTerrain(mode);
    plateauWallSlopeDegrees.value = loadStoredPlateauWallSlopeDegrees(mode);
    metalDepositStep.value = loadStoredMetalDepositStep(mode);
    terrainDetail.value = loadStoredTerrainDetail(mode);
    simulationTickRateHz.value = loadStoredSimulationTickRate(mode);
    const mapDimensions = loadStoredMapLandDimensions(mode);
    mapWidthLandCells.value = mapDimensions.widthLandCells;
    mapLengthLandCells.value = mapDimensions.lengthLandCells;
    if (!gameStarted.value) restartPreviewBattle();
  });

  watch([lobbySidesKey, localPlayerId], () => {
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
      if (disposed) return;
      // A DISCONNECTED container is the NORM here, not an error: when a
      // battle starts, the lobby modal unmounts and Vue destroys the
      // subtree WITH the adopted container inside it, cutting the node out
      // of the document. appendChild re-attaches a detached node, so both
      // moves below are also the recovery path — the old
      // `!container.isConnected` bail is exactly what used to orphan the
      // preview permanently: every battle exit after the first left the
      // demo/preview simulation rendering into a detached div, which read
      // as "going back to the lobby breaks the simulation".
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
