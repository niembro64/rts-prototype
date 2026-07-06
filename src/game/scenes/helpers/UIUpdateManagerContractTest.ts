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
      lowPriority: true,
      carrierSpawnEnabled: false,
      moveState: 'holdPosition',
      airIdleState: 'land',
      repeatProduction: false,
      paused: false,
      productionQueue: [],
      productionQuotas: {},
      productionQuotaCounts: {},
      currentBuildProgress: 0,
      guardTargetId: null,
      isProducing: false,
    },
  } as unknown as Entity;
}

function activeBuildingEntity(
  id: number,
  buildingBlueprintId: StructureBlueprintId,
): Entity {
  return {
    id,
    type: 'building',
    unit: null,
    builder: null,
    combat: null,
    buildingBlueprintId,
    ownership: { playerId: 1 as PlayerId },
    factory: null,
    buildable: null,
    building: {
      hp: 100,
      maxHp: 100,
      activeState: {
        open: true,
        damageDelayMs: 0,
        reopenDelayMs: 0,
      },
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
  const bee = world.createUnitFromBlueprint(128, 64, 1, 'unitBee', {
    allocateSubEntityIds: false,
  });
  const eagle = world.createUnitFromBlueprint(160, 64, 1, 'unitEagle', {
    allocateSubEntityIds: false,
  });

  const constructionDroneSelection = buildSelectionInfo(
    entitySourceForSelection([constructionDrone], []),
    undefined,
  );
  assertContract(
    constructionDroneSelection.hasBuilder &&
      !constructionDroneSelection.hasBarResurrectControl &&
      !constructionDroneSelection.hasBarAttackControl &&
      !constructionDroneSelection.hasFireControl,
    'construction-drone/armcv constructor analogue must not expose BAR Resurrect, Attack, or Fire State controls',
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
  const beeSelection = buildSelectionInfo(
    entitySourceForSelection([bee], []),
    undefined,
  );
  assertContract(
    !beeSelection.hasBarAttackControl &&
      !beeSelection.hasFireControl &&
      !beeSelection.hasTowerTargetControl,
    'unitBee/armpeep scout analogue must not expose BAR weapon command controls',
  );
  const eagleSelection = buildSelectionInfo(
    entitySourceForSelection([eagle], []),
    undefined,
  );
  assertContract(
    eagleSelection.hasBarAttackControl &&
      eagleSelection.hasFireControl &&
      eagleSelection.hasTowerTargetControl,
    'unitEagle/armfig fighter analogue must expose BAR weapon controls for air-target attacks',
  );

  const fabricatorSelection = buildSelectionInfo(
    entitySourceForSelection([], [factoryTowerEntity(10, 'towerFabricator')]),
    undefined,
  );
  assertContract(
    fabricatorSelection.hasFactory &&
      fabricatorSelection.hasFactoryGuardControl &&
      fabricatorSelection.hasFactoryAirIdleControl &&
      fabricatorSelection.factoryAirIdleState === 'land' &&
      fabricatorSelection.hasMoveStateControl &&
      fabricatorSelection.unitMoveState === 'holdPosition' &&
      fabricatorSelection.hasBuilderPriorityControl &&
      fabricatorSelection.builderPriorityLow,
    'towerFabricator selection must expose BAR Factory Guard, Air LandAt, Move State, and default-low Builder Priority controls',
  );

  const pausedFabricator = factoryTowerEntity(12, 'towerFabricator');
  pausedFabricator.factory!.paused = true;
  const pausedFabricatorSelection = buildSelectionInfo(
    entitySourceForSelection([], [pausedFabricator]),
    undefined,
  );
  assertContract(
    pausedFabricatorSelection.isWaiting,
    'paused factory selection must light the shared BAR Wait state',
  );

  const t1MexSelection = buildSelectionInfo(
    entitySourceForSelection([], [activeBuildingEntity(20, 'buildingExtractor')]),
    undefined,
  );
  const t2MexSelection = buildSelectionInfo(
    entitySourceForSelection([], [activeBuildingEntity(21, 'buildingExtractorT2')]),
    undefined,
  );
  assertContract(
    t1MexSelection.hasBarBuildingActiveControl &&
      !t1MexSelection.hasBarBuildingStopControl &&
      t2MexSelection.hasBarBuildingActiveControl &&
      t2MexSelection.hasBarBuildingStopControl,
    'BAR armamex/buildingExtractorT2 must expose Stop while armmex/buildingExtractor keeps removestop=true and only exposes ON/OFF',
  );
  const converterSelection = buildSelectionInfo(
    entitySourceForSelection([], [activeBuildingEntity(22, 'buildingResourceConverter')]),
    undefined,
  );
  assertContract(
    converterSelection.hasBarBuildingActiveControl &&
      !converterSelection.hasBarBuildingStopControl &&
      converterSelection.details.some((row) => row.label === 'Power' && row.value === 'On'),
    'BAR armmakr/buildingResourceConverter analogue must expose ON/OFF and selected-info active state without Stop',
  );

  const nonBarFactorySelection = buildSelectionInfo(
    entitySourceForSelection([], [factoryTowerEntity(11, 'towerCannon')]),
    undefined,
  );
  assertContract(
    nonBarFactorySelection.hasFactory &&
      !nonBarFactorySelection.hasFactoryGuardControl &&
      !nonBarFactorySelection.hasFactoryAirIdleControl,
    'factory-capable non-BAR-factory-guard structures must not expose Factory Guard or Air LandAt controls',
  );
}
