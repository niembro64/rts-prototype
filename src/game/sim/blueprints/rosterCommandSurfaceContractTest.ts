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
  unitBlueprintHasBarAreaAttackCommand,
  unitBlueprintHasBarManualLaunchCommand,
  unitBlueprintHasBarMoveStateCommand,
  unitBlueprintHasBarTrajectoryCommand,
  unitBlueprintBarTrajectoryDefaultMode,
  unitBlueprintHasBarCarrierSpawnCommand,
  unitBlueprintHasBarCaptureCommand,
  unitBlueprintHasBarBuilderPriorityCommand,
  buildingBlueprintHasBarBuilderPriorityCommand,
  buildingBlueprintHasBarFactoryGuardCommand,
  buildingBlueprintHasBarTrajectoryCommand,
} from '../unitCommandCapabilities';

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
  'combat.restore',
] as const satisfies readonly CommandHotkeyId[];

const BAR_EQUIVALENT_BUILD_CATEGORY_SLOT_INDEX = new Map<StructureBlueprintId, number>([
  ['buildingExtractor', 0],
  ['buildingSolar', 1],
  ['buildingWind', 2],
  ['buildingResourceConverter', 4],
  ['buildingExtractorT2', 6],
  ['buildingRadar', 0],
  ['towerFabricator', 0],
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

const BAR_EQUIVALENT_FACTORY_SLOT_INDEX = new Map<UnitBlueprintId, number>([
  ['unitConstructionDrone', 0],
  ['unitLynx', 2],
  ['unitJackal', 3],
  ['unitBadger', 5],
  ['unitMongoose', 6],
  ['unitTick', BAR_GRID_SLOT_COUNT + 3],
  ['unitTarantula', BAR_GRID_SLOT_COUNT + 6],
  ['unitEagle', (BAR_GRID_SLOT_COUNT * 2) + 1],
  ['unitDragonfly', (BAR_GRID_SLOT_COUNT * 2) + 3],
  ['unitBee', (BAR_GRID_SLOT_COUNT * 2) + 4],
  ['unitTransport', (BAR_GRID_SLOT_COUNT * 2) + 5],
]);

const BAR_EQUIVALENT_GRID_FACTORY_UNIT_ORDER: readonly UnitBlueprintId[] = [
  'unitConstructionDrone',
  'unitLynx',
  'unitJackal',
  'unitBadger',
  'unitMongoose',
  'unitTick',
  'unitTarantula',
  'unitEagle',
  'unitDragonfly',
  'unitBee',
  'unitTransport',
];

const BAR_EQUIVALENT_CLASSIC_FACTORY_UNIT_ORDER: readonly UnitBlueprintId[] = [
  'unitConstructionDrone',
  'unitBee',
  'unitEagle',
  'unitDragonfly',
  'unitTick',
  'unitJackal',
  'unitLynx',
  'unitBadger',
  'unitMongoose',
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
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Production', 0, commanderBuildBlueprintIds) === 'towerFabricator',
    'commander BAR Build slot 1 must build the fabricator',
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
        'towerFabricator BAR-grid factory cells must preserve vehicle, bot, and air pages from BAR lab grids',
      );
      assertContract(
        barGridFactoryUnitCells[1] === null &&
          barGridFactoryUnitCells[4] === null &&
          barGridFactoryUnitCells[7] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT + 1] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT + 2] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT + 4] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT + 5] === null &&
          barGridFactoryUnitCells[BAR_GRID_SLOT_COUNT * 2] === null,
        'towerFabricator BAR-grid factory cells must keep empty BAR lab slots instead of compacting options',
      );
      assertContract(
        buildFactoryUnitBlueprintIdsForPreset(allowedUnitBlueprintIds, 'prototype').includes('unitLoris'),
        'towerFabricator prototype factory menu may keep the shield unit with no BAR T1 analogue',
      );
      assertContract(
        !barGridFactoryUnitBlueprintIds.includes('unitLoris'),
        'towerFabricator BAR-grid factory menu must hide unitLoris because it has no BAR T1 analogue',
      );
      assertContract(
        resolveFactoryProductionPresetReplay({
          selectedUnitBlueprintId: 'unitLoris',
          repeatProduction: true,
          productionQueue: [],
        }, new Set(buildFactoryUnitBlueprintIdsForPreset(allowedUnitBlueprintIds, 'prototype')))
          ?.selectedUnitBlueprintId === 'unitLoris',
        'towerFabricator prototype factory presets may replay unitLoris from the prototype roster',
      );
      assertContract(
        resolveFactoryProductionPresetReplay({
          selectedUnitBlueprintId: 'unitLoris',
          repeatProduction: true,
          productionQueue: [],
        }, new Set(barGridFactoryUnitBlueprintIds)) === null,
        'towerFabricator BAR-grid factory presets must reject hidden unitLoris',
      );
      assertContract(
        resolveFactoryProductionPresetReplay({
          selectedUnitBlueprintId: 'unitLoris',
          repeatProduction: true,
          productionQueue: [],
        }, new Set(buildFactoryUnitBlueprintIdsForPreset(allowedUnitBlueprintIds, 'bar-legacy'))) === null,
        'towerFabricator BAR-legacy factory presets must reject hidden unitLoris',
      );
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

  const barMoveStateHiddenUnitIds = UNIT_BLUEPRINT_IDS.filter((unitBlueprintId) =>
    !unitBlueprintHasBarMoveStateCommand(unitBlueprintId),
  );
  assertSameMembers('BAR-equivalent move-state hidden bomber units', barMoveStateHiddenUnitIds, ['unitDragonfly']);

  const barManualLaunchUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarManualLaunchCommand);
  assertSameMembers('BAR-equivalent manual-launch command units', barManualLaunchUnitIds, []);

  const barCaptureUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarCaptureCommand);
  assertSameMembers('BAR-equivalent capture command units', barCaptureUnitIds, ['unitCommander']);

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
  assertContract(
    commandHotkeyLabel('combat.restore', 'bar-grid') === 'M',
    'BAR-grid Restore is a visible order command on M',
  );
  assertContract(
    commandHotkeyLabel('combat.restore', 'bar-legacy') === '',
    'BAR-legacy Restore must not steal M from Move',
  );
}
