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

export type BuildMenuLayoutItem = {
  buildingBlueprintId: BuildingBlueprintId;
  category: BuildMenuCategory;
  slotIndex: number;
  commandId: CommandHotkeyId;
  gridRow: number;
  gridColumn: number;
};

export type BuildMenuLayoutGroup = {
  category: BuildMenuCategory;
  items: BuildMenuLayoutItem[];
};

export type BuildMenuLayout = {
  items: BuildMenuLayoutItem[];
  groups: BuildMenuLayoutGroup[];
};

export function buildStructureMenuLayout(
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
): BuildMenuLayout {
  const originalIndexById = new Map(
    allowedBuildBlueprintIds.map((id, index) => [id, index] as const),
  );
  const orderedIds = [...allowedBuildBlueprintIds].sort((a, b) =>
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
    const categoryItems = items.filter((item) => item.category === category);
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
