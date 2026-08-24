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
  buildBarGridFactoryUnitBlueprintCells,
  buildFactoryUnitBlueprintIdsForPreset,
  buildBarHomeBuildMenuCells,
  buildStructureMenuLayout,
  getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex,
} from '../../input/buildMenuLayout';
import { resolveFactoryProductionPresetReplay } from '../../input/factoryProductionPresets';
import { getStructureFactoryAllowedUnitBlueprintIds } from '../factoryProductionRoster';
import { getUnitAuthoredBuildBlueprintIds } from '../hostCapabilities';
import { createTransportComponentForUnitBlueprint } from '../transports';
import { buildingBlueprintHasActiveState } from '../buildingActiveState';
import { BUILDING_BLUEPRINTS, FABRICATOR_BLUEPRINT_IDS } from './buildings';
import {
  structureRosterDisplay,
  unitRosterDisplay,
} from './displayRosters';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './unitRoster';
import {
  getPrimaryProductionDomainForLocomotion,
  UNIT_BLUEPRINTS,
} from './units';
import { validateEntityDescription } from './entityDescriptionValidation';
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
] as const satisfies readonly CommandHotkeyId[];

const BAR_EQUIVALENT_BUILD_CATEGORY_SLOT_INDEX = new Map<StructureBlueprintId, number>([
  ['buildingExtractor', 0],
  ['buildingSolar', 1],
  ['buildingWind', 2],
  ['buildingResourceConverter', 4],
  ['buildingMetalStorage', 3],
  ['buildingEnergyStorage', 5],
  ['buildingExtractorT2', 6],
  ['buildingRadar', 0],
  ['buildingSonar', 1],
  ['buildingRadarJammer', 5],
  ['buildingSonarJammer', 6],
  ['buildingBotFabricator', 0],
  ['buildingVehicleFabricator', 1],
  ['buildingAircraftFabricator', 2],
  ['buildingNavalFabricator', 3],
  ['towerFabricator', 4],
  ['buildingAdvancedUniversalFabricator', 5],
  ['buildingAdvancedBotFabricator', 6],
  ['buildingAdvancedVehicleFabricator', 7],
  ['buildingAdvancedAircraftFabricator', 8],
  ['buildingAdvancedNavalFabricator', 9],
  ['buildingExperimentalUniversalFabricator', 10],
  ['towerCannon', 0],
  ['towerBeamMega', 1],
  ['towerAntiAir', 4],
  ['towerTorpedo', 2],
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
  'buildingMetalStorage',
  'buildingEnergyStorage',
  'buildingResourceConverter',
  'buildingWind',
  'buildingTidalGenerator',
  'buildingSolar',
  'buildingBotFabricator',
  'buildingVehicleFabricator',
  'towerFabricator',
  'buildingAircraftFabricator',
  'buildingNavalFabricator',
  'buildingAdvancedBotFabricator',
  'buildingAdvancedVehicleFabricator',
  'buildingAdvancedUniversalFabricator',
  'buildingAdvancedAircraftFabricator',
  'buildingAdvancedNavalFabricator',
  'buildingExperimentalUniversalFabricator',
  'buildingRadar',
  'buildingSonar',
  'buildingRadarJammer',
  'buildingSonarJammer',
  // Prototype-only tech structures sort directly after the intel pair
  // (barClassicBuildSortIndex 103200/103210/103220).
  'buildingShieldTargetingTech',
  'buildingShieldTech',
  'buildingPrecisionTargetingTech',
  'towerCannon',
  'towerHelios',
  'towerTorpedo',
  'towerBeamMega',
  'towerAntiAir',
  'towerInterceptor',
];

const BAR_STRUCTURE_UNITDEF_BY_LOCAL_ID = new Map<StructureBlueprintId, string>([
  ['buildingSolar', 'armsolar'],
  ['buildingWind', 'armwin'],
  ['buildingExtractor', 'armmex'],
  ['buildingExtractorT2', 'armamex'],
  ['buildingResourceConverter', 'armmakr'],
  ['buildingMetalStorage', 'armmstor'],
  ['buildingEnergyStorage', 'armestor'],
  ['towerFabricator', 'armap'],
  ['buildingRadar', 'armrad'],
  ['towerCannon', 'armllt'],
  ['towerBeamMega', 'armbeamer'],
  ['towerAntiAir', 'armrl'],
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

  const commanderBuildBlueprintIds = getUnitAuthoredBuildBlueprintIds(UNIT_BLUEPRINTS['unitCommander']);
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
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Production', 0, commanderBuildBlueprintIds) === 'buildingBotFabricator' &&
      getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Production', 1, commanderBuildBlueprintIds) === 'buildingVehicleFabricator' &&
      getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Production', 2, commanderBuildBlueprintIds) === 'buildingAircraftFabricator' &&
      getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Production', 3, commanderBuildBlueprintIds) === 'buildingNavalFabricator',
    'commander Production slots 1-4 must expose the four T1 specialist Fabricators',
  );
  assertContract(
    getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex('Production', 4, commanderBuildBlueprintIds) === 'towerFabricator',
    'commander Production slot 5 must expose the premium T1 Universal Fabricator',
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
      commanderHomeCells[9]?.buildingBlueprintId === 'towerHelios',
    'commander BAR home Combat column stacks cannon, anti-air, then the prototype Helios (deliberate widening past armcom)',
  );
  assertContract(
    commanderHomeCells[2]?.buildingBlueprintId === 'buildingRadar' &&
      commanderHomeCells[3]?.buildingBlueprintId === 'towerFabricator' &&
      commanderHomeCells[7]?.buildingBlueprintId === 'buildingBotFabricator' &&
      commanderHomeCells[11]?.buildingBlueprintId === 'buildingVehicleFabricator',
    'commander home Utility/Build columns must expose radar and the leading T1 production choices',
  );

  const constructionDroneBuildBlueprintIds = getUnitAuthoredBuildBlueprintIds(UNIT_BLUEPRINTS['unitConstructionDrone']);
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

  const constructionSubBuildBlueprintIds =
    getUnitAuthoredBuildBlueprintIds(UNIT_BLUEPRINTS.unitConstructionSubmarine);
  assertSameMembers(
    'construction submarine naval build roster',
    constructionSubBuildBlueprintIds,
    [
      'buildingExtractor',
      'buildingExtractorT2',
      'buildingResourceConverter',
      'buildingSonar',
      'buildingSonarJammer',
      'towerFabricator',
      'buildingAdvancedUniversalFabricator',
      'buildingNavalFabricator',
      'buildingAdvancedNavalFabricator',
      'buildingTidalGenerator',
      'towerTorpedo',
    ],
  );
  assertContract(
    !constructionSubBuildBlueprintIds.includes('buildingRadar') &&
      !constructionSubBuildBlueprintIds.includes('towerCannon') &&
      !constructionSubBuildBlueprintIds.includes('towerAntiAir'),
    'construction submarine must expose its naval roster instead of the land-defense roster',
  );

  const factoryStructureBlueprintIds = STRUCTURE_BLUEPRINT_IDS.filter(
    (structureBlueprintId) =>
      getStructureFactoryAllowedUnitBlueprintIds(structureBlueprintId).length > 0,
  );
  assertSameMembers(
    'derived unit-producing structures',
    factoryStructureBlueprintIds,
    FABRICATOR_BLUEPRINT_IDS,
  );
  for (const structureBlueprintId of factoryStructureBlueprintIds) {
    const allowedUnitBlueprintIds = getStructureFactoryAllowedUnitBlueprintIds(structureBlueprintId);
    const factoryIdentity = BUILDING_BLUEPRINTS[structureBlueprintId].factory;
    assertContract(
      factoryIdentity !== null,
      `${structureBlueprintId} must carry a factory identity`,
    );
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
    const identity = factoryIdentity!;
    const expectedRoster = UNIT_BLUEPRINT_IDS.filter((unitBlueprintId) => {
      const production = UNIT_BLUEPRINTS[unitBlueprintId].production;
      return production !== null &&
        production.techLevel === identity.techLevel &&
        (identity.domain === 'universal' || production.domains.includes(identity.domain));
    });
    assertSameMembers(`${structureBlueprintId} metadata-derived roster`, allowedUnitBlueprintIds, expectedRoster);
    const barGridCells = buildBarGridFactoryUnitBlueprintCells(allowedUnitBlueprintIds);
    assertContract(
      barGridCells.length >= BAR_GRID_SLOT_COUNT && barGridCells.length % BAR_GRID_SLOT_COUNT === 0,
      `${structureBlueprintId} BAR grid must contain complete pages`,
    );
    for (const presetId of ['prototype', 'bar-grid', 'bar-legacy'] as const) {
      const displayed = buildFactoryUnitBlueprintIdsForPreset(allowedUnitBlueprintIds, presetId);
      assertSameMembers(`${structureBlueprintId} ${presetId} menu`, displayed, allowedUnitBlueprintIds);
      for (const unitBlueprintId of allowedUnitBlueprintIds) {
        assertContract(
          resolveFactoryProductionPresetReplay({
            selectedUnitBlueprintId: unitBlueprintId,
            repeatProduction: true,
            productionQueue: [],
          }, new Set(displayed)) !== null,
          `${structureBlueprintId} ${presetId} preset must accept ${unitBlueprintId}`,
        );
      }
    }
  }

  // Specialist rosters are data-derived and need not be artificially balanced
  // to the same count. Every specialist-fabricated unit must include the
  // domain matching its primary chassis; extra domains are crossover only.
  for (const unitBlueprintId of BUILDABLE_UNIT_BLUEPRINT_IDS) {
    const blueprint = UNIT_BLUEPRINTS[unitBlueprintId];
    const production = blueprint.production;
    if (production === null) continue;
    const primaryDomain = getPrimaryProductionDomainForLocomotion(
      blueprint.unitLocomotion.type,
    );
    assertContract(
      production.domains.includes(primaryDomain),
      `${unitBlueprintId} ${blueprint.unitLocomotion.type} chassis must include ${primaryDomain}`,
    );
  }
  assertContract(
    !getStructureFactoryAllowedUnitBlueprintIds('buildingBotFabricator').includes('unitLoris'),
    'Loris is a tracked tank and must not appear in the Bot Fabricator',
  );
  assertContract(
    getStructureFactoryAllowedUnitBlueprintIds('buildingVehicleFabricator').includes('unitLoris'),
    'Loris is a tracked tank and must appear in the Vehicle Fabricator',
  );

  for (const unitBlueprintId of UNIT_BLUEPRINT_IDS) {
    const unitBlueprint = UNIT_BLUEPRINTS[unitBlueprintId];
    assertContract(unitBlueprint !== undefined, `stable unit ${unitBlueprintId} must have a blueprint`);
    if (unitBlueprint.builder === null) continue;
    const allowedBuildBlueprintIds = getUnitAuthoredBuildBlueprintIds(unitBlueprint);
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
  assertSameMembers('cloak command units', barCloakUnitIds, ['unitCommander', 'unitStealthScout']);

  const transportUnitIds = UNIT_BLUEPRINT_IDS.filter(
    (unitBlueprintId) => createTransportComponentForUnitBlueprint(unitBlueprintId) !== null,
  );
  assertSameMembers('authored transport units', transportUnitIds, ['unitTransport']);

  const barTrajectoryUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarTrajectoryCommand);
  assertSameMembers('trajectory command units', barTrajectoryUnitIds, ['unitMongoose', 'unitClusterArtillery']);
  assertContract(
    unitBlueprintBarTrajectoryDefaultMode('unitMongoose') === 'high',
    'BAR-equivalent Mongoose trajectory command must default to the armart hightrajectory state',
  );
  const barTrajectoryStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarTrajectoryCommand);
  assertSameMembers('BAR-equivalent smart trajectory command structures', barTrajectoryStructureIds, []);

  const barGroundAreaAttackUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarAreaAttackCommand);
  assertSameMembers('ground area-attack command units', barGroundAreaAttackUnitIds, ['unitMongoose', 'unitClusterArtillery']);
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
    'BAR Area Attack must not be inferred from plane/drone locomotion; BAR only adds it for canareaattack unitDefs',
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
    'unitTick',
    'unitJackal',
    'unitBadger',
    'unitMongoose',
    'unitClusterArtillery',
    'unitDragonfly',
  ]);
  assertContract(
    unitBlueprintBarDefaultMoveState('unitTick') === 'holdPosition',
    'BAR armflea/unitTick starts on hold-position while explicit Attack still pursues',
  );
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
    'unitClusterArtillery',
  ]);
  const barFighterAirTargetOnlyUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarFighterAirTargetOnlyRule);
  assertSameMembers('air-target-only units', barFighterAirTargetOnlyUnitIds, ['unitEagle', 'unitMissileRover']);
  const barAirTargetOnlyStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarAirTargetOnlyRule);
  assertSameMembers('no-ground-target structures', barAirTargetOnlyStructureIds, ['towerAntiAir', 'towerInterceptor']);
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
    'unitDuck',
    'unitAlbatros',
    'unitQueenBee',
    'unitTransport',
    'unitRadarScout',
    'unitDetector',
    'unitPetrel',
    'unitAdvancedConstructionDrone',
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

  const barCarrierSpawnUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarCarrierSpawnCommand);
  assertSameMembers('BAR-equivalent carrier-spawn command units', barCarrierSpawnUnitIds, []);

  const barBuilderPriorityUnitIds = UNIT_BLUEPRINT_IDS.filter(unitBlueprintHasBarBuilderPriorityCommand);
  assertSameMembers('BAR-equivalent builder-priority command units', barBuilderPriorityUnitIds, [
    'unitCommander',
    'unitConstructionDrone',
    'unitConstructionSubmarine',
    'unitConstructionBot',
    'unitConstructionRover',
    'unitAdvancedConstructionBot',
    'unitAdvancedConstructionRover',
    'unitAdvancedConstructionDrone',
    'unitAdvancedConstructionSubmarine',
  ]);
  const barBuilderPriorityStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarBuilderPriorityCommand);
  assertSameMembers('BAR-equivalent builder-priority command structures', barBuilderPriorityStructureIds, [
    'towerFabricator',
    'buildingBotFabricator',
    'buildingVehicleFabricator',
    'buildingAircraftFabricator',
    'buildingNavalFabricator',
    'buildingAdvancedUniversalFabricator',
    'buildingAdvancedBotFabricator',
    'buildingAdvancedVehicleFabricator',
    'buildingAdvancedAircraftFabricator',
    'buildingAdvancedNavalFabricator',
    'buildingExperimentalUniversalFabricator',
  ]);

  const barFactoryGuardStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarFactoryGuardCommand);
  assertSameMembers('BAR-equivalent factory-guard command structures', barFactoryGuardStructureIds, [
    'towerFabricator',
    'buildingBotFabricator',
    'buildingVehicleFabricator',
    'buildingAircraftFabricator',
    'buildingNavalFabricator',
    'buildingAdvancedUniversalFabricator',
    'buildingAdvancedBotFabricator',
    'buildingAdvancedVehicleFabricator',
    'buildingAdvancedAircraftFabricator',
    'buildingAdvancedNavalFabricator',
    'buildingExperimentalUniversalFabricator',
  ]);

  const barAirPlantLandAtStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasBarAirPlantLandAtCommand);
  assertSameMembers('BAR-equivalent air-plant LAND_AT command structures', barAirPlantLandAtStructureIds, [
    'towerFabricator',
    'buildingAircraftFabricator',
    'buildingAdvancedUniversalFabricator',
    'buildingAdvancedAircraftFabricator',
    'buildingExperimentalUniversalFabricator',
  ]);

  // Names and descriptions are blueprint identity, not UI copy. Validate the
  // complete catalogs (including non-fabricator units) so every frontend and
  // future native consumer receives the same bounded metadata.
  for (const unitBlueprintId of UNIT_BLUEPRINT_IDS) {
    validateEntityDescription(
      `unit blueprint ${unitBlueprintId}`,
      UNIT_BLUEPRINTS[unitBlueprintId],
    );
  }
  for (const buildingBlueprintId of STRUCTURE_BLUEPRINT_IDS) {
    validateEntityDescription(
      `building blueprint ${buildingBlueprintId}`,
      BUILDING_BLUEPRINTS[buildingBlueprintId],
    );
  }

  const daddy = UNIT_BLUEPRINTS.unitDaddy;
  assertContract(
    daddy.fullName === 'Daddy Longlegs' &&
      daddy.shortName === 'DADDY' &&
      daddy.identity.kind === 'animal' &&
      daddy.identity.animalClass === 'arachnid',
    'Daddy must explicitly represent a daddy longlegs arachnid',
  );

  // Full names own prose surfaces; short names own every five-character slot.
  // They are exact and unique across the mixed unit/building catalog.
  const shortNames = new Map<string, string>();
  for (const [entityId, shortName] of [
    ...UNIT_BLUEPRINT_IDS.map((unitBlueprintId) =>
      [unitBlueprintId, UNIT_BLUEPRINTS[unitBlueprintId].shortName] as const),
    ...STRUCTURE_BLUEPRINT_IDS.map((buildingBlueprintId) =>
      [buildingBlueprintId, BUILDING_BLUEPRINTS[buildingBlueprintId].shortName] as const),
  ]) {
    assertContract(
      /^[A-Z0-9-]{5}$/.test(shortName),
      `${entityId} must author exactly five uppercase letters, digits, or hyphens; got "${shortName}"`,
    );
    const owner = shortNames.get(shortName);
    assertContract(
      owner === undefined,
      `${entityId} and ${owner} both claim the five-character name ${shortName}`,
    );
    shortNames.set(shortName, entityId);
  }

  // Three-letter codes are an internal identifier for narrower fixed-width slots,
  // so they must actually be three letters and must not collide — including
  // across the unit/building line, since lists mix them.
  const tinyNames = new Map<string, string>();
  for (const unitBlueprintId of BUILDABLE_UNIT_BLUEPRINT_IDS) {
    const tinyName = UNIT_BLUEPRINTS[unitBlueprintId].tinyName;
    assertContract(
      /^[A-Z]{3}$/.test(tinyName),
      `${unitBlueprintId} must author exactly three uppercase letters; got "${tinyName}"`,
    );
    const owner = tinyNames.get(tinyName);
    assertContract(
      owner === undefined,
      `${unitBlueprintId} and ${owner} both claim the three-letter code ${tinyName}`,
    );
    tinyNames.set(tinyName, unitBlueprintId);
  }
  for (const buildingBlueprintId of STRUCTURE_BLUEPRINT_IDS) {
    const tinyName = BUILDING_BLUEPRINTS[buildingBlueprintId].tinyName;
    assertContract(
      /^[A-Z]{3}$/.test(tinyName),
      `${buildingBlueprintId} must author exactly three uppercase letters; got "${tinyName}"`,
    );
    const owner = tinyNames.get(tinyName);
    assertContract(
      owner === undefined,
      `${buildingBlueprintId} and ${owner} both claim the three-letter code ${tinyName}`,
    );
    tinyNames.set(tinyName, buildingBlueprintId);
  }

  const activeStateStructureIds = STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasActiveState);
  assertSameMembers('prototype active-state structures', activeStateStructureIds, [
    'buildingSolar',
    'buildingWind',
    'buildingExtractor',
    'buildingExtractorT2',
    'buildingRadar',
    'buildingSonar',
    'buildingRadarJammer',
    'buildingSonarJammer',
    'buildingResourceConverter',
    // Tech structures follow BAR's on/offable Targeting Facility
    // (armtarg): the per-player upgrade channel runs only while ON.
    'buildingShieldTargetingTech',
    'buildingShieldTech',
    'buildingPrecisionTargetingTech',
  ]);
  // ON/OFF is capability-gated on the local active-state mechanic, not on BAR's
  // onoffable unitDef flag: BAR's armwin/armrad/armsonar analogues carry the
  // same authoritative production + 0.1x-damage fortify tradeoff here, so every
  // active-state structure must expose the command in every preset. A structure
  // with the state and no toggle is a live mechanic the player cannot reach.
  assertSameMembers(
    'ON/OFF command structures',
    STRUCTURE_BLUEPRINT_IDS.filter(buildingBlueprintHasActiveState),
    activeStateStructureIds,
  );

  for (const commandId of REQUIRED_SPECIAL_COMMAND_IDS) {
    assertContract(
      COMMAND_HOTKEY_IDS.includes(commandId),
      `${commandId} must be registered in the shared command-hotkey surface`,
    );
    for (const presetId of COMMAND_HOTKEY_PRESET_IDS) {
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
