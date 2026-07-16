import {
  STRUCTURE_BLUEPRINT_IDS,
  UNIT_BLUEPRINT_IDS,
  type StructureBlueprintId,
  type UnitBlueprintId,
} from '../../../types/blueprintIds';
import {
  COMMAND_HOTKEY_IDS,
  COMMAND_HOTKEY_PRESET_IDS,
  commandHotkeyLabel,
  type CommandHotkeyId,
} from '../../input/commandHotkeys';
import {
  BAR_GRID_SLOT_COUNT,
  buildBarClassicBuildMenuItems,
  buildBarClassicFactoryUnitBlueprintIds,
  buildBarGridFactoryUnitBlueprintCells,
  buildFactoryUnitBlueprintIdsForPreset,
  buildBarHomeBuildMenuCells,
  buildStructureMenuLayout,
  getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex,
} from '../../input/buildMenuLayout';
import { resolveFactoryProductionPresetReplay } from '../../input/factoryProductionPresets';
import { getStructureFactoryAllowedUnitBlueprintIds } from '../factoryProductionRoster';
import { getUnitBuilderAllowedBuildBlueprintIds } from '../builderBuildRoster';
import { createTransportComponentForUnitBlueprint } from '../transports';
import {
  buildingBlueprintHasActiveState,
  buildingBlueprintHasBarOnOffCommand,
} from '../buildingActiveState';
import { BUILDING_BLUEPRINTS } from './buildings';
import {
  structureRosterDisplay,
  unitRosterDisplay,
} from './displayRosters';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './unitRoster';
import { UNIT_BLUEPRINTS } from './units';
import {
  entityHasBarAreaAttackCommand,
  entityHasBarAttackCommand,
  entityHasBarFireControlCommand,
  entityHasBarSetTargetCommand,
  entityMatchesBarLegacyGroundWeaponSelection,
  unitBlueprintHasBarAreaAttackCommand,
  unitBlueprintBarDefaultFireState,
  unitBlueprintBarDefaultMoveState,
  unitBlueprintHasBarBomberNoAirTargetRule,
  unitBlueprintHasBarFighterAirTargetOnlyRule,
  unitBlueprintHasBarManualLaunchCommand,
  unitBlueprintHasBarMoveStateCommand,
  unitBlueprintHasBarTrajectoryCommand,
  unitBlueprintIsBarAirTarget,
  unitBlueprintBarTrajectoryDefaultMode,
  unitBlueprintHasBarCarrierSpawnCommand,
  unitBlueprintHasBarCaptureCommand,
  unitBlueprintHasBarResurrectCommand,
  unitBlueprintHasBarBuilderPriorityCommand,
  unitBlueprintHasCloakCommand,
  buildingBlueprintHasBarAirTargetOnlyRule,
  buildingBlueprintHasBarAirPlantLandAtCommand,
  buildingBlueprintHasBarBuilderPriorityCommand,
  buildingBlueprintHasBarFactoryGuardCommand,
  buildingBlueprintHasBarStopCommand,
  buildingBlueprintHasBarTrajectoryCommand,
} from '../unitCommandCapabilities';
import { WorldState } from '../WorldState';

const REQUIRED_SPECIAL_COMMAND_IDS = [
  'command.dgun',
  'combat.loadTransport',
  'combat.unloadTransport',
  'combat.manualLaunch',
  'combat.resurrect',
  'combat.resurrectArea',
  'combat.towerTargetSet',
  'combat.towerTargetSetNoGround',
  'combat.towerTargetClear',
] as const satisfies readonly CommandHotkeyId[];

const REQUIRED_BAR_ORDER_COMMAND_IDS = [
  'command.areaMex',
  'command.builderPriority',
  'command.carrierSpawn',
  'command.morph',
  'factory.airIdleState',
  'combat.restore',
] as const satisfies readonly CommandHotkeyId[];

const BAR_EQUIVALENT_BUILD_CATEGORY_SLOT_INDEX = new Map<StructureBlueprintId, number>([
  ['buildingExtractor', 0],
  ['buildingSolar', 1],
  ['buildingWind', 2],
  ['buildingResourceConverter', 4],
  ['buildingExtractorT2', 6],
  ['buildingRadar', 0],
  ['towerFabricator', 2],
  ['towerCannon', 0],
  ['towerBeamMega', 1],
  ['towerAntiAir', 4],
]);

const BAR_EQUIVALENT_HOME_SLOT_INDEX = new Map<StructureBlueprintId, number>([
  ['buildingExtractor', 0],
  ['towerCannon', 1],
  ['buildingRadar', 2],
  ['towerFabricator', 3],
  ['buildingSolar', 4],
  ['towerBeamMega', 5],
  ['buildingWind', 8],
]);

const BAR_EQUIVALENT_CLASSIC_BUILD_ORDER: readonly StructureBlueprintId[] = [
  'buildingExtractor',
  'buildingExtractorT2',
  'buildingResourceConverter',
  'buildingWind',
  'buildingSolar',
  'towerFabricator',
  'buildingRadar',
  'towerCannon',
  'towerBeamMega',
  'towerAntiAir',
];

const BAR_STRUCTURE_UNITDEF_BY_LOCAL_ID = new Map<StructureBlueprintId, string>([
  ['buildingSolar', 'armsolar'],
  ['buildingWind', 'armwin'],
  ['buildingExtractor', 'armmex'],
  ['buildingExtractorT2', 'armamex'],
  ['buildingResourceConverter', 'armmakr'],
  ['towerFabricator', 'armap'],
  ['buildingRadar', 'armrad'],
  ['towerCannon', 'armllt'],
  ['towerBeamMega', 'armbeamer'],
  ['towerAntiAir', 'armrl'],
]);

const BAR_FACTORY_UNITDEF_BY_LOCAL_ID = new Map<UnitBlueprintId, string>([
  ['unitConstructionDrone', 'armca'],
  ['unitBee', 'armpeep'],
  ['unitEagle', 'armfig'],
  ['unitAlbatros', 'armkam'],
  ['unitDragonfly', 'armthund'],
  ['unitTransport', 'armatlas'],
  ['unitLynx', 'armflash'],
  ['unitJackal', 'armfav'],
  ['unitMongoose', 'armart'],
  ['unitBadger', 'armjanus'],
  ['unitTick', 'armflea'],
  ['unitTarantula', 'armwar'],
]);

const BAR_ARMCOM_BUILDOPTIONS = new Set<string>([
  'armsolar',
  'armwin',
  'armmstor',
  'armestor',
  'armmex',
  'armmakr',
  'armlab',
  'armvp',
  'armap',
  'armeyes',
  'armrad',
  'armdrag',
  'armllt',
  'armrl',
  'armdl',
  'armtide',
  'armuwms',
  'armuwes',
  'armfmkr',
  'armsy',
  'armfdrag',
  'armtl',
  'armfrt',
  'armfrad',
  'armhp',
  'armfhp',
]);

const BAR_ARMCA_BUILDOPTIONS = new Set<string>([
  'armsolar',
  'armadvsol',
  'armwin',
  'armgeo',
  'armmstor',
  'armestor',
  'armmex',
  'armamex',
  'armmakr',
  'armaap',
  'armlab',
  'armvp',
  'armap',
  'armhp',
  'armnanotc',
  'armeyes',
  'armrad',
  'armdrag',
  'armclaw',
  'armllt',
  'armbeamer',
  'armhlt',
  'armguard',
  'armrl',
  'armferret',
  'armcir',
  'armdl',
  'armjamt',
  'armjuno',
  'armsy',
  'armuwgeo',
]);

const BAR_ARMAP_BUILDOPTIONS = new Set<string>([
  'armca',
  'armpeep',
  'armfig',
  'armthund',
  'armatlas',
  'armkam',
  'armhvytrans',
]);

const BAR_ARMVP_BUILDOPTIONS = new Set<string>([
  'armcv',
  'armbeaver',
  'armmlv',
  'armfav',
  'armflash',
  'armpincer',
  'armstump',
  'armart',
  'armjanus',
  'armsam',
]);

const BAR_ARMLAB_BUILDOPTIONS = new Set<string>([
  'armck',
  'armpw',
  'armrectr',
  'armrock',
  'armham',
  'armjeth',
  'armwar',
  'armflea',
]);

const BAR_T1_FACTORY_BUILDOPTION_SETS: readonly {
  name: string;
  buildoptions: ReadonlySet<string>;
}[] = [
  { name: 'armvp', buildoptions: BAR_ARMVP_BUILDOPTIONS },
  { name: 'armlab', buildoptions: BAR_ARMLAB_BUILDOPTIONS },
  { name: 'armap', buildoptions: BAR_ARMAP_BUILDOPTIONS },
];

const BAR_EQUIVALENT_FACTORY_SLOT_INDEX = new Map<UnitBlueprintId, number>([
  ['unitLynx', 2],
  ['unitJackal', 3],
  ['unitBadger', 5],
  ['unitMongoose', 6],
  ['unitSeaTurtle', 8],
  ['unitOrca', 9],
  ['unitTick', BAR_GRID_SLOT_COUNT + 3],
  ['unitTarantula', BAR_GRID_SLOT_COUNT + 6],
  ['unitConstructionDrone', BAR_GRID_SLOT_COUNT * 2],
  ['unitEagle', (BAR_GRID_SLOT_COUNT * 2) + 1],
  ['unitAlbatros', (BAR_GRID_SLOT_COUNT * 2) + 2],
  ['unitDragonfly', (BAR_GRID_SLOT_COUNT * 2) + 3],
  ['unitBee', (BAR_GRID_SLOT_COUNT * 2) + 4],
  ['unitTransport', (BAR_GRID_SLOT_COUNT * 2) + 5],
]);

const BAR_EQUIVALENT_GRID_FACTORY_UNIT_ORDER: readonly UnitBlueprintId[] = [
  'unitLynx',
  'unitJackal',
  'unitBadger',
  'unitMongoose',
  'unitSeaTurtle',
  'unitOrca',
  'unitTick',
  'unitTarantula',
  'unitConstructionDrone',
  'unitEagle',
  'unitAlbatros',
  'unitDragonfly',
  'unitBee',
  'unitTransport',
];

const BAR_EQUIVALENT_CLASSIC_FACTORY_UNIT_ORDER: readonly UnitBlueprintId[] = [
  'unitConstructionDrone',
  'unitBee',
  'unitEagle',
  'unitAlbatros',
  'unitDragonfly',
  'unitTick',
  'unitJackal',
  'unitLynx',
  'unitBadger',
  'unitMongoose',
  'unitSeaTurtle',
  'unitOrca',
  'unitTarantula',
  'unitTransport',
];

function isIntentionallyHiddenSpecialCommand(
  commandId: CommandHotkeyId,
  presetId: string,
): boolean {
  if (commandId === 'combat.resurrectArea') return (
    presetId === 'bar-grid' ||
    presetId === 'bar-grid-60pct' ||
    presetId === 'bar-legacy' ||
    presetId === 'bar-legacy-60pct'
  );
  return false;
}

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[roster command surface contract] ${message}`);
  }
}

function assertSameMembers(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((id) => !actualSet.has(id));
  const extra = actual.filter((id) => !expectedSet.has(id));
  assertContract(
    missing.length === 0 && extra.length === 0,
    `${label} mismatch; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
  );
}

function assertNoDuplicateMembers(label: string, values: readonly string[]): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.push(value);
      continue;
    }
    seen.add(value);
  }
  assertContract(
    duplicates.length === 0,
    `${label} must not contain duplicate ids; duplicates=[${duplicates.join(', ')}]`,
  );
}

function assertBarStructureMembershipMatchesUnitdef(
  localUnitBlueprintId: UnitBlueprintId,
  barUnitdefName: string,
  barBuildoptions: ReadonlySet<string>,
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): void {
  for (const [structureBlueprintId, barUnitdef] of BAR_STRUCTURE_UNITDEF_BY_LOCAL_ID) {
    const expected = barBuildoptions.has(barUnitdef);
    const actual = allowedBuildBlueprintIds.includes(structureBlueprintId);
    assertContract(
      actual === expected,
      `${localUnitBlueprintId}.${structureBlueprintId} BAR build-option membership must mirror ${barUnitdefName}.${barUnitdef}; expected ${expected ? 'present' : 'absent'}`,
    );
  }
}

function assertBarFactoryMembershipMatchesUnitdefs(
  localFactoryBlueprintId: StructureBlueprintId,
  allowedUnitBlueprintIds: readonly UnitBlueprintId[],
): void {
  for (const [unitBlueprintId, barUnitdef] of BAR_FACTORY_UNITDEF_BY_LOCAL_ID) {
    const containingFactories = BAR_T1_FACTORY_BUILDOPTION_SETS
      .filter((factory) => factory.buildoptions.has(barUnitdef))
      .map((factory) => factory.name);
    const expected = containingFactories.length > 0;
    const actual = allowedUnitBlueprintIds.includes(unitBlueprintId);
    assertContract(
      actual === expected,
      `${localFactoryBlueprintId}.${unitBlueprintId} BAR factory membership must mirror ${barUnitdef} in BAR T1 factories; expected ${expected ? 'present' : 'absent'} from [${containingFactories.join(', ')}]`,
    );
  }
}

function currentPlayerBuildableStructureIds(): StructureBlueprintId[] {
  return [...STRUCTURE_BLUEPRINT_IDS];
}

export function runRosterCommandSurfaceContractTest(): void {
  const expectedBuildableUnits = UNIT_BLUEPRINT_IDS.filter(
    (id): id is Exclude<UnitBlueprintId, 'unitCommander'> => id !== 'unitCommander',
  );
  const buildableUnitSet = new Set<string>(BUILDABLE_UNIT_BLUEPRINT_IDS);
  assertSameMembers(
    'buildable unit roster',
    BUILDABLE_UNIT_BLUEPRINT_IDS,
    expectedBuildableUnits,
  );
  assertSameMembers(
    'unit display roster',
    unitRosterDisplay.map((unit) => unit.unitBlueprintId),
    BUILDABLE_UNIT_BLUEPRINT_IDS,
  );

  const playerBuildableStructures = currentPlayerBuildableStructureIds();
  const playerBuildableStructureSet = new Set<StructureBlueprintId>(playerBuildableStructures);
  assertSameMembers(
    'structure display roster',
    structureRosterDisplay.map((structure) => structure.buildingBlueprintId),
    STRUCTURE_BLUEPRINT_IDS,
  );

  for (const structureBlueprintId of STRUCTURE_BLUEPRINT_IDS) {
    assertContract(
      BUILDING_BLUEPRINTS[structureBlueprintId] !== undefined,
      `stable structure ${structureBlueprintId} must have a static blueprint`,
    );
  }

  const commanderBuildBlueprintIds = getUnitBuilderAllowedBuildBlueprintIds(UNIT_BLUEPRINTS['unitCommander']);
  assertBarStructureMembershipMatchesUnitdef(
    'unitCommander',
    'armcom',
    BAR_ARMCOM_BUILDOPTIONS,
    commanderBuildBlueprintIds,
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Economy', 0, commanderBuildBlueprintIds) === 'buildingExtractor',
    'commander BAR Economy slot 1 must build the extractor',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Economy', 1, commanderBuildBlueprintIds) === 'buildingSolar',
    'commander BAR Economy slot 2 must build solar',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Economy', 2, commanderBuildBlueprintIds) === 'buildingWind',
    'commander BAR Economy slot 3 must build wind',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Economy', 4, commanderBuildBlueprintIds) === 'buildingResourceConverter',
    'commander BAR Economy slot 5 must build the resource converter',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Combat', 0, commanderBuildBlueprintIds) === 'towerCannon',
    'commander BAR Combat slot 1 must build the cannon tower',
  );
  assertContract(
    !commanderBuildBlueprintIds.includes('towerBeamMega'),
    'commander BAR roster must not include the heavy beam tower because ARM commander lacks armbeamer',
  );
  assertContract(
    !commanderBuildBlueprintIds.includes('buildingExtractorT2'),
    'commander BAR roster must not include the advanced extractor because ARM commander lacks armamex',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Combat', 1, commanderBuildBlueprintIds) === null,
    'commander BAR Combat slot 2 must stay empty because ARM commander lacks armbeamer',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Combat', 4, commanderBuildBlueprintIds) === 'towerAntiAir',
    'commander BAR Combat slot 5 must build anti-air',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Utility', 0, commanderBuildBlueprintIds) === 'buildingRadar',
    'commander BAR Utility slot 1 must build radar',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Production', 0, commanderBuildBlueprintIds) === null &&
      getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Production', 1, commanderBuildBlueprintIds) === null,
    'commander BAR Build slots 1-2 must stay empty because local towerFabricator maps to BAR armap, not armlab/armvp',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Production', 2, commanderBuildBlueprintIds) === 'towerFabricator',
    'commander BAR Build slot 3 must build the fabricator in the BAR armap air-plant position',
  );
  const commanderHomeCells = buildBarHomeBuildMenuCells(commanderBuildBlueprintIds);
  assertContract(
    commanderHomeCells[0]?.buildingBlueprintId === 'buildingExtractor' &&
      commanderHomeCells[4]?.buildingBlueprintId === 'buildingSolar' &&
      commanderHomeCells[8]?.buildingBlueprintId === 'buildingWind',
    'commander BAR home Economy column must stack extractor, solar, wind like ARM commander',
  );
  assertContract(
    commanderHomeCells[1]?.buildingBlueprintId === 'towerCannon' &&
      commanderHomeCells[5]?.buildingBlueprintId === 'towerAntiAir' &&
      commanderHomeCells[9] === null,
    'commander BAR home Combat column must stack cannon then anti-air when the beam-tower analogue is unavailable',
  );
  assertContract(
    commanderHomeCells[2]?.buildingBlueprintId === 'buildingRadar' &&
      commanderHomeCells[3]?.buildingBlueprintId === 'towerFabricator',
    'commander BAR home Utility/Build columns must expose radar and fabricator in the bottom row',
  );

  const constructionDroneBuildBlueprintIds = getUnitBuilderAllowedBuildBlueprintIds(UNIT_BLUEPRINTS['unitConstructionDrone']);
  assertBarStructureMembershipMatchesUnitdef(
    'unitConstructionDrone',
    'armca',
    BAR_ARMCA_BUILDOPTIONS,
    constructionDroneBuildBlueprintIds,
  );
  assertContract(
    constructionDroneBuildBlueprintIds.includes('towerBeamMega'),
    'construction drone BAR roster must include the beam tower because ARM T1 constructors have armbeamer',
  );
  assertContract(
    constructionDroneBuildBlueprintIds.includes('buildingExtractorT2'),
    'construction drone BAR roster must include the advanced extractor because ARM T1 constructors have armamex',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Economy', 6, constructionDroneBuildBlueprintIds) === 'buildingExtractorT2',
    'construction drone BAR Economy slot 7 must build the advanced extractor like ARM T1 constructors armamex',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Combat', 1, constructionDroneBuildBlueprintIds) === 'towerBeamMega',
    'construction drone BAR Combat slot 2 must build the beam tower like ARM T1 constructors armbeamer',
  );
  const constructionDroneHomeCells = buildBarHomeBuildMenuCells(constructionDroneBuildBlueprintIds);
  assertContract(
    constructionDroneHomeCells[1]?.buildingBlueprintId === 'towerCannon' &&
      constructionDroneHomeCells[5]?.buildingBlueprintId === 'towerBeamMega' &&
      constructionDroneHomeCells[9]?.buildingBlueprintId === 'towerAntiAir',
    'construction drone BAR home Combat column must stack cannon, beam tower, then anti-air like ARM T1 constructors',
  );

  const factoryStructureBlueprintIds = STRUCTURE_BLUEPRINT_IDS.filter(
    (structureBlueprintId) =>
      getStructureFactoryAllowedUnitBlueprintIds(structureBlueprintId).length > 0,
  );
  assertSameMembers('authored unit-producing structures', factoryStructureBlueprintIds, ['towerFabricator']);
  for (const structureBlueprintId of factoryStructureBlueprintIds) {
    const allowedUnitBlueprintIds = getStructureFactoryAllowedUnitBlueprintIds(structureBlueprintId);
    assertContract(
      allowedUnitBlueprintIds.length > 0,
      `${structureBlueprintId} factory roster must author at least one production option`,
    );
    assertNoDuplicateMembers(`${structureBlueprintId} factory roster`, allowedUnitBlueprintIds);
    for (const unitBlueprintId of allowedUnitBlueprintIds) {
      assertContract(
        buildableUnitSet.has(unitBlueprintId),
        `${structureBlueprintId} factory roster must only include buildable units; got ${unitBlueprintId}`,
      );
    }
    assertSameMembers(
      `${structureBlueprintId} production menu`,
      unitRosterDisplay
        .filter((unit) => allowedUnitBlueprintIds.includes(unit.unitBlueprintId as UnitBlueprintId))
        .map((unit) => unit.unitBlueprintId),
      allowedUnitBlueprintIds,
    );
    if (structureBlueprintId === 'towerFabricator') {
      assertBarFactoryMembershipMatchesUnitdefs(
        'towerFabricator',
        allowedUnitBlueprintIds,
      );
      assertSameMembers(
        'towerFabricator authored BAR-equivalent factory roster',
        allowedUnitBlueprintIds.filter((unitBlueprintId) =>
          BAR_EQUIVALENT_FACTORY_SLOT_INDEX.has(unitBlueprintId),
        ),
        BAR_EQUIVALENT_GRID_FACTORY_UNIT_ORDER,
      );
      const barGridFactoryUnitCells = buildBarGridFactoryUnitBlueprintCells(allowedUnitBlueprintIds);
      const barGridFactoryUnitBlueprintIds = buildFactoryUnitBlueprintIdsForPreset(
        allowedUnitBlueprintIds,
        'bar-grid',
      );
      for (const [unitBlueprintId, slotIndex] of BAR_EQUIVALENT_FACTORY_SLOT_INDEX) {
        assertContract(
          barGridFactoryUnitCells[slotIndex] === unitBlueprintId,
          `towerFabricator.${unitBlueprintId} must use BAR-equivalent factory slot ${slotIndex + 1}; got ${barGridFactoryUnitCells[slotIndex] ?? 'empty'}`,
        );
      }
      assertContract(
        barGridFactoryUnitCells.length === BAR_GRID_SLOT_COUNT * 3,
        'towerFabricator BAR-grid factory cells must preserve vehicle, bot, and air pages from BAR final labGrids assignments',
      );
      assertContract(
        UNIT_BLUEPRINTS.unitConstructionDrone.unitLocomotion.type === 'hover' &&
          UNIT_BLUEPRINTS.unitConstructionDrone.unitLocomotion.pathfindingBlueprintId === 'airborneAnywhere' &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT * 2] === 'unitConstructionDrone',
        'towerFabricator BAR-grid factory cells must place the airborne construction drone in the armap/armca air-constructor slot',
      );
      assertContract(
        barGridFactoryUnitCells[0] === null &&
          barGridFactoryUnitCells[1] === null &&
          barGridFactoryUnitCells[4] === null &&
          barGridFactoryUnitCells[7] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT + 1] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT + 2] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT + 4] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT + 5] === null &&
          barGridFactoryUnitCells[(BAR_GRID_SLOT_COUNT * 2) + 6] === null,
        'towerFabricator BAR-grid factory cells must keep empty BAR final labGrids vehicle/bot/air slots instead of compacting options',
      );
      for (const hiddenNonBarUnitBlueprintId of ['unitLoris'] as const) {
        assertContract(
          !buildFactoryUnitBlueprintIdsForPreset(allowedUnitBlueprintIds, 'prototype').includes(hiddenNonBarUnitBlueprintId),
          `towerFabricator prototype factory menu must not expose ${hiddenNonBarUnitBlueprintId} because it has no BAR T1 analogue`,
        );
        assertContract(
          !barGridFactoryUnitBlueprintIds.includes(hiddenNonBarUnitBlueprintId),
          `towerFabricator BAR-grid factory menu must hide ${hiddenNonBarUnitBlueprintId} because it has no BAR T1 analogue`,
        );
        assertContract(
          resolveFactoryProductionPresetReplay({
            selectedUnitBlueprintId: hiddenNonBarUnitBlueprintId,
            repeatProduction: true,
            productionQueue: [],
          }, new Set(buildFactoryUnitBlueprintIdsForPreset(allowedUnitBlueprintIds, 'prototype'))) === null,
          `towerFabricator prototype factory presets must reject ${hiddenNonBarUnitBlueprintId} because it is not an authored BAR-equivalent build option`,
        );
        assertContract(
          resolveFactoryProductionPresetReplay({
            selectedUnitBlueprintId: hiddenNonBarUnitBlueprintId,
            repeatProduction: true,
            productionQueue: [],
          }, new Set(barGridFactoryUnitBlueprintIds)) === null,
          `towerFabricator BAR-grid factory presets must reject hidden ${hiddenNonBarUnitBlueprintId}`,
        );
        assertContract(
          resolveFactoryProductionPresetReplay({
            selectedUnitBlueprintId: hiddenNonBarUnitBlueprintId,
            repeatProduction: true,
            productionQueue: [],
          }, new Set(buildFactoryUnitBlueprintIdsForPreset(allowedUnitBlueprintIds, 'bar-legacy'))) === null,
          `towerFabricator BAR-legacy factory presets must reject hidden ${hiddenNonBarUnitBlueprintId}`,
        );
      }
      assertContract(
        buildBarClassicFactoryUnitBlueprintIds(allowedUnitBlueprintIds).join('|') ===
          BAR_EQUIVALENT_CLASSIC_FACTORY_UNIT_ORDER.join('|'),
        'towerFabricator BAR-legacy classic factory menu must follow BAR buildmenu_sorting order',
      );
      assertContract(
        buildFactoryUnitBlueprintIdsForPreset(allowedUnitBlueprintIds, 'bar-grid').join('|') ===
          BAR_EQUIVALENT_GRID_FACTORY_UNIT_ORDER.join('|'),
        'towerFabricator BAR-grid factory keyboard slots must match the displayed BAR-equivalent grid order',
      );
      assertContract(
        buildFactoryUnitBlueprintIdsForPreset(allowedUnitBlueprintIds, 'bar-legacy').join('|') ===
          BAR_EQUIVALENT_CLASSIC_FACTORY_UNIT_ORDER.join('|'),
        'towerFabricator BAR-legacy factory keyboard slots must match the displayed classic buildmenu order',
      );
    }
  }

  for (const unitBlueprintId of UNIT_BLUEPRINT_IDS) {
    const unitBlueprint = UNIT_BLUEPRINTS[unitBlueprintId];
    assertContract(unitBlueprint !== undefined, `stable unit ${unitBlueprintId} must have a blueprint`);
    if (unitBlueprint.builder === null) continue;
    const allowedBuildBlueprintIds = getUnitBuilderAllowedBuildBlueprintIds(unitBlueprint);
    assertContract(
      allowedBuildBlueprintIds.length > 0,
      `${unitBlueprintId} builder roster must author at least one build option`,
    );
    assertNoDuplicateMembers(`${unitBlueprintId} builder roster`, allowedBuildBlueprintIds);
    for (const buildingBlueprintId of allowedBuildBlueprintIds) {
      assertContract(
        playerBuildableStructureSet.has(buildingBlueprintId),
        `${unitBlueprintId} builder roster must only include player-buildable structures; got ${buildingBlueprintId}`,
      );
    }

    const layout = buildStructureMenuLayout(allowedBuildBlueprintIds);
    assertSameMembers(
      `${unitBlueprintId} build menu`,
      layout.items.map((item) => item.buildingBlueprintId),
      allowedBuildBlueprintIds,
    );
    assertContract(
      layout.items.length === allowedBuildBlueprintIds.length,
      `${unitBlueprintId} build menu must display every authored builder option`,
    );
    assertNoDuplicateMembers(
      `${unitBlueprintId} build menu`,
      layout.items.map((item) => item.buildingBlueprintId),
    );
    for (const item of layout.items) {
      const expectedSlotIndex = BAR_EQUIVALENT_BUILD_CATEGORY_SLOT_INDEX.get(item.buildingBlueprintId);
      if (expectedSlotIndex !== undefined) {
        assertContract(
          item.slotIndex === expectedSlotIndex,
          `${unitBlueprintId}.${item.buildingBlueprintId} must use BAR-equivalent category slot ${expectedSlotIndex + 1}; got ${item.slotIndex + 1}`,
        );
      }
      assertContract(
        item.slotIndex >= 0 && item.slotIndex < BAR_GRID_SLOT_COUNT,
        `${unitBlueprintId}.${item.buildingBlueprintId} must map to a BAR-grid page slot`,
      );
      assertContract(
        commandHotkeyLabel(item.commandId, 'bar-grid').length > 0,
        `${unitBlueprintId}.${item.buildingBlueprintId} must expose a BAR-grid build-slot hotkey label`,
      );
      assertContract(
        commandHotkeyLabel(item.commandId, 'bar-legacy') === '',
        `${unitBlueprintId}.${item.buildingBlueprintId} must not expose fake BAR-legacy positional build-slot labels`,
      );
    }

    const classicItems = buildBarClassicBuildMenuItems(allowedBuildBlueprintIds);
    const expectedClassicOrder = BAR_EQUIVALENT_CLASSIC_BUILD_ORDER.filter((buildingBlueprintId) =>
      allowedBuildBlueprintIds.includes(buildingBlueprintId),
    );
    assertContract(
      classicItems.map((item) => item.buildingBlueprintId).join('|') === expectedClassicOrder.join('|'),
      `${unitBlueprintId} BAR-legacy classic build menu must follow BAR buildmenu_sorting order`,
    );

    const homeCells = buildBarHomeBuildMenuCells(allowedBuildBlueprintIds);
    for (const [buildingBlueprintId, slotIndex] of BAR_EQUIVALENT_HOME_SLOT_INDEX) {
      if (!allowedBuildBlueprintIds.includes(buildingBlueprintId)) continue;
      assertContract(
        homeCells[slotIndex]?.buildingBlueprintId === buildingBlueprintId,
        `${unitBlueprintId}.${buildingBlueprintId} must use BAR-equivalent home slot ${slotIndex + 1}`,
      );
    }
  }

  const dgunUnitIds = UNIT_BLUEPRINT_IDS.filter(
    (unitBlueprintId) => UNIT_BLUEPRINTS[unitBlueprintId].dgun !== null,
  );
  assertSameMembers('authored dgun units', dgunUnitIds, ['unitCommander']);

  const barCloakUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasCloakCommand);
  assertSameMembers('BAR-equivalent WANT_CLOAK command units', barCloakUnitIds, ['unitCommander']);

  const transportUnitIds = UNIT_BLUEPRINT_IDS.filter(
    (unitBlueprintId) => createTransportComponentForUnitBlueprint(unitBlueprintId) !== null,
  );
  assertSameMembers('authored transport units', transportUnitIds, ['unitTransport']);

  const barTrajectoryUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarTrajectoryCommand);
  assertSameMembers('BAR-equivalent trajectory command units', barTrajectoryUnitIds, ['unitMongoose']);
  assertContract(
    unitBlueprintBarTrajectoryDefaultMode('unitMongoose') === 'high',
    'BAR-equivalent Mongoose trajectory command must default to the armart hightrajectory state',
  );
  const barTrajectoryStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarTrajectoryCommand);
  assertSameMembers('BAR-equivalent smart trajectory command structures', barTrajectoryStructureIds, []);

  const barGroundAreaAttackUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarAreaAttackCommand);
  assertSameMembers('BAR-equivalent ground area-attack command units', barGroundAreaAttackUnitIds, ['unitMongoose']);
  const capabilityWorld = new WorldState(9501, 512, 512);
  const mongooseEntity = capabilityWorld.createUnitFromBlueprint(80, 80, 1, 'unitMongoose', {
    allocateSubEntityIds: false,
  });
  const eagleEntity = capabilityWorld.createUnitFromBlueprint(120, 80, 1, 'unitEagle', {
    allocateSubEntityIds: false,
  });
  const dragonflyEntity = capabilityWorld.createUnitFromBlueprint(160, 80, 1, 'unitDragonfly', {
    allocateSubEntityIds: false,
  });
  const beeEntity = capabilityWorld.createUnitFromBlueprint(200, 80, 1, 'unitBee', {
    allocateSubEntityIds: false,
  });
  assertContract(
    entityHasBarAreaAttackCommand(mongooseEntity),
    'BAR-equivalent Mongoose entity must expose Area Attack because armart has customParams.canareaattack',
  );
  assertContract(
    !entityHasBarAreaAttackCommand(eagleEntity) &&
      !entityHasBarAreaAttackCommand(dragonflyEntity) &&
      !entityHasBarAreaAttackCommand(beeEntity),
    'BAR Area Attack must not be inferred from flying/hover locomotion; BAR only adds it for canareaattack unitDefs',
  );

  const barMoveStateHiddenUnitIds = UNIT_BLUEPRINT_IDS.filter((unitBlueprintId) =>
    !unitBlueprintHasBarMoveStateCommand(unitBlueprintId),
  );
  assertSameMembers('BAR-equivalent move-state hidden bomber units', barMoveStateHiddenUnitIds, ['unitDragonfly']);
  const barDefaultHoldPositionUnitIds = UNIT_BLUEPRINT_IDS.filter((unitBlueprintId) =>
    unitBlueprintBarDefaultMoveState(unitBlueprintId) === 'holdPosition',
  );
  assertSameMembers('BAR-equivalent default hold-position units', barDefaultHoldPositionUnitIds, [
    'unitCommander',
    'unitJackal',
    'unitBadger',
    'unitMongoose',
    'unitTick',
    'unitDragonfly',
  ]);
  const barDefaultHoldFireUnitIds = UNIT_BLUEPRINT_IDS.filter((unitBlueprintId) =>
    unitBlueprintBarDefaultFireState(unitBlueprintId) === 'holdFire',
  );
  assertSameMembers('BAR-equivalent default hold-fire bomber units', barDefaultHoldFireUnitIds, ['unitDragonfly']);
  const barNoAirTargetUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarBomberNoAirTargetRule);
  assertSameMembers('BAR-equivalent air-to-ground-only units', barNoAirTargetUnitIds, [
    'unitAlbatros',
    'unitBadger',
    'unitDragonfly',
    'unitMongoose',
  ]);
  const barFighterAirTargetOnlyUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarFighterAirTargetOnlyRule);
  assertSameMembers('BAR-equivalent fighter air-target-only units', barFighterAirTargetOnlyUnitIds, ['unitEagle']);
  const barAirTargetOnlyStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarAirTargetOnlyRule);
  assertSameMembers('BAR-equivalent air-target-only structures', barAirTargetOnlyStructureIds, ['towerAntiAir']);
  const barStopStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarStopCommand);
  assertSameMembers('BAR-equivalent pure-building Stop command structures', barStopStructureIds, [
    'buildingExtractorT2',
  ]);
  const barAirTargetUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintIsBarAirTarget);
  assertSameMembers('BAR-equivalent air target units', barAirTargetUnitIds, [
    'unitBee',
    'unitConstructionDrone',
    'unitDragonfly',
    'unitEagle',
    'unitAlbatros',
    'unitQueenBee',
    'unitQueenTick',
    'unitTransport',
  ]);
  assertContract(
    !entityHasBarAttackCommand(beeEntity) &&
      !entityHasBarFireControlCommand(beeEntity) &&
      !entityHasBarSetTargetCommand(beeEntity),
    'BAR armpeep/unitBee scout analogue must expose no Attack, Fire State, or Set Target command because armpeep has no weapons',
  );
  assertContract(
    entityHasBarAttackCommand(eagleEntity) &&
      entityHasBarFireControlCommand(eagleEntity) &&
      entityHasBarSetTargetCommand(eagleEntity),
    'BAR armfig/unitEagle fighter analogue must retain weapon commands for air-target attacks',
  );
  assertContract(
    entityMatchesBarLegacyGroundWeaponSelection(mongooseEntity) &&
      !entityMatchesBarLegacyGroundWeaponSelection(eagleEntity) &&
      !entityMatchesBarLegacyGroundWeaponSelection(dragonflyEntity) &&
      !entityMatchesBarLegacyGroundWeaponSelection(beeEntity),
    'BAR legacy Ctrl+W Not_Aircraft_Weapons selector must include armed ground units and exclude aircraft/scouts',
  );

  const barManualLaunchUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarManualLaunchCommand);
  assertSameMembers('BAR-equivalent manual-launch command units', barManualLaunchUnitIds, []);

  const barCaptureUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarCaptureCommand);
  assertSameMembers('BAR-equivalent capture command units', barCaptureUnitIds, ['unitCommander']);

  const barResurrectUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarResurrectCommand);
  assertSameMembers('BAR-equivalent resurrect command units', barResurrectUnitIds, []);

  const barCarrierSpawnUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarCarrierSpawnCommand);
  assertSameMembers('BAR-equivalent carrier-spawn command units', barCarrierSpawnUnitIds, []);

  const barBuilderPriorityUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarBuilderPriorityCommand);
  assertSameMembers('BAR-equivalent builder-priority command units', barBuilderPriorityUnitIds, [
    'unitCommander',
    'unitConstructionDrone',
  ]);
  const barBuilderPriorityStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarBuilderPriorityCommand);
  assertSameMembers('BAR-equivalent builder-priority command structures', barBuilderPriorityStructureIds, [
    'towerFabricator',
  ]);

  const barFactoryGuardStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarFactoryGuardCommand);
  assertSameMembers('BAR-equivalent factory-guard command structures', barFactoryGuardStructureIds, [
    'towerFabricator',
  ]);

  const barAirPlantLandAtStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarAirPlantLandAtCommand);
  assertSameMembers('BAR-equivalent air-plant LAND_AT command structures', barAirPlantLandAtStructureIds, [
    'towerFabricator',
  ]);

  const activeStateStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasActiveState);
  assertSameMembers('prototype active-state structures', activeStateStructureIds, [
    'buildingSolar',
    'buildingWind',
    'buildingExtractor',
    'buildingExtractorT2',
    'buildingRadar',
    'buildingResourceConverter',
  ]);
  const barOnOffStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarOnOffCommand);
  assertSameMembers('BAR-equivalent ON/OFF command structures', barOnOffStructureIds, [
    'buildingSolar',
    'buildingExtractor',
    'buildingExtractorT2',
    'buildingResourceConverter',
  ]);

  for (const commandId of REQUIRED_SPECIAL_COMMAND_IDS) {
    assertContract(
      COMMAND_HOTKEY_IDS.includes(commandId),
      `${commandId} must be registered in the shared command-hotkey surface`,
    );
    for (const presetId of COMMAND_HOTKEY_PRESET_IDS) {
      if (isIntentionallyHiddenSpecialCommand(commandId, presetId)) {
        assertContract(
          commandHotkeyLabel(commandId, presetId) === '',
          `${presetId}.${commandId} must stay hidden because BAR resurrect is area-capable without a separate button`,
        );
        continue;
      }
      assertContract(
        commandHotkeyLabel(commandId, presetId).length > 0,
        `${presetId}.${commandId} must have a visible hotkey label`,
      );
    }
  }

  for (const commandId of REQUIRED_BAR_ORDER_COMMAND_IDS) {
    assertContract(
      COMMAND_HOTKEY_IDS.includes(commandId),
      `${commandId} must be registered in the shared command-hotkey surface`,
    );
  }
  assertContract(
    commandHotkeyLabel('command.areaMex', 'bar-grid') === '',
    'BAR-grid Area Mex is a visible order command but must not steal Z from build slot 1',
  );
  assertContract(
    commandHotkeyLabel('command.areaMex', 'bar-legacy') === 'Z',
    'BAR-legacy Area Mex must show the source BAR Z binding',
  );
  assertContract(
    commandHotkeyLabel('command.builderPriority', 'bar-grid') === '',
    'BAR-grid Builder Priority is a visible order command with no source default hotkey',
  );
  assertContract(
    commandHotkeyLabel('command.builderPriority', 'bar-legacy') === '',
    'BAR-legacy Builder Priority is a visible order command with no source default hotkey',
  );
  assertContract(
    commandHotkeyLabel('command.carrierSpawn', 'bar-grid') === '',
    'BAR-grid Carrier Spawning is a visible order command with no source default hotkey',
  );
  assertContract(
    commandHotkeyLabel('command.carrierSpawn', 'bar-legacy') === '',
    'BAR-legacy Carrier Spawning is a visible order command with no source default hotkey',
  );
  assertContract(
    commandHotkeyLabel('command.morph', 'bar-grid') === '',
    'BAR-grid Morph/Upgrade is a visible order command with no source default hotkey',
  );
  assertContract(
    commandHotkeyLabel('command.morph', 'bar-legacy') === '',
    'BAR-legacy Morph/Upgrade is a visible order command with no source default hotkey',
  );
}
