import type { BuildingBlueprintId, StructureBlueprintId } from '../sim/types';
import {
  BUILD_MENU_CATEGORY_ORDER,
  structureBuildCategory,
  type BuildMenuCategory,
} from '../sim/blueprints/displayRosters';
import {
  BUILD_MENU_GRID_SLOT_COMMAND_IDS,
  isBarGridCommandHotkeyPreset,
  isBarLegacyCommandHotkeyPreset,
  type CommandHotkeyId,
  type CommandHotkeyPresetId,
} from './commandHotkeys';

export { BUILD_MENU_GRID_SLOT_COMMAND_IDS };

export const BAR_GRID_COLUMNS = 4;
export const BAR_GRID_ROWS = 3;
export const BAR_GRID_SLOT_COUNT = BAR_GRID_COLUMNS * BAR_GRID_ROWS;

export type BarBuildCategoryId = 'Economy' | 'Combat' | 'Utility' | 'Production';
export type BarLegacyBuildKey = 'Z' | 'X' | 'C' | 'V';

type BarBuildCategory = {
  id: BarBuildCategoryId;
  sourceCategory: BuildMenuCategory;
  label: string;
  description: string;
  iconPath: string;
  keyCommandId: CommandHotkeyId;
};

export const BAR_BUILD_CATEGORIES: readonly BarBuildCategory[] = [
  { id: 'Economy', sourceCategory: 'Economy', label: 'Economy', description: 'Show economy structures', iconPath: 'assets/ui/groupicons/energy.svg', keyCommandId: 'build.slot1' },
  { id: 'Combat', sourceCategory: 'Defense', label: 'Combat', description: 'Show combat and defensive structures', iconPath: 'assets/ui/groupicons/weapon.svg', keyCommandId: 'build.slot2' },
  { id: 'Utility', sourceCategory: 'Intel', label: 'Utility', description: 'Show utility structures', iconPath: 'assets/ui/groupicons/util.svg', keyCommandId: 'build.slot3' },
  { id: 'Production', sourceCategory: 'Production', label: 'Build', description: 'Show production structures', iconPath: 'assets/ui/groupicons/builder.svg', keyCommandId: 'build.slot4' },
];

export type BuildMenuLayoutItem = {
  buildingBlueprintId: BuildingBlueprintId;
  category: BuildMenuCategory;
  slotIndex: number;
  commandId: CommandHotkeyId;
  gridRow: number;
  gridColumn: number;
};

type BuildMenuLayoutGroup = {
  category: BuildMenuCategory;
  items: BuildMenuLayoutItem[];
};

type BuildMenuLayout = {
  items: BuildMenuLayoutItem[];
  groups: BuildMenuLayoutGroup[];
};

type IndexedUnitBlueprintId = {
  unitBlueprintId: string;
  originalIndex: number;
};

const BAR_EQUIVALENT_FACTORY_UNIT_BLUEPRINT_IDS = new Set<string>([
  'unitConstructionDrone',
  'unitBee',
  'unitEagle',
  'unitDuck',
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
]);

const BAR_GRID_FACTORY_UNIT_SLOT_INDEX = new Map<string, number>([
  // Page 1 follows BAR's final labGrids["armvp"] vehicle-plant slots:
  // empty armcv/armmlv analogue slots, armflash, armfav,
  // empty armstump analogue, armjanus, armart.
  ['unitLynx', 2],
  ['unitJackal', 3],
  ['unitBadger', 5],
  ['unitMongoose', 6],
  ['unitSeaTurtle', 8],
  ['unitOrca', 9],
  // Page 2 follows BAR's final labGrids["armlab"] bot-lab slots:
  // empty constructor/support/Peewee slots, armflea,
  // empty armrock/armham analogue slots, armwar.
  ['unitTick', BAR_GRID_SLOT_COUNT + 3],
  ['unitTarantula', BAR_GRID_SLOT_COUNT + 6],
  // Page 3 follows BAR armap air-plant slots:
  // armca, armfig, armkam, armthund, armpeep, armatlas,
  // plus the local dive Duck in the final air-page cell.
  ['unitConstructionDrone', BAR_GRID_SLOT_COUNT * 2],
  ['unitEagle', (BAR_GRID_SLOT_COUNT * 2) + 1],
  ['unitAlbatros', (BAR_GRID_SLOT_COUNT * 2) + 2],
  ['unitDragonfly', (BAR_GRID_SLOT_COUNT * 2) + 3],
  ['unitBee', (BAR_GRID_SLOT_COUNT * 2) + 4],
  ['unitTransport', (BAR_GRID_SLOT_COUNT * 2) + 5],
  ['unitDuck', (BAR_GRID_SLOT_COUNT * 2) + 6],
]);

export function buildStructureMenuLayout(
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): BuildMenuLayout {
  const originalIndexById = new Map<StructureBlueprintId, number>();
  const orderedIds = new Array<StructureBlueprintId>(allowedBuildBlueprintIds.length);
  for (let i = 0; i < allowedBuildBlueprintIds.length; i++) {
    const id = allowedBuildBlueprintIds[i];
    originalIndexById.set(id, i);
    orderedIds[i] = id;
  }
  orderedIds.sort((a, b) =>
    compareStructureBuildMenuOrder(a, b, originalIndexById),
  );
  const items: BuildMenuLayoutItem[] = [];
  const usedSlotsByCategory = new Map<BuildMenuCategory, Set<number>>();

  for (let index = 0; index < orderedIds.length; index++) {
    const buildingBlueprintId = orderedIds[index] as BuildingBlueprintId;
    const category = structureBuildCategory(buildingBlueprintId);
    const slotIndex = nextAvailableSlotIndex(
      usedSlotsByCategory,
      category,
      preferredStructureBuildGridSlotIndex(buildingBlueprintId),
    );
    items.push({
      buildingBlueprintId,
      category,
      slotIndex,
      commandId: BUILD_MENU_GRID_SLOT_COMMAND_IDS[slotIndex],
      gridRow: Math.floor(slotIndex / BAR_GRID_COLUMNS) + 1,
      gridColumn: (slotIndex % BAR_GRID_COLUMNS) + 1,
    });
  }

  const groups: BuildMenuLayoutGroup[] = [];
  for (const category of BUILD_MENU_CATEGORY_ORDER) {
    const categoryItems: BuildMenuLayoutItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.category === category) categoryItems.push(item);
    }
    if (categoryItems.length > 0) groups.push({ category, items: categoryItems });
  }

  return { items, groups };
}


export function buildBarHomeBuildMenuCells(
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): (BuildMenuLayoutItem | null)[] {
  const cells = new Array<BuildMenuLayoutItem | null>(BAR_GRID_SLOT_COUNT);
  for (let i = 0; i < cells.length; i++) cells[i] = null;
  const itemById = new Map<StructureBlueprintId, BuildMenuLayoutItem>();
  for (const item of buildStructureMenuLayout(allowedBuildBlueprintIds).items) {
    itemById.set(item.buildingBlueprintId, item);
  }

  for (let categoryIndex = 0; categoryIndex < BAR_HOME_BUILD_ORDER.length; categoryIndex++) {
    const categoryOrder = BAR_HOME_BUILD_ORDER[categoryIndex];
    let categoryRowIndex = 0;
    for (let i = 0; i < categoryOrder.length && categoryRowIndex < BAR_GRID_ROWS; i++) {
      const buildingBlueprintId = categoryOrder[i];
      const item = itemById.get(buildingBlueprintId);
      if (item === undefined) continue;
      const slotIndex = categoryIndex + (categoryRowIndex * BAR_GRID_COLUMNS);
      cells[slotIndex] = {
        ...item,
        slotIndex,
        commandId: BUILD_MENU_GRID_SLOT_COMMAND_IDS[slotIndex],
        gridRow: Math.floor(slotIndex / BAR_GRID_COLUMNS) + 1,
        gridColumn: (slotIndex % BAR_GRID_COLUMNS) + 1,
      };
      categoryRowIndex++;
    }
  }
  return cells;
}

export function buildBarClassicBuildMenuItems(
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): BuildMenuLayoutItem[] {
  const layout = buildStructureMenuLayout(allowedBuildBlueprintIds);
  return [...layout.items].sort((a, b) =>
    barClassicBuildSortIndex(a.buildingBlueprintId) - barClassicBuildSortIndex(b.buildingBlueprintId),
  );
}

function buildBarClassicFactoryUnitBlueprintIds(
  allowedUnitBlueprintIds: readonly string[],
): string[] {
  return allowedUnitBlueprintIds
    .map((unitBlueprintId, originalIndex): IndexedUnitBlueprintId => ({ unitBlueprintId, originalIndex }))
    .sort((a, b) => {
      const sortDelta =
        barClassicFactoryUnitSortIndex(a.unitBlueprintId)
        - barClassicFactoryUnitSortIndex(b.unitBlueprintId);
      return sortDelta !== 0 ? sortDelta : a.originalIndex - b.originalIndex;
    })
    .map((item) => item.unitBlueprintId);
}

export function buildBarGridFactoryUnitBlueprintCells(
  allowedUnitBlueprintIds: readonly string[],
): (string | null)[] {
  const allowedBarEquivalentUnitBlueprintIds = allowedUnitBlueprintIds.filter((unitBlueprintId) =>
    BAR_EQUIVALENT_FACTORY_UNIT_BLUEPRINT_IDS.has(unitBlueprintId),
  );
  let maxSlotIndex = 0;
  for (const unitBlueprintId of allowedBarEquivalentUnitBlueprintIds) {
    const slotIndex = BAR_GRID_FACTORY_UNIT_SLOT_INDEX.get(unitBlueprintId);
    if (slotIndex !== undefined) maxSlotIndex = Math.max(maxSlotIndex, slotIndex);
  }
  const pageCount = Math.max(1, Math.ceil((maxSlotIndex + 1) / BAR_GRID_SLOT_COUNT));
  const cells = new Array<string | null>(pageCount * BAR_GRID_SLOT_COUNT);
  for (let i = 0; i < cells.length; i++) cells[i] = null;

  for (const unitBlueprintId of allowedBarEquivalentUnitBlueprintIds) {
    const slotIndex = BAR_GRID_FACTORY_UNIT_SLOT_INDEX.get(unitBlueprintId);
    if (slotIndex !== undefined && cells[slotIndex] === null) {
      cells[slotIndex] = unitBlueprintId;
      continue;
    }
    const fallbackSlotIndex = nextAvailableFactoryGridCellIndex(cells);
    cells[fallbackSlotIndex] = unitBlueprintId;
  }

  // Preserve the exact BAR-equivalent pages above, then append every locally
  // authored production option that has no BAR analogue. Factory capability
  // must not disappear merely because the active hotkey preset is BAR-shaped.
  const additionalUnitBlueprintIds = allowedUnitBlueprintIds.filter((unitBlueprintId) =>
    !BAR_EQUIVALENT_FACTORY_UNIT_BLUEPRINT_IDS.has(unitBlueprintId),
  );
  if (additionalUnitBlueprintIds.length > 0) {
    const additionalStartIndex = allowedBarEquivalentUnitBlueprintIds.length > 0 ? cells.length : 0;
    const requiredCellCount = additionalStartIndex + additionalUnitBlueprintIds.length;
    const totalCellCount = Math.ceil(requiredCellCount / BAR_GRID_SLOT_COUNT) * BAR_GRID_SLOT_COUNT;
    while (cells.length < totalCellCount) cells.push(null);
    for (let i = 0; i < additionalUnitBlueprintIds.length; i++) {
      cells[additionalStartIndex + i] = additionalUnitBlueprintIds[i];
    }
  }

  return cells;
}

export function buildFactoryUnitBlueprintIdsForPreset(
  allowedUnitBlueprintIds: readonly string[],
  presetId: CommandHotkeyPresetId,
): string[] {
  if (isBarLegacyCommandHotkeyPreset(presetId)) {
    return buildBarClassicFactoryUnitBlueprintIds(allowedUnitBlueprintIds);
  }
  if (isBarGridCommandHotkeyPreset(presetId)) {
    return buildBarGridFactoryUnitBlueprintCells(allowedUnitBlueprintIds).filter(
      (unitBlueprintId): unitBlueprintId is string => unitBlueprintId !== null,
    );
  }
  return [...allowedUnitBlueprintIds];
}

export function buildFactoryUnitGridCellsForPreset(
  allowedUnitBlueprintIds: readonly string[],
  presetId: CommandHotkeyPresetId,
): (string | null)[] {
  if (isBarGridCommandHotkeyPreset(presetId)) {
    return buildBarGridFactoryUnitBlueprintCells(allowedUnitBlueprintIds);
  }
  const unitBlueprintIds = buildFactoryUnitBlueprintIdsForPreset(allowedUnitBlueprintIds, presetId);
  const pageCount = Math.max(1, Math.ceil(unitBlueprintIds.length / BAR_GRID_SLOT_COUNT));
  const cells = new Array<string | null>(pageCount * BAR_GRID_SLOT_COUNT);
  for (let i = 0; i < cells.length; i++) cells[i] = unitBlueprintIds[i] ?? null;
  return cells;
}

export function getBarHomeBuildMenuStructureBlueprintIdBySlotIndex(
  slotIndex: number,
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): BuildingBlueprintId | null {
  return buildBarHomeBuildMenuCells(allowedBuildBlueprintIds)[slotIndex]?.buildingBlueprintId ?? null;
}

export function getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex(
  categoryId: BarBuildCategoryId,
  slotIndex: number,
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
  pageIndex = 0,
): BuildingBlueprintId | null {
  const category = BAR_BUILD_CATEGORIES.find((entry) => entry.id === categoryId);
  if (category === undefined) return null;
  const layout = buildStructureMenuLayout(allowedBuildBlueprintIds);
  const firstItemIndex = Math.max(0, Math.floor(pageIndex)) * BAR_GRID_SLOT_COUNT;
  const lastItemIndex = firstItemIndex + BAR_GRID_SLOT_COUNT;
  let categoryItemIndex = 0;
  for (const item of layout.items) {
    if (item.category !== category.sourceCategory) continue;
    const itemIndex = categoryItemIndex;
    categoryItemIndex++;
    if (itemIndex < firstItemIndex) continue;
    if (itemIndex >= lastItemIndex) break;
    if (item.slotIndex === slotIndex) return item.buildingBlueprintId;
  }
  return null;
}

export function getBarCategoryBuildMenuPageCount(
  categoryId: BarBuildCategoryId | null,
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): number {
  if (categoryId === null) return 1;
  const category = BAR_BUILD_CATEGORIES.find((entry) => entry.id === categoryId);
  if (category === undefined) return 1;
  let count = 0;
  for (const item of buildStructureMenuLayout(allowedBuildBlueprintIds).items) {
    if (item.category === category.sourceCategory) count++;
  }
  return Math.max(1, Math.ceil(count / BAR_GRID_SLOT_COUNT));
}

export function barLegacyBuildKeyForStructureBlueprintId(
  buildingBlueprintId: StructureBlueprintId,
): BarLegacyBuildKey {
  switch (buildingBlueprintId) {
    case 'buildingExtractor':
    case 'buildingExtractorT2':
      return 'Z';
    case 'buildingSolar':
    case 'buildingWind':
    case 'buildingResourceConverter':
    case 'buildingMetalStorage':
    case 'buildingEnergyStorage':
      return 'X';
    case 'towerFabricator':
    case 'buildingBotFabricator':
    case 'buildingVehicleFabricator':
    case 'buildingAircraftFabricator':
    case 'buildingNavalFabricator':
    case 'buildingAdvancedUniversalFabricator':
    case 'buildingAdvancedBotFabricator':
    case 'buildingAdvancedVehicleFabricator':
    case 'buildingAdvancedAircraftFabricator':
    case 'buildingAdvancedNavalFabricator':
    case 'buildingExperimentalUniversalFabricator':
      return 'V';
    case 'buildingRadar':
    case 'buildingSonar':
    case 'buildingRadarJammer':
    case 'buildingSonarJammer':
    case 'towerCannon':
    case 'towerHelios':
    case 'towerBeamLight':
    case 'towerBeamMega':
    case 'towerAntiAir':
      return 'C';
    case 'towerTorpedo':
      return 'C';
    default:
      return barLegacyFallbackBuildKeyForCategory(structureBuildCategory(buildingBlueprintId as BuildingBlueprintId));
  }
}

export function barLegacyBuildKeyForKeyboardCode(code: string): BarLegacyBuildKey | null {
  switch (code) {
    case 'KeyZ':
      return 'Z';
    case 'KeyX':
      return 'X';
    case 'KeyC':
      return 'C';
    case 'KeyV':
      return 'V';
    default:
      return null;
  }
}

export function getBarLegacyBuildMenuStructureBlueprintIdsForKey(
  key: BarLegacyBuildKey,
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): BuildingBlueprintId[] {
  const ids: BuildingBlueprintId[] = [];
  for (const item of buildStructureMenuLayout(allowedBuildBlueprintIds).items) {
    if (barLegacyBuildKeyForStructureBlueprintId(item.buildingBlueprintId) === key) {
      ids.push(item.buildingBlueprintId);
    }
  }
  return ids;
}

function compareStructureBuildMenuOrder(
  a: StructureBlueprintId,
  b: StructureBlueprintId,
  originalIndexById: ReadonlyMap<StructureBlueprintId, number>,
): number {
  const categoryDelta = categoryOrderIndex(structureBuildCategory(a as BuildingBlueprintId))
    - categoryOrderIndex(structureBuildCategory(b as BuildingBlueprintId));
  if (categoryDelta !== 0) return categoryDelta;
  const stableDelta =
    preferredStructureBuildGridSlotIndex(a as BuildingBlueprintId)
    - preferredStructureBuildGridSlotIndex(b as BuildingBlueprintId);
  if (stableDelta !== 0) return stableDelta;
  return (originalIndexById.get(a) ?? 0) - (originalIndexById.get(b) ?? 0);
}

function categoryOrderIndex(category: BuildMenuCategory): number {
  for (let i = 0; i < BAR_BUILD_CATEGORIES.length; i++) {
    if (BAR_BUILD_CATEGORIES[i].sourceCategory === category) return i;
  }
  const fallbackIndex = BUILD_MENU_CATEGORY_ORDER.indexOf(category);
  return fallbackIndex < 0 ? BUILD_MENU_CATEGORY_ORDER.length : fallbackIndex;
}

function barClassicBuildSortIndex(id: BuildingBlueprintId): number {
  switch (id) {
    // BAR buildmenu_sorting.lua ARM commander/assist-drone order:
    // armmex, armmakr, armwin, armsolar, armap,
    // armrad, armllt, armbeamer, armrl.
    case 'buildingExtractor':
      return 100000;
    case 'buildingExtractorT2':
      return 100100;
    case 'buildingMetalStorage':
      return 100200;
    case 'buildingEnergyStorage':
      return 100300;
    case 'buildingResourceConverter':
      return 100500;
    case 'buildingWind':
      return 101000;
    case 'buildingTidalGenerator':
      return 101005;
    case 'buildingSolar':
      return 101070;
    case 'buildingBotFabricator':
      return 102000;
    case 'buildingVehicleFabricator':
      return 102010;
    case 'towerFabricator':
      return 102020;
    case 'buildingAircraftFabricator':
      return 102030;
    case 'buildingNavalFabricator':
      return 102040;
    case 'buildingAdvancedBotFabricator':
      return 102100;
    case 'buildingAdvancedVehicleFabricator':
      return 102110;
    case 'buildingAdvancedUniversalFabricator':
      return 102120;
    case 'buildingAdvancedAircraftFabricator':
      return 102130;
    case 'buildingAdvancedNavalFabricator':
      return 102140;
    case 'buildingExperimentalUniversalFabricator':
      return 102150;
    case 'buildingRadar':
      return 103100;
    case 'buildingSonar':
      return 103110;
    case 'buildingRadarJammer':
      return 103120;
    case 'buildingSonarJammer':
      return 103130;
    case 'towerCannon':
      return 106100;
    case 'towerHelios':
      return 106150;
    case 'towerBeamLight':
      return 106200;
    case 'towerBeamMega':
      return 106300;
    case 'towerAntiAir':
      return 130100;
    case 'towerInterceptor':
      return 130105;
    case 'towerTorpedo':
      return 130110;
    // Prototype-only tech structures sort after the BAR-analogue intel
    // pair on the utility page.
    case 'buildingShieldTargetingTech':
      return 103200;
    case 'buildingShieldTech':
      return 103210;
    case 'buildingPrecisionTargetingTech':
      return 103220;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function barClassicFactoryUnitSortIndex(id: string): number {
  switch (id) {
    // BAR buildmenu_sorting.lua ARM factory analogues:
    // air constructor, scout/light air, fighter, bomber, flea, flash,
    // janus, artillery, warrior, atlas.
    case 'unitConstructionDrone':
      return 1160; // armca air constructor
    case 'unitBee':
      return 4030; // armpeep scout/light air
    case 'unitEagle':
      return 4300; // armfig fighter
    case 'unitDuck':
      return 4310; // local dive aircraft
    case 'unitAlbatros':
      return 4320; // armkam gunship
    case 'unitDragonfly':
      return 4350; // armthund bomber
    case 'unitTick':
      return 4400; // armflea light bot
    case 'unitJackal':
      return 4410; // armfav scout vehicle
    case 'unitLynx':
      return 5020; // armflash light tank
    case 'unitBadger':
      return 5200; // armjanus rocket tank
    case 'unitMongoose':
      return 5420; // armart artillery
    case 'unitSeaTurtle':
      return 5500; // prototype amphibious combat vehicle
    case 'unitOrca':
      return 5510; // prototype underwater torpedo vehicle
    case 'unitTarantula':
      return 5600; // armwar assault bot
    case 'unitTransport':
      return 10500; // armatlas transport
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

const BAR_HOME_BUILD_ORDER = [
  [
    'buildingExtractor',
    'buildingSolar',
    'buildingWind',
    'buildingResourceConverter',
    'buildingMetalStorage',
    'buildingEnergyStorage',
  ],
  [
    'towerCannon',
    'towerBeamLight',
    'towerBeamMega',
    'towerAntiAir',
    'towerHelios',
  ],
  [
    'buildingRadar',
    'buildingSonar',
    'buildingRadarJammer',
    'buildingSonarJammer',
    'buildingShieldTargetingTech',
    'buildingShieldTech',
    'buildingPrecisionTargetingTech',
  ],
  [
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
  ],
] as const satisfies readonly (readonly StructureBlueprintId[])[];

function barLegacyFallbackBuildKeyForCategory(category: BuildMenuCategory): BarLegacyBuildKey {
  switch (category) {
    case 'Production':
      return 'V';
    case 'Defense':
    case 'Intel':
      return 'C';
    case 'Economy':
      return 'Z';
    default:
      return 'C';
  }
}

function nextAvailableSlotIndex(
  usedSlotsByCategory: Map<BuildMenuCategory, Set<number>>,
  category: BuildMenuCategory,
  preferredSlotIndex: number,
): number {
  let used = usedSlotsByCategory.get(category);
  if (used === undefined) {
    used = new Set<number>();
    usedSlotsByCategory.set(category, used);
  }
  if (preferredSlotIndex >= 0 && preferredSlotIndex < BAR_GRID_SLOT_COUNT && !used.has(preferredSlotIndex)) {
    used.add(preferredSlotIndex);
    return preferredSlotIndex;
  }
  for (let slotIndex = 0; slotIndex < BAR_GRID_SLOT_COUNT; slotIndex++) {
    if (used.has(slotIndex)) continue;
    used.add(slotIndex);
    return slotIndex;
  }
  const overflowSlotIndex = used.size % BAR_GRID_SLOT_COUNT;
  used.add(used.size);
  return overflowSlotIndex;
}

function nextAvailableFactoryGridCellIndex(cells: (string | null)[]): number {
  for (let slotIndex = 0; slotIndex < cells.length; slotIndex++) {
    if (cells[slotIndex] === null) return slotIndex;
  }
  const pageStartIndex = cells.length;
  for (let i = 0; i < BAR_GRID_SLOT_COUNT; i++) cells.push(null);
  return pageStartIndex;
}

function preferredStructureBuildGridSlotIndex(id: BuildingBlueprintId): number {
  switch (id) {
    // BAR armcom / armassistdrone economy page:
    // bottom row mex, solar, wind; middle-left converter.
    case 'buildingExtractor':
      return 0;
    case 'buildingSolar':
      return 1;
    case 'buildingWind':
      return 2;
    case 'buildingResourceConverter':
      return 4;
    case 'buildingMetalStorage':
      return 3;
    case 'buildingEnergyStorage':
      return 5;
    case 'buildingExtractorT2':
      return 6;
    // BAR utility page: radar and sonar occupy the first two slots; the
    // prototype-only tech structures take the next two.
    case 'buildingRadar':
      return 0;
    case 'buildingSonar':
      return 1;
    case 'buildingRadarJammer':
      return 5;
    case 'buildingSonarJammer':
      return 6;
    case 'buildingShieldTargetingTech':
      return 2;
    case 'buildingShieldTech':
      return 3;
    case 'buildingPrecisionTargetingTech':
      return 4;
    // Production follows one compact progression: four T1 specialists,
    // T1/T2 Universal, four advanced specialists, then the sole T3 Universal.
    case 'buildingBotFabricator':
      return 0;
    case 'buildingVehicleFabricator':
      return 1;
    case 'buildingAircraftFabricator':
      return 2;
    case 'buildingNavalFabricator':
      return 3;
    case 'towerFabricator':
      return 4;
    case 'buildingAdvancedUniversalFabricator':
      return 5;
    case 'buildingAdvancedBotFabricator':
      return 6;
    case 'buildingAdvancedVehicleFabricator':
      return 7;
    case 'buildingAdvancedAircraftFabricator':
      return 8;
    case 'buildingAdvancedNavalFabricator':
      return 9;
    case 'buildingExperimentalUniversalFabricator':
      return 10;
    // BAR T1 constructor combat pages put light ground/beam defenses on
    // the bottom row and basic AA at the middle-left slot. The ARM
    // commander omits armbeamer, while ARM T1 constructors include it.
    case 'towerCannon':
      return 0;
    case 'towerBeamMega':
      return 1;
    case 'towerHelios':
      return 5;
    case 'towerTorpedo':
      return 2;
    case 'towerInterceptor':
      return 3;
    case 'towerAntiAir':
      return 4;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}
