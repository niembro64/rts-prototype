import type { BuildingBlueprintId, StructureBlueprintId } from '../sim/types';
import {
  BUILD_MENU_CATEGORY_ORDER,
  structureBuildCategory,
  type BuildMenuCategory,
} from '../sim/blueprints/displayRosters';
import type { CommandHotkeyId } from './commandHotkeys';

export const BUILD_MENU_GRID_SLOT_COMMAND_IDS = [
  'build.slot1',
  'build.slot2',
  'build.slot3',
  'build.slot4',
  'build.slot5',
  'build.slot6',
  'build.slot7',
  'build.slot8',
  'build.slot9',
  'build.slot10',
  'build.slot11',
  'build.slot12',
] as const satisfies readonly CommandHotkeyId[];

export const BAR_GRID_COLUMNS = 4;
export const BAR_GRID_ROWS = 3;
export const BAR_GRID_SLOT_COUNT = BAR_GRID_COLUMNS * BAR_GRID_ROWS;

export type BarBuildCategoryId = 'Economy' | 'Combat' | 'Utility' | 'Production';

type BarBuildCategory = {
  id: BarBuildCategoryId;
  sourceCategory: BuildMenuCategory;
  label: string;
  keyCommandId: CommandHotkeyId;
};

export const BAR_BUILD_CATEGORIES: readonly BarBuildCategory[] = [
  { id: 'Economy', sourceCategory: 'Economy', label: 'Economy', keyCommandId: 'build.slot1' },
  { id: 'Combat', sourceCategory: 'Defense', label: 'Combat', keyCommandId: 'build.slot2' },
  { id: 'Utility', sourceCategory: 'Intel', label: 'Utility', keyCommandId: 'build.slot3' },
  { id: 'Production', sourceCategory: 'Production', label: 'Build', keyCommandId: 'build.slot4' },
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

  for (let index = 0; index < orderedIds.length && index < BUILD_MENU_GRID_SLOT_COMMAND_IDS.length; index++) {
    const buildingBlueprintId = orderedIds[index] as BuildingBlueprintId;
    items.push({
      buildingBlueprintId,
      category: structureBuildCategory(buildingBlueprintId),
      slotIndex: index,
      commandId: BUILD_MENU_GRID_SLOT_COMMAND_IDS[index],
      gridRow: Math.floor(index / 4) + 1,
      gridColumn: (index % 4) + 1,
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

export function getBuildMenuStructureBlueprintIdBySlotIndex(
  slotIndex: number,
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): BuildingBlueprintId | null {
  return buildStructureMenuLayout(allowedBuildBlueprintIds).items[slotIndex]?.buildingBlueprintId ?? null;
}

export function buildBarHomeBuildMenuCells(
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): (BuildMenuLayoutItem | null)[] {
  const groups = new Map<BarBuildCategoryId, BuildMenuLayoutItem[]>();
  for (const category of BAR_BUILD_CATEGORIES) groups.set(category.id, []);
  for (const item of buildStructureMenuLayout(allowedBuildBlueprintIds).items) {
    const category = findBarBuildCategory(item.category);
    groups.get(category?.id ?? 'Utility')?.push(item);
  }

  const cells = new Array<BuildMenuLayoutItem | null>(BAR_GRID_SLOT_COUNT);
  for (let i = 0; i < cells.length; i++) cells[i] = null;
  for (let columnIndex = 0; columnIndex < BAR_BUILD_CATEGORIES.length; columnIndex++) {
    const category = BAR_BUILD_CATEGORIES[columnIndex];
    const options = groups.get(category.id) ?? [];
    for (let rowIndex = 0; rowIndex < BAR_GRID_ROWS && rowIndex < options.length; rowIndex++) {
      const slotIndex = rowIndex * BAR_GRID_COLUMNS + columnIndex;
      const item = options[rowIndex];
      if (item === undefined) continue;
      cells[slotIndex] = {
        ...item,
        slotIndex,
        commandId: BUILD_MENU_GRID_SLOT_COMMAND_IDS[slotIndex],
        gridRow: rowIndex + 1,
        gridColumn: columnIndex + 1,
      };
    }
  }
  return cells;
}

export function getBarHomeBuildMenuStructureBlueprintIdBySlotIndex(
  slotIndex: number,
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): BuildingBlueprintId | null {
  return buildBarHomeBuildMenuCells(allowedBuildBlueprintIds)[slotIndex]?.buildingBlueprintId ?? null;
}

function compareStructureBuildMenuOrder(
  a: StructureBlueprintId,
  b: StructureBlueprintId,
  originalIndexById: ReadonlyMap<StructureBlueprintId, number>,
): number {
  const categoryDelta = categoryOrderIndex(structureBuildCategory(a as BuildingBlueprintId))
    - categoryOrderIndex(structureBuildCategory(b as BuildingBlueprintId));
  if (categoryDelta !== 0) return categoryDelta;
  const stableDelta = stableOrderIndex(a) - stableOrderIndex(b);
  if (stableDelta !== 0) return stableDelta;
  return (originalIndexById.get(a) ?? 0) - (originalIndexById.get(b) ?? 0);
}

function findBarBuildCategory(category: BuildMenuCategory): BarBuildCategory | null {
  for (let i = 0; i < BAR_BUILD_CATEGORIES.length; i++) {
    const entry = BAR_BUILD_CATEGORIES[i];
    if (entry.sourceCategory === category) return entry;
  }
  return null;
}

function categoryOrderIndex(category: BuildMenuCategory): number {
  const index = BUILD_MENU_CATEGORY_ORDER.indexOf(category);
  return index < 0 ? BUILD_MENU_CATEGORY_ORDER.length : index;
}

function stableOrderIndex(id: StructureBlueprintId): number {
  const index = BUILD_MENU_GRID_STABLE_ORDER.indexOf(id);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

const BUILD_MENU_GRID_STABLE_ORDER: readonly StructureBlueprintId[] = [
  'buildingSolar',
  'buildingWind',
  'buildingExtractor',
  'buildingResourceConverter',
  'buildingRadar',
  'towerFabricator',
  'towerBeamMega',
  'towerCannon',
  'towerAntiAir',
];
