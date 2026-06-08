import type { TerrainBuildabilityGrid } from '@/types/terrain';
import type { BuildingBlueprintId, Entity } from '../sim/types';
import {
  generateMetalDeposits,
  type MetalDeposit,
} from '../../metalDepositConfig';
import {
  getBuildingPlacementDiagnostics,
  getOccupiedBuildingCells,
  getSnappedBuildPosition,
  type BuildPlacementDiagnostics,
} from '../input/helpers';

type BuildPlacementEntitySource = {
  getBuildings: () => Entity[];
  getEntitySetVersion?: () => number;
  getTerrainBuildabilityGrid?: () => TerrainBuildabilityGrid | null;
};

export class Input3DBuildPlacementState {
  private mapWidth = Infinity;
  private mapHeight = Infinity;
  private metalDeposits: ReadonlyArray<MetalDeposit> = [];
  private validationKey = '';
  private occupancyVersion = '';
  private occupiedCells: ReadonlySet<string> | undefined;

  canPlace = false;
  diagnostics: BuildPlacementDiagnostics | undefined;

  get width(): number {
    return this.mapWidth;
  }

  get height(): number {
    return this.mapHeight;
  }

  setMapBounds(
    width: number,
    height: number,
    playerCount: number,
  ): void {
    this.mapWidth = width;
    this.mapHeight = height;
    this.metalDeposits = generateMetalDeposits(width, height, playerCount);
  }

  reset(): void {
    this.validationKey = '';
    this.canPlace = false;
    this.diagnostics = undefined;
  }

  clearDiagnostics(): void {
    this.diagnostics = undefined;
  }

  validate(
    buildingBlueprintId: BuildingBlueprintId,
    worldX: number,
    worldY: number,
    entitySource: BuildPlacementEntitySource,
  ): BuildPlacementDiagnostics {
    const snapped = getSnappedBuildPosition(worldX, worldY, buildingBlueprintId);
    const buildings = entitySource.getBuildings();
    const entitySetVersion = entitySource.getEntitySetVersion?.() ?? buildings.length;
    const terrainBuildabilityGrid = entitySource.getTerrainBuildabilityGrid?.() ?? null;
    const occupancyVersion = `${entitySetVersion}`;
    if (occupancyVersion !== this.occupancyVersion || !this.occupiedCells) {
      this.occupancyVersion = occupancyVersion;
      this.occupiedCells = getOccupiedBuildingCells(buildings);
    }

    const validationKey = [
      buildingBlueprintId,
      snapped.gridX,
      snapped.gridY,
      this.mapWidth,
      this.mapHeight,
      entitySetVersion,
      terrainBuildabilityGrid?.version ?? 0,
      terrainBuildabilityGrid?.configKey ?? '',
    ].join(':');
    if (validationKey !== this.validationKey || !this.diagnostics) {
      this.validationKey = validationKey;
      this.diagnostics = getBuildingPlacementDiagnostics(
        buildingBlueprintId, snapped.x, snapped.y,
        this.mapWidth, this.mapHeight,
        buildings,
        this.metalDeposits,
        this.occupiedCells,
        terrainBuildabilityGrid,
      );
      this.canPlace = this.diagnostics.canPlace;
    }
    return this.diagnostics;
  }
}
