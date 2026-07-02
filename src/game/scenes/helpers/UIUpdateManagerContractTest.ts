import type { Entity, PlayerId, StructureBlueprintId } from '../../sim/types';
import type { UIEntitySource } from '../../../types/ui';
import { WorldState } from '../../sim/WorldState';
import { buildSelectionInfo } from './UIUpdateManager';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[ui update manager contract] ${message}`);
  }
}

function factoryTowerEntity(
  id: number,
  buildingBlueprintId: StructureBlueprintId,
): Entity {
  return {
    id,
    type: 'tower',
    unit: null,
    builder: null,
    combat: null,
    building: null,
    buildable: null,
    buildingBlueprintId,
    ownership: { playerId: 1 as PlayerId },
    factory: {
      selectedUnitBlueprintId: null,
      lowPriority: false,
      carrierSpawnEnabled: false,
      repeatProduction: false,
      productionQueue: [],
      productionQuotas: {},
      productionQuotaCounts: {},
      currentBuildProgress: 0,
      guardTargetId: null,
      isProducing: false,
    },
  } as unknown as Entity;
}

function entitySourceForSelection(
  selectedUnits: readonly Entity[],
  selectedBuildings: readonly Entity[],
): UIEntitySource {
  return {
    getUnits: () => [...selectedUnits],
    getBuildings: () => [...selectedBuildings],
    getUnitsAndBuildings: () => [...selectedUnits, ...selectedBuildings],
    getSelectedUnits: () => [...selectedUnits],
    getSelectedBuildings: () => [...selectedBuildings],
    getBuildingsByPlayer: () => [],
    getUnitsByPlayer: () => [...selectedUnits],
  };
}

export function runUIUpdateManagerContractTest(): void {
  const world = new WorldState(1, 512, 512);
  const constructionDrone = world.createUnitFromBlueprint(64, 64, 1, 'unitConstructionDrone', {
    allocateSubEntityIds: false,
  });
  const jackal = world.createUnitFromBlueprint(96, 64, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });

  const constructionDroneSelection = buildSelectionInfo(
    entitySourceForSelection([constructionDrone], []),
    undefined,
  );
  assertContract(
    constructionDroneSelection.hasBuilder &&
      !constructionDroneSelection.hasBarAttackControl &&
      !constructionDroneSelection.hasFireControl,
    'construction-drone build pylons must not expose BAR Attack or Fire State controls',
  );

  const jackalSelection = buildSelectionInfo(
    entitySourceForSelection([jackal], []),
    undefined,
  );
  assertContract(
    jackalSelection.hasBarAttackControl &&
      jackalSelection.hasFireControl,
    'weapon units must expose BAR Attack and Fire State controls',
  );

  const fabricatorSelection = buildSelectionInfo(
    entitySourceForSelection([], [factoryTowerEntity(10, 'towerFabricator')]),
    undefined,
  );
  assertContract(
    fabricatorSelection.hasFactory &&
      fabricatorSelection.hasFactoryGuardControl,
    'towerFabricator selection must expose BAR Factory Guard control',
  );

  const nonBarFactorySelection = buildSelectionInfo(
    entitySourceForSelection([], [factoryTowerEntity(11, 'towerCannon')]),
    undefined,
  );
  assertContract(
    nonBarFactorySelection.hasFactory &&
      !nonBarFactorySelection.hasFactoryGuardControl,
    'factory-capable non-BAR-factory-guard structures must not expose Factory Guard control',
  );
}
