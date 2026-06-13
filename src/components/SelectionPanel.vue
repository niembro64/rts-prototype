<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { COLORS, WAYPOINT_COLOR_CSS } from '@/colorsConfig';
import type { WaypointType } from '../game/sim/types';
import {
  structureRosterDisplay,
  unitRosterDisplay,
  type BuildMenuCategory,
} from '../game/sim/blueprints/displayRosters';
import {
  commandHotkeyLabel,
  type CommandHotkeyId,
  type CommandHotkeyPresetId,
} from '../game/input/commandHotkeys';
import {
  BUILD_MENU_GRID_SLOT_COMMAND_IDS,
  buildStructureMenuLayout,
} from '../game/input/buildMenuLayout';
import {
  getCachedEntityThumbnail,
  requestEntityThumbnail,
  subscribeEntityThumbnailCache,
} from './entityPreviewThumbnails';
import type {
  LoadingEntityBlueprintId,
  LoadingPreviewKind,
} from './loadingUnitPreview3d';
import {
  FACTORY_PRODUCTION_PRESET_COUNT,
  FACTORY_PRODUCTION_PRESET_STORAGE_KEY,
  FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT,
  getFactoryProductionPresetSlot,
  loadFactoryProductionPresetSlots,
  setFactoryProductionPresetSlot,
} from '../game/input/factoryProductionPresets';
import { queueModeFromEvent } from '../game/input/queueModifiers';
import { isTowerBuildingBlueprintId } from '@/types/buildingTypes';
import type { StructureBlueprintId } from '@/types/blueprintIds';

export type { FactorySelectionItem, SelectionInfo, SelectionActions } from '@/types/ui';
import type {
  QueueInsertOption,
  SelectionEntityType,
  SelectionInfo,
  SelectionActions,
} from '@/types/ui';

const props = defineProps<{
  selection: SelectionInfo;
  actions: SelectionActions;
  hotkeyPreset: CommandHotkeyPresetId;
  hotkeyRevision: number;
}>();

// Per budget_design_philosophy.html "Selection Menus Are Uniform Per Entity Type"
// every entity type carries its own uniform action set. Pure-
// infrastructure buildings expose ON/OFF + Self-Destruct; the panel
// opens whenever any owned entity is selected.
const showPanel = computed(() =>
  props.selection.unitCount > 0
  || props.selection.towerCount > 0
  || props.selection.buildingCount > 0
  || props.selection.hasFactory,
);
const selectedEntityTypeCount = computed(() =>
  (props.selection.unitCount > 0 ? 1 : 0)
  + (props.selection.towerCount > 0 ? 1 : 0)
  + (props.selection.buildingCount > 0 ? 1 : 0),
);
const hasMixedEntityTypes = computed(() => selectedEntityTypeCount.value > 1);
const isPureUnitSelection = computed(() =>
  props.selection.unitCount > 0
  && props.selection.towerCount === 0
  && props.selection.buildingCount === 0,
);
const isPureTowerSelection = computed(() =>
  props.selection.towerCount > 0
  && props.selection.unitCount === 0
  && props.selection.buildingCount === 0,
);
const isPureBuildingSelection = computed(() =>
  props.selection.buildingCount > 0
  && props.selection.unitCount === 0
  && props.selection.towerCount === 0,
);
const showUnitActions = computed(() => isPureUnitSelection.value);
const showTowerActions = computed(() => isPureTowerSelection.value);
const showBuildingActions = computed(() => isPureBuildingSelection.value);
const showCombatActions = computed(() =>
  props.selection.hasFireControl && props.selection.buildingCount === 0,
);
const showQueueInsertPicker = computed(() =>
  showUnitActions.value && props.selection.queueInsertOptions.length > 0,
);
const selectOnlyOptions = computed<
  { entityType: SelectionEntityType; label: string; count: number }[]
>(() => {
  if (!hasMixedEntityTypes.value) return [];
  const options: { entityType: SelectionEntityType; label: string; count: number }[] = [];
  if (props.selection.unitCount > 0) {
    options.push({ entityType: 'unit', label: 'Units', count: props.selection.unitCount });
  }
  if (props.selection.towerCount > 0) {
    options.push({ entityType: 'tower', label: 'Towers', count: props.selection.towerCount });
  }
  if (props.selection.buildingCount > 0) {
    options.push({ entityType: 'building', label: 'Buildings', count: props.selection.buildingCount });
  }
  return options;
});
// True iff the selection contains no movable unit at all — used to
// fold the unit-only action groups (movement, build, commander
// specials) out of view when only towers are selected.
const isStaticOnlySelection = computed(() =>
  props.selection.unitCount === 0
  && (props.selection.towerCount > 0 || props.selection.buildingCount > 0),
);
const SELECTION_PANEL = COLORS.ui.selectionPanel;
const BUTTON_COLORS = SELECTION_PANEL.buttons;
const selectionPanelStyle = {
  '--selection-panel-bg': SELECTION_PANEL.surface.background,
  '--selection-panel-border': SELECTION_PANEL.surface.border,
  '--selection-panel-text': SELECTION_PANEL.surface.text,
  '--selection-panel-header-border': SELECTION_PANEL.surface.headerBorder,
  '--selection-panel-label': SELECTION_PANEL.surface.label,
  '--selection-panel-hint': SELECTION_PANEL.surface.hint,
  '--selection-panel-key': SELECTION_PANEL.surface.key,
  '--selection-panel-commander': SELECTION_PANEL.unitBlueprintId.unitCommander,
  '--selection-panel-factory': SELECTION_PANEL.unitBlueprintId.towerFabricator,
  '--selection-panel-button-bg': BUTTON_COLORS.background,
  '--selection-panel-button-border': BUTTON_COLORS.border,
  '--selection-panel-button-hover-bg': BUTTON_COLORS.hoverBackground,
  '--selection-panel-button-active-bg': BUTTON_COLORS.activeBackground,
  '--selection-panel-button-default': BUTTON_COLORS.default,
  '--selection-panel-button-group-accent': BUTTON_COLORS.groupAccent,
  '--selection-panel-group-active-bg': BUTTON_COLORS.groupActiveBackground,
  '--selection-panel-group-active-shadow': BUTTON_COLORS.groupActiveShadow,
  '--selection-panel-button-disabled-opacity': String(BUTTON_COLORS.disabledOpacity),
  '--selection-panel-action-disabled-opacity': String(BUTTON_COLORS.actionDisabledOpacity),
  '--selection-panel-cost-energy': SELECTION_PANEL.cost.energy,
  '--selection-panel-cost-resource': SELECTION_PANEL.cost.resource,
  '--selection-panel-build': BUTTON_COLORS.build,
  '--selection-panel-dgun': BUTTON_COLORS.dgun,
  '--selection-panel-stop': BUTTON_COLORS.stop,
  '--selection-panel-vehicle-produce': BUTTON_COLORS.vehicleProduce,
  '--selection-panel-bot-produce': BUTTON_COLORS.botProduce,
} as const;

// Repeat-build: selected unit blueprint currently being looped. Used to
// light up the matching button.
const selectedBuildUnitBlueprintId = computed(() =>
  props.selection.factorySelectedUnit?.unitBlueprintId ?? null,
);
const factoryQueuedUnits = computed(() => props.selection.factoryProductionQueue ?? []);
const factoryQueueCount = computed(() => factoryQueuedUnits.value.length);
type FactoryQueueRun = {
  unitBlueprintId: string;
  label: string;
  startIndex: number;
  count: number;
};
const factoryQueueRuns = computed<FactoryQueueRun[]>(() => {
  const units = factoryQueuedUnits.value;
  const runs: FactoryQueueRun[] = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const previous = runs[runs.length - 1];
    if (previous !== undefined && previous.unitBlueprintId === unit.unitBlueprintId) {
      previous.count++;
    } else {
      runs.push({
        unitBlueprintId: unit.unitBlueprintId,
        label: unit.label,
        startIndex: i,
        count: 1,
      });
    }
  }
  return runs;
});
const hasFactoryProduction = computed(() =>
  selectedBuildUnitBlueprintId.value !== null ||
    props.selection.factoryIsProducing === true ||
    factoryQueueCount.value > 0,
);
const hasFactoryPresetToSave = computed(() => selectedBuildUnitBlueprintId.value !== null);
const factoryProgressPercent = computed(() =>
  Math.max(0, Math.min(100, Math.round((props.selection.factoryProgress ?? 0) * 100))),
);
const factoryProgressStyle = computed(() => ({
  width: `${factoryProgressPercent.value}%`,
}));
const factoryStatusLabel = computed(() => {
  const unitLabel = props.selection.factorySelectedUnit?.label ?? 'No unit';
  if (unitLabel === 'No unit') return `${unitLabel} idle`;
  const modeLabel = props.selection.factoryRepeatsProduction === false ? 'Queue' : 'Repeat';
  const queuedLabel = factoryQueueCount.value > 0 ? ` +${factoryQueueCount.value}` : '';
  return props.selection.factoryIsProducing === true
    ? `${modeLabel} ${unitLabel} producing${queuedLabel}`
    : `${modeLabel} ${unitLabel} idle${queuedLabel}`;
});
const factoryQueueSummary = computed(() => {
  if (factoryQueueRuns.value.length === 0) return '';
  return factoryQueueRuns.value
    .map((run) => run.count > 1 ? `${run.label} x${run.count}` : run.label)
    .join(' -> ');
});
const factoryStatusTitle = computed(() =>
  `Factory production: ${factoryStatusLabel.value} - ${factoryProgressPercent.value}%${factoryQueueSummary.value ? ` - queued: ${factoryQueueSummary.value}` : ''}`,
);
const showCancelHint = computed(() =>
  props.selection.isBuildMode
  || props.selection.isDGunMode
  || props.selection.isRepairAreaMode
  || props.selection.isAttackMode
  || props.selection.isAttackAreaMode
  || props.selection.isAttackGroundMode
  || props.selection.isGuardMode
  || props.selection.isReclaimMode
  || props.selection.isCaptureMode
  || props.selection.isLoadTransportMode
  || props.selection.isUnloadTransportMode
  || props.selection.isManualLaunchMode
  || props.selection.isMexUpgradeMode
  || props.selection.isPingMode
  || props.selection.isTowerTargetMode,
);

type WaypointModeOption = {
  mode: WaypointType;
  label: string;
  commandId: CommandHotkeyId;
  key: string;
  color: string;
};

type BarBuildCategoryId = 'Economy' | 'Combat' | 'Utility' | 'Production';

type BarBuildCategory = {
  id: BarBuildCategoryId;
  sourceCategory: BuildMenuCategory;
  label: string;
  keyCommandId: CommandHotkeyId;
};

type BuildingGridOption = {
  buildingBlueprintId: StructureBlueprintId;
  label: string;
  key: string;
  cost: number;
  category: BuildMenuCategory;
  commandId: CommandHotkeyId;
  gridRow: number;
  gridColumn: number;
};

type FactoryGridOption = {
  unitBlueprintId: string;
  label: string;
  shortName: string;
  cost: number;
  locomotion: string;
};

const BAR_GRID_COLUMNS = 4;
const BAR_GRID_ROWS = 3;
const BAR_GRID_SLOT_COUNT = BAR_GRID_COLUMNS * BAR_GRID_ROWS;
const BAR_BUILD_CATEGORIES: readonly BarBuildCategory[] = [
  { id: 'Economy', sourceCategory: 'Economy', label: 'Economy', keyCommandId: 'build.slot1' },
  { id: 'Combat', sourceCategory: 'Defense', label: 'Combat', keyCommandId: 'build.slot2' },
  { id: 'Utility', sourceCategory: 'Intel', label: 'Utility', keyCommandId: 'build.slot3' },
  { id: 'Production', sourceCategory: 'Production', label: 'Build', keyCommandId: 'build.slot4' },
];

const buildGridCategory = ref<BarBuildCategoryId | null>(null);
const buildGridPage = ref(0);
const factoryGridPage = ref(0);

function hotkey(commandId: CommandHotkeyId): string {
  void props.hotkeyRevision;
  return commandHotkeyLabel(commandId, props.hotkeyPreset);
}

const waypointModes = computed<WaypointModeOption[]>(() => [
  { mode: 'move', label: 'Move', commandId: 'waypoint.move', key: hotkey('waypoint.move'), color: WAYPOINT_COLOR_CSS.move },
  { mode: 'fight', label: 'Fight', commandId: 'waypoint.fight', key: hotkey('waypoint.fight'), color: WAYPOINT_COLOR_CSS.fight },
  { mode: 'patrol', label: 'Patrol', commandId: 'waypoint.patrol', key: hotkey('waypoint.patrol'), color: WAYPOINT_COLOR_CSS.patrol },
]);

const COMPACT_BUILDING_LABELS: Record<string, string> = {
  Solar: 'Sol',
  Wind: 'Wnd',
  Extractor: 'Ext',
  Radar: 'Rad',
  Converter: 'Conv',
  'Anti-Air Tower': 'AA',
};
function compactBuildingLabel(label: string): string {
  return COMPACT_BUILDING_LABELS[label] ?? label.slice(0, 5);
}

function actionTitle(label: string, commandId: CommandHotkeyId, detail?: string): string {
  const key = hotkey(commandId);
  const hotkeyText = key === '' ? '' : ` - Hotkey ${key}`;
  return `${label}${hotkeyText}${detail === undefined ? '' : ` - ${detail}`}`;
}

function trajectoryModeLabel(mode: SelectionInfo['trajectoryMode']): string {
  return mode === 'high' ? 'Arc Hi' : mode === 'low' ? 'Arc Lo' : 'Arc Auto';
}

function moveStateLabel(moveState: SelectionInfo['unitMoveState']): string {
  switch (moveState) {
    case 'holdPosition': return 'Hold';
    case 'roam': return 'Roam';
    case 'mixed': return 'Mixed';
    case 'maneuver': return 'Move';
  }
}

function nextMoveStateLabel(moveState: SelectionInfo['unitMoveState']): string {
  switch (moveState) {
    case 'holdPosition': return 'Roam';
    case 'roam': return 'Maneuver';
    case 'maneuver': return 'Hold';
    case 'mixed': return 'Hold';
  }
}

function fireStateLabel(fireState: SelectionInfo['fireState']): string {
  switch (fireState) {
    case 'fireAtWill': return 'Fire';
    case 'returnFire': return 'Return';
    case 'holdFire': return 'Hold';
    case 'mixed': return 'Mixed';
  }
}

function nextFireStateLabel(fireState: SelectionInfo['fireState']): string {
  switch (fireState) {
    case 'fireAtWill': return 'Return';
    case 'returnFire': return 'Hold';
    case 'holdFire': return 'Fire';
    case 'mixed': return 'Fire';
  }
}

function cloakStateLabel(selection: SelectionInfo): string {
  if (selection.isCloaked) return 'Cloaked';
  return selection.wantsCloak ? 'Cloaking' : 'Cloak';
}

function queueInsertOptionTitle(option: QueueInsertOption): string {
  return option.label === 'End'
    ? 'Insert queued commands at the end'
    : `Insert queued commands after order ${option.label.replace('+', '')}`;
}

function costTitle(label: string, cost: number, key?: string): string {
  const hotkey = key === undefined ? '' : ` - Hotkey ${key}`;
  return `${label}${hotkey} - Cost ${cost}`;
}

const buildingMenuLayout = computed(() =>
  buildStructureMenuLayout(props.selection.allowedBuildBlueprintIds),
);

const buildingOptions = computed(() => {
  return buildingMenuLayout.value.items
    .map((item) => {
      const { buildingBlueprintId, commandId } = item;
      const option = structureRosterDisplay.find((entry) => entry.buildingBlueprintId === buildingBlueprintId);
      return option === undefined
        ? null
        : {
          ...option,
          buildingBlueprintId: option.buildingBlueprintId as StructureBlueprintId,
          key: hotkey(commandId),
          commandId,
          gridRow: item.gridRow,
          gridColumn: item.gridColumn,
        };
    })
    .filter((option) => option !== null);
});
const buildLineSpacingLabel = computed(() =>
  `${Math.round(props.selection.buildLineSpacingMultiplier * 100)}%`,
);
const buildFacingLabel = computed(() => `${props.selection.buildFacingDegrees}deg`);
const unitOptions = unitRosterDisplay;

const thumbnailRevision = ref(0);
let unsubscribeEntityThumbnails: (() => void) | null = null;

const buildOptionsByBarCategory = computed(() => {
  const groups = new Map<BarBuildCategoryId, BuildingGridOption[]>();
  for (const category of BAR_BUILD_CATEGORIES) groups.set(category.id, []);
  for (const option of buildingOptions.value as BuildingGridOption[]) {
    const category = BAR_BUILD_CATEGORIES.find((entry) => entry.sourceCategory === option.category);
    groups.get(category?.id ?? 'Utility')?.push(option);
  }
  return groups;
});

const currentBuildCategory = computed(() =>
  buildGridCategory.value === null
    ? null
    : BAR_BUILD_CATEGORIES.find((category) => category.id === buildGridCategory.value) ?? null,
);

const currentBuildCategoryOptions = computed(() => {
  const category = currentBuildCategory.value;
  return category === null ? [] : buildOptionsByBarCategory.value.get(category.id) ?? [];
});

const buildGridPageCount = computed(() =>
  Math.max(1, Math.ceil(currentBuildCategoryOptions.value.length / BAR_GRID_SLOT_COUNT)),
);

const buildGridModeLabel = computed(() =>
  currentBuildCategory.value === null ? 'Home' : currentBuildCategory.value.label,
);

const buildGridCells = computed<(BuildingGridOption | null)[]>(() => {
  if (currentBuildCategory.value !== null) {
    const start = buildGridPage.value * BAR_GRID_SLOT_COUNT;
    return gridCells(currentBuildCategoryOptions.value.slice(start, start + BAR_GRID_SLOT_COUNT));
  }

  const cells = emptyGridCells<BuildingGridOption>();
  BAR_BUILD_CATEGORIES.forEach((category, columnIndex) => {
    const options = buildOptionsByBarCategory.value.get(category.id) ?? [];
    for (let rowIndex = 0; rowIndex < BAR_GRID_ROWS && rowIndex < options.length; rowIndex++) {
      cells[rowIndex * BAR_GRID_COLUMNS + columnIndex] = options[rowIndex] ?? null;
    }
  });
  return cells;
});

const showBuildGridPager = computed(() =>
  currentBuildCategory.value !== null && buildGridPageCount.value > 1,
);

const factoryGridPageCount = computed(() =>
  Math.max(1, Math.ceil(unitOptions.length / BAR_GRID_SLOT_COUNT)),
);

const factoryGridCells = computed<(FactoryGridOption | null)[]>(() => {
  const start = factoryGridPage.value * BAR_GRID_SLOT_COUNT;
  return gridCells(unitOptions.slice(start, start + BAR_GRID_SLOT_COUNT));
});

function emptyGridCells<T>(): (T | null)[] {
  return Array.from<T | null>({ length: BAR_GRID_SLOT_COUNT }).fill(null);
}

function gridCells<T>(items: readonly T[]): (T | null)[] {
  const cells = emptyGridCells<T>();
  for (let index = 0; index < cells.length && index < items.length; index++) {
    cells[index] = items[index] ?? null;
  }
  return cells;
}

function selectBuildGridCategory(categoryId: BarBuildCategoryId): void {
  buildGridCategory.value = buildGridCategory.value === categoryId ? null : categoryId;
  buildGridPage.value = 0;
}

function clearBuildGridCategory(): void {
  buildGridCategory.value = null;
  buildGridPage.value = 0;
}

function stepBuildGridPage(delta: number): void {
  const pageCount = buildGridPageCount.value;
  buildGridPage.value = (buildGridPage.value + delta + pageCount) % pageCount;
}

function stepFactoryGridPage(delta: number): void {
  const pageCount = factoryGridPageCount.value;
  factoryGridPage.value = (factoryGridPage.value + delta + pageCount) % pageCount;
}

function buildGridCellKey(option: BuildingGridOption | null, index: number): string {
  return option === null ? `empty-build-${index}` : option.buildingBlueprintId;
}

function factoryGridCellKey(option: FactoryGridOption | null, index: number): string {
  return option === null ? `empty-factory-${index}` : option.unitBlueprintId;
}

function gridSlotHotkey(index: number): string {
  const commandId = BUILD_MENU_GRID_SLOT_COMMAND_IDS[index];
  return commandId === undefined ? '' : hotkey(commandId);
}

const FACTORY_PRESET_LOAD_COMMAND_IDS = [
  'factoryPreset.load1',
  'factoryPreset.load2',
  'factoryPreset.load3',
  'factoryPreset.load4',
] as const satisfies readonly CommandHotkeyId[];
const FACTORY_PRESET_SAVE_COMMAND_IDS = [
  'factoryPreset.save1',
  'factoryPreset.save2',
  'factoryPreset.save3',
  'factoryPreset.save4',
] as const satisfies readonly CommandHotkeyId[];

const factoryPresetSlots = ref<(string | null)[]>(loadFactoryProductionPresetSlots());

function refreshFactoryPresetSlots(): void {
  factoryPresetSlots.value = loadFactoryProductionPresetSlots();
}

function onFactoryPresetStorageChanged(event: StorageEvent): void {
  if (event.key === FACTORY_PRODUCTION_PRESET_STORAGE_KEY) refreshFactoryPresetSlots();
}

onMounted(() => {
  if (typeof window === 'undefined') return;
  window.addEventListener(FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT, refreshFactoryPresetSlots);
  window.addEventListener('storage', onFactoryPresetStorageChanged);
  unsubscribeEntityThumbnails = subscribeEntityThumbnailCache(() => {
    thumbnailRevision.value++;
  });
  thumbnailRevision.value++;
  prefetchBuildButtonThumbnails();
});

onUnmounted(() => {
  if (typeof window === 'undefined') return;
  window.removeEventListener(FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT, refreshFactoryPresetSlots);
  window.removeEventListener('storage', onFactoryPresetStorageChanged);
  unsubscribeEntityThumbnails?.();
  unsubscribeEntityThumbnails = null;
});

function structurePreviewKind(buildingBlueprintId: StructureBlueprintId): LoadingPreviewKind {
  return isTowerBuildingBlueprintId(buildingBlueprintId) ? 'tower' : 'building';
}

function entityThumbnailSrc(
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): string | null {
  thumbnailRevision.value;
  return getCachedEntityThumbnail(kind, blueprintId);
}

function structureThumbnailSrc(buildingBlueprintId: StructureBlueprintId): string | null {
  return entityThumbnailSrc(structurePreviewKind(buildingBlueprintId), buildingBlueprintId);
}

function unitThumbnailSrc(unitBlueprintId: string): string | null {
  return entityThumbnailSrc('unit', unitBlueprintId as LoadingEntityBlueprintId);
}

function prefetchBuildButtonThumbnails(): void {
  if (props.selection.hasBuilder && showUnitActions.value) {
    for (const option of buildingOptions.value) {
      const blueprintId = option.buildingBlueprintId as StructureBlueprintId;
      void requestEntityThumbnail(structurePreviewKind(blueprintId), blueprintId);
    }
  }

  if (props.selection.hasFactory && showTowerActions.value) {
    for (const option of unitOptions) {
      void requestEntityThumbnail('unit', option.unitBlueprintId as LoadingEntityBlueprintId);
    }
  }
}

watch(
  () => [
    props.selection.hasBuilder,
    showUnitActions.value,
    buildingOptions.value.map((option) => option.buildingBlueprintId).join('|'),
    props.selection.hasFactory,
    showTowerActions.value,
  ],
  () => prefetchBuildButtonThumbnails(),
  { immediate: true },
);

watch(
  () => buildingOptions.value.map((option) => option.buildingBlueprintId).join('|'),
  () => {
    clearBuildGridCategory();
  },
);

watch(buildGridPageCount, (pageCount) => {
  if (buildGridPage.value >= pageCount) buildGridPage.value = Math.max(0, pageCount - 1);
});

watch(factoryGridPageCount, (pageCount) => {
  if (factoryGridPage.value >= pageCount) factoryGridPage.value = Math.max(0, pageCount - 1);
});

function factoryPresetLoadCommandId(index: number): CommandHotkeyId {
  return FACTORY_PRESET_LOAD_COMMAND_IDS[index] ?? 'factoryPreset.load1';
}

function factoryPresetSaveCommandId(index: number): CommandHotkeyId {
  return FACTORY_PRESET_SAVE_COMMAND_IDS[index] ?? 'factoryPreset.save1';
}

function factoryPresetShortName(unitBlueprintId: string | null): string {
  if (unitBlueprintId === null) return '-';
  return unitOptions.find((unit) => unit.unitBlueprintId === unitBlueprintId)?.shortName
    ?? unitBlueprintId.slice(0, 3).toUpperCase();
}

function factoryPresetTitle(index: number): string {
  const unitBlueprintId = factoryPresetSlots.value[index] ?? null;
  const label = unitBlueprintId === null
    ? 'empty'
    : (unitOptions.find((unit) => unit.unitBlueprintId === unitBlueprintId)?.label ?? unitBlueprintId);
  return `Factory preset ${index + 1}: ${label}`;
}

function factoryPresetActionTitle(index: number, commandId: CommandHotkeyId, action: string): string {
  const key = hotkey(commandId);
  const hotkeyText = key === '' ? '' : ` - Hotkey ${key}`;
  return `${factoryPresetTitle(index)} - ${action}${hotkeyText}`;
}

function factoryPresetLoadKey(index: number): string {
  return hotkey(factoryPresetLoadCommandId(index));
}

function factoryPresetSaveKey(index: number): string {
  return hotkey(factoryPresetSaveCommandId(index));
}

function saveFactoryPreset(index: number): void {
  if (index < 0 || index >= FACTORY_PRODUCTION_PRESET_COUNT) return;
  const unitBlueprintId = selectedBuildUnitBlueprintId.value;
  if (unitBlueprintId === null) return;
  setFactoryProductionPresetSlot(index, unitBlueprintId);
  refreshFactoryPresetSlots();
}

function loadFactoryPreset(index: number): void {
  if (index < 0 || index >= FACTORY_PRODUCTION_PRESET_COUNT) return;
  const factoryId = props.selection.factoryId;
  if (factoryId === undefined) return;
  const unitBlueprintId = getFactoryProductionPresetSlot(index);
  if (unitBlueprintId === null) {
    props.actions.stopFactoryProduction(factoryId);
    return;
  }
  props.actions.queueUnit(factoryId, unitBlueprintId, true);
}

function toggleWaitFromClick(event: MouseEvent): void {
  const queueMode = queueModeFromEvent(event, props.selection.queueInsertIndex);
  props.actions.toggleSelectedWait(queueMode.queue, queueMode.queueFront, queueMode.queueInsertIndex);
}

function toggleGatherWaitFromClick(event: MouseEvent): void {
  const queueMode = queueModeFromEvent(event, props.selection.queueInsertIndex);
  props.actions.toggleSelectedGatherWait(queueMode.queue, queueMode.queueFront, queueMode.queueInsertIndex);
}

function queueFactoryUnitFromClick(factoryId: number, unitBlueprintId: string, event: MouseEvent): void {
  const repeat = !event.shiftKey;
  const count = !repeat && event.altKey ? 5 : 1;
  props.actions.queueUnit(factoryId, unitBlueprintId, repeat, count);
}

function editFactoryQueueRun(
  run: FactoryQueueRun,
  operation: 'remove' | 'move' | 'setCount',
  toIndex?: number,
  count?: number,
): void {
  const factoryId = props.selection.factoryId;
  if (factoryId === undefined) return;
  props.actions.editFactoryQueue(factoryId, operation, run.startIndex, run.count, toIndex, count);
}

function moveFactoryQueueRun(runIndex: number, direction: -1 | 1): void {
  const run = factoryQueueRuns.value[runIndex];
  if (run === undefined) return;
  const target = direction < 0
    ? factoryQueueRuns.value[runIndex - 1]
    : factoryQueueRuns.value[runIndex + 1];
  if (target === undefined) return;
  const toIndex = direction < 0
    ? target.startIndex
    : target.startIndex + target.count;
  editFactoryQueueRun(run, 'move', toIndex);
}

function setFactoryQueueRunCount(run: FactoryQueueRun, count: number): void {
  editFactoryQueueRun(run, 'setCount', undefined, Math.max(0, count));
}

</script>

<template>
  <!-- OPTIONS PANEL (left side) -->
  <div v-if="showPanel" class="options-panel" :style="selectionPanelStyle">
    <!-- Selection header. Per budget_design_philosophy.html "Selection Menus
         Are Uniform Per Entity Type": the header reflects the
         selection's entity type. Commanders read as Commander,
         fabricator-class towers as Fabricator, other towers as Tower,
         pure-infrastructure buildings as Building, otherwise N units. -->
    <div class="panel-header">
      <div class="selection-title">
        <span v-if="selection.hasCommander" class="unit-type commander">Commander</span>
        <span v-else-if="selection.hasFactory" class="unit-type factory">Fabricator</span>
        <span v-else-if="selection.towerCount > 0 && selection.unitCount === 0" class="unit-type">
          {{ selection.towerCount }} Tower{{ selection.towerCount > 1 ? 's' : '' }}
        </span>
        <span v-else-if="selection.buildingCount > 0 && selection.unitCount === 0 && selection.towerCount === 0" class="unit-type">
          {{ selection.buildingCount }} Building{{ selection.buildingCount > 1 ? 's' : '' }}
        </span>
        <span v-else class="unit-type">{{ selection.unitCount }} Unit{{ selection.unitCount > 1 ? 's' : '' }}</span>
      </div>
      <div class="panel-help">
        <button
          type="button"
          class="help-btn"
          aria-describedby="selection-hotkey-help"
          title="Control group hotkeys"
        >
          ?
        </button>
        <div id="selection-hotkey-help" class="hotkey-popover" role="tooltip">
          <div class="hotkey-title">Control Groups</div>
          <div><kbd>Ctrl/Cmd</kbd> + <kbd>0-9</kbd> stores the selection.</div>
          <div><kbd>0-9</kbd> recalls a stored group.</div>
          <div>Double-tap <kbd>0-9</kbd> focuses the camera on that group.</div>
          <div><kbd>Shift</kbd> + <kbd>0-9</kbd> adds a group to the selection.</div>
          <div><kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>0-9</kbd> adds selection to a group.</div>
          <div><kbd>Ctrl/Cmd</kbd> + <kbd>Alt</kbd> + <kbd>0-9</kbd> toggles a group in the selection.</div>
          <div><kbd>Alt</kbd> + <kbd>0-9</kbd> auto-groups matching unit and building types.</div>
          <div>Auto groups are saved locally and marked <kbd>A</kbd> in the group strip.</div>
          <div><kbd>Alt</kbd> + <kbd>`</kbd> or <kbd>Alt</kbd> + <kbd>Q</kbd> removes selected types from auto-groups.</div>
          <div><kbd>Ctrl/Cmd</kbd> + <kbd>`</kbd> removes selected units from all groups.</div>
          <div class="hotkey-footnote">Button hotkeys appear on hover.</div>
        </div>
      </div>
    </div>

    <div v-if="selection.controlGroups.length > 0" class="control-group-strip" aria-label="Control groups">
      <button
        v-for="group in selection.controlGroups"
        :key="group.index"
        type="button"
        class="control-group-chip"
        :class="{ active: group.active, auto: group.auto }"
        :disabled="group.count === 0"
        :title="group.auto ? `Auto group ${group.index}` : `Control group ${group.index}`"
        @click="actions.recallControlGroup(group.index, false)"
      >
        <span class="control-group-index">{{ group.index }}</span>
        <span class="control-group-count">{{ group.count }}</span>
        <span v-if="group.auto" class="control-group-auto" title="Auto group (saved locally)">A</span>
      </button>
    </div>

    <div v-if="selection.details.length > 0" class="button-group details-group">
      <div class="group-label">Details</div>
      <div class="details-grid">
        <div
          v-for="detail in selection.details"
          :key="detail.label"
          class="detail-item"
        >
          <span class="detail-label">{{ detail.label }}</span>
          <span class="detail-value">{{ detail.value }}</span>
        </div>
      </div>
    </div>

    <div class="button-group">
      <div class="group-label">Select</div>
      <div class="buttons bar-command-grid">
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Select all units', 'select.allUnits')"
          @click="actions.selectAllOwnedUnits()"
        >
          <span class="btn-label">All</span>
          <span class="btn-key">{{ hotkey('select.allUnits') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Select all matching', 'select.matching')"
          @click="actions.selectAllMatching()"
        >
          <span class="btn-label">Match</span>
          <span class="btn-key">{{ hotkey('select.matching') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Select matching in view', 'select.matchingInView')"
          @click="actions.selectAllMatchingInView()"
        >
          <span class="btn-label">In View</span>
          <span class="btn-key">{{ hotkey('select.matchingInView') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Select previous selection', 'select.previous')"
          @click="actions.selectPreviousSelection()"
        >
          <span class="btn-label">Prev</span>
          <span class="btn-key">{{ hotkey('select.previous') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Select same type only', 'select.sameTypeOnly')"
          @click="actions.selectSameTypeOnly()"
        >
          <span class="btn-label">Same</span>
          <span class="btn-key">{{ hotkey('select.sameTypeOnly') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Select only mobile units', 'select.mobileOnly')"
          @click="actions.selectMobileOnly()"
        >
          <span class="btn-label">Mobile</span>
          <span class="btn-key">{{ hotkey('select.mobileOnly') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Invert selection', 'select.invert')"
          @click="actions.invertSelection()"
        >
          <span class="btn-label">Invert</span>
          <span class="btn-key">{{ hotkey('select.invert') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Split selected army', 'select.split')"
          @click="actions.splitArmySelection()"
        >
          <span class="btn-label">Split</span>
          <span class="btn-key">{{ hotkey('select.split') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Loop selection', 'select.loop')"
          @click="actions.loopSelection()"
        >
          <span class="btn-label">Loop</span>
          <span class="btn-key">{{ hotkey('select.loop') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Select idle builders', 'select.idleBuilders')"
          @click="actions.selectIdleBuilders()"
        >
          <span class="btn-label">Idle</span>
          <span class="btn-key">{{ hotkey('select.idleBuilders') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Select idle transports', 'select.idleTransports')"
          @click="actions.selectIdleTransports()"
        >
          <span class="btn-label">Trn Idle</span>
          <span class="btn-key">{{ hotkey('select.idleTransports') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="actionTitle('Select waiting units', 'select.waitingUnits')"
          @click="actions.selectWaitingUnits()"
        >
          <span class="btn-label">Waiting</span>
          <span class="btn-key">{{ hotkey('select.waitingUnits') }}</span>
        </button>
        <button
          v-for="option in selectOnlyOptions"
          :key="option.entityType"
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.groupAccent }"
          :title="`Select only ${option.label.toLowerCase()}`"
          @click="actions.selectOnlyEntityType(option.entityType)"
        >
          <span class="btn-label">{{ option.label }} ×{{ option.count }}</span>
        </button>
      </div>
    </div>

    <!-- Movement mode buttons (for units) -->
    <div v-if="showUnitActions" class="button-group">
      <div class="group-label">Movement</div>
      <div class="buttons bar-command-grid">
        <button
          v-for="wm in waypointModes"
          :key="wm.mode"
          type="button"
          class="action-btn"
          :class="{ active: selection.waypointMode === wm.mode }"
          :style="{ '--btn-color': wm.color }"
          :title="actionTitle(wm.label, wm.commandId)"
          @click="actions.setWaypointMode(wm.mode)"
        >
          <span class="btn-label">{{ wm.label }}</span>
          <span class="btn-key">{{ wm.key }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isFormationAssumeMode }"
          :style="{ '--btn-color': WAYPOINT_COLOR_CSS.move }"
          :title="actionTitle('Assume formation', 'formation.assume', 'Alt+Right click also works')"
          @click="actions.toggleFormationAssume()"
        >
          <span class="btn-label">Assume</span>
          <span class="btn-key">{{ hotkey('formation.assume') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isFormationMoveMode }"
          :style="{ '--btn-color': WAYPOINT_COLOR_CSS.move }"
          :title="actionTitle('Move in formation', 'formation.move', 'Ctrl+Right click also works')"
          @click="actions.toggleFormationMove()"
        >
          <span class="btn-label">Form</span>
          <span class="btn-key">{{ hotkey('formation.move') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isAttackMode }"
          :style="{ '--btn-color': BUTTON_COLORS.attackArea }"
          :title="actionTitle('Attack', 'combat.attack', 'Click an enemy target')"
          @click="actions.toggleAttack()"
        >
          <span class="btn-label">Attack</span>
          <span class="btn-key">{{ hotkey('combat.attack') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.waypointMode === 'fight' }"
          :style="{ '--btn-color': WAYPOINT_COLOR_CSS.fight }"
          :title="actionTitle('Attack line', 'combat.attackLine', 'Right-drag to draw a fight line')"
          @click="actions.setWaypointMode('fight')"
        >
          <span class="btn-label">Atk Line</span>
          <span class="btn-key">{{ hotkey('combat.attackLine') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isAttackAreaMode }"
          :style="{ '--btn-color': BUTTON_COLORS.attackArea }"
          :title="actionTitle('Area attack', 'combat.attackArea', 'Toggle targeting for selected units')"
          @click="actions.toggleAttackArea()"
        >
          <span class="btn-label">Area</span>
          <span class="btn-key">{{ hotkey('combat.attackArea') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isAttackGroundMode }"
          :style="{ '--btn-color': BUTTON_COLORS.attackGround }"
          :title="actionTitle('Attack ground', 'combat.attackGround', 'Click a ground point to force-fire at it')"
          @click="actions.toggleAttackGround()"
        >
          <span class="btn-label">Ground</span>
          <span class="btn-key">{{ hotkey('combat.attackGround') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isPingMode }"
          :style="{ '--btn-color': BUTTON_COLORS.ping }"
          :title="actionTitle('Ping', 'combat.ping')"
          @click="actions.togglePing()"
        >
          <span class="btn-label">Ping</span>
          <span class="btn-key">{{ hotkey('combat.ping') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isGuardMode }"
          :style="{ '--btn-color': BUTTON_COLORS.guard }"
          :title="actionTitle('Guard', 'combat.guard')"
          @click="actions.toggleGuard()"
        >
          <span class="btn-label">Guard</span>
          <span class="btn-key">{{ hotkey('combat.guard') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.stop }"
          :title="actionTitle('Stop', 'command.stop')"
          @click="actions.stopSelectedUnits()"
        >
          <span class="btn-label">Stop</span>
          <span class="btn-key">{{ hotkey('command.stop') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isWaiting }"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          :title="actionTitle('Wait', 'command.wait', 'Shift-click queues; Ctrl/Cmd+Shift-click inserts next')"
          @click="toggleWaitFromClick"
        >
          <span class="btn-label">Wait</span>
          <span class="btn-key">{{ hotkey('command.wait') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isGatherWaiting }"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          :title="actionTitle('Gather Wait', 'command.gatherWait', 'Shift-click queues; Ctrl/Cmd+Shift-click inserts next')"
          @click="toggleGatherWaitFromClick"
        >
          <span class="btn-label">Gather</span>
          <span class="btn-key">{{ hotkey('command.gatherWait') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isRepeatQueue }"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          :title="actionTitle(selection.isRepeatQueue ? 'Repeat orders off' : 'Repeat orders', 'command.repeat')"
          @click="actions.toggleRepeatQueue()"
        >
          <span class="btn-label">Repeat</span>
          <span class="btn-key">{{ hotkey('command.repeat') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.unitMoveState !== 'maneuver' }"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          :title="actionTitle(`Move state: ${moveStateLabel(selection.unitMoveState)}; next ${nextMoveStateLabel(selection.unitMoveState)}`, 'command.moveState')"
          @click="actions.toggleUnitMoveState()"
        >
          <span class="btn-label">{{ moveStateLabel(selection.unitMoveState) }}</span>
          <span class="btn-key">{{ hotkey('command.moveState') }}</span>
        </button>
        <button
          v-if="selection.hasCloakControl"
          type="button"
          class="action-btn"
          :class="{ active: selection.wantsCloak || selection.isCloaked }"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          :title="actionTitle(selection.wantsCloak ? 'Disable cloak' : 'Enable cloak', 'command.cloak')"
          @click="actions.toggleCloakState()"
        >
          <span class="btn-label">{{ cloakStateLabel(selection) }}</span>
          <span class="btn-key">{{ hotkey('command.cloak') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :disabled="!selection.hasQueuedOrders"
          :style="{ '--btn-color': BUTTON_COLORS.skipQueue }"
          :title="actionTitle('Skip current order', 'command.skipCurrent')"
          @click="actions.skipCurrentOrder()"
        >
          <span class="btn-label">Skip Q</span>
          <span class="btn-key">{{ hotkey('command.skipCurrent') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :disabled="!selection.hasQueuedOrders"
          :style="{ '--btn-color': BUTTON_COLORS.undoQueue }"
          :title="actionTitle('Undo queued order', 'command.undoQueue')"
          @click="actions.removeLastQueuedOrder()"
        >
          <span class="btn-label">Undo Q</span>
          <span class="btn-key">{{ hotkey('command.undoQueue') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :disabled="!selection.hasQueuedOrders"
          :style="{ '--btn-color': BUTTON_COLORS.clearQueue }"
          :title="actionTitle('Clear queued orders', 'command.clearQueue')"
          @click="actions.clearQueuedOrders()"
        >
          <span class="btn-label">Clear Q</span>
          <span class="btn-key">{{ hotkey('command.clearQueue') }}</span>
        </button>
      </div>
    </div>

    <div v-if="showQueueInsertPicker" class="button-group">
      <div class="group-label">Insert</div>
      <div class="buttons bar-command-grid">
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.queueInsertIndex === null }"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          title="Append queued commands"
          @click="actions.setQueueInsertIndex(null)"
        >
          <span class="btn-label">Append</span>
        </button>
        <button
          v-for="option in selection.queueInsertOptions"
          :key="option.index"
          type="button"
          class="action-btn"
          :class="{ active: selection.queueInsertIndex === option.index }"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          :title="queueInsertOptionTitle(option)"
          @click="actions.setQueueInsertIndex(option.index)"
        >
          <span class="btn-label">{{ option.label }}</span>
        </button>
      </div>
    </div>

    <!-- Fire control (units + towers). Lives outside the Movement
         group because towers also expose fire-at-will / hold-fire.
         See budget_design_philosophy.html "Selection Menus Are Uniform Per
         Entity Type": both unit and tower selection panels list a
         fire-control toggle. -->
    <div v-if="showCombatActions" class="button-group">
      <div class="group-label">{{ isStaticOnlySelection ? 'Tower' : 'Combat' }}</div>
      <div class="buttons bar-command-grid">
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.fireState !== 'holdFire' }"
          :style="{ '--btn-color': BUTTON_COLORS.fireControl }"
          :title="actionTitle(`Fire state: ${fireStateLabel(selection.fireState)}; next ${nextFireStateLabel(selection.fireState)}`, 'command.fireToggle')"
          @click="actions.toggleSelectedFire()"
        >
          <span class="btn-label">{{ fireStateLabel(selection.fireState) }}</span>
          <span class="btn-key">{{ hotkey('command.fireToggle') }}</span>
        </button>
        <button
          v-if="selection.hasTrajectoryControl"
          type="button"
          class="action-btn"
          :class="{ active: selection.trajectoryMode !== 'auto' }"
          :style="{ '--btn-color': BUTTON_COLORS.fireControl }"
          :title="actionTitle(`Trajectory ${selection.trajectoryMode}`, 'command.trajectoryToggle')"
          @click="actions.toggleTrajectoryMode()"
        >
          <span class="btn-label">{{ trajectoryModeLabel(selection.trajectoryMode) }}</span>
          <span class="btn-key">{{ hotkey('command.trajectoryToggle') }}</span>
        </button>
      </div>
    </div>

    <!-- Build options (for units with builder capability) -->
    <div v-if="selection.hasBuilder && showUnitActions" class="button-group bar-menu-group build-menu-group">
      <div class="group-label">Build</div>
      <div class="bar-grid-menu">
        <div class="bar-grid-heading">
          <span>{{ buildGridModeLabel }}</span>
          <span v-if="currentBuildCategory && buildGridPageCount > 1">Page {{ buildGridPage + 1 }}/{{ buildGridPageCount }}</span>
        </div>
        <div class="bar-option-grid">
        <div
          v-for="(bo, index) in buildGridCells"
          :key="buildGridCellKey(bo, index)"
          class="bar-grid-slot"
        >
          <button
            v-if="bo"
            type="button"
            class="action-btn build-btn thumbnail-action-btn bar-grid-cell"
            :class="{ active: selection.isBuildMode && selection.selectedBuildingBlueprintId === bo.buildingBlueprintId }"
            :title="costTitle(`Build ${bo.label}`, bo.cost, gridSlotHotkey(index) || bo.key)"
            @click="selection.isBuildMode && selection.selectedBuildingBlueprintId === bo.buildingBlueprintId ? actions.cancelBuild() : actions.startBuild(bo.buildingBlueprintId)"
          >
            <span v-if="gridSlotHotkey(index)" class="bar-cell-key">{{ gridSlotHotkey(index) }}</span>
            <span class="btn-thumb" aria-hidden="true">
              <img
                v-if="structureThumbnailSrc(bo.buildingBlueprintId)"
                class="btn-thumb-img"
                :src="structureThumbnailSrc(bo.buildingBlueprintId)!"
                alt=""
              >
              <span v-else class="btn-thumb-fallback">{{ compactBuildingLabel(bo.label) }}</span>
            </span>
            <span class="btn-label">{{ compactBuildingLabel(bo.label) }}</span>
            <span class="btn-cost"><span class="cost-resource">{{ bo.cost }}</span></span>
            <span class="btn-key">{{ gridSlotHotkey(index) || bo.key }}</span>
          </button>
          <div v-else class="bar-grid-cell empty" aria-hidden="true"></div>
        </div>
        </div>
        <div class="bar-grid-footer">
          <button
            v-for="category in BAR_BUILD_CATEGORIES"
            :key="category.id"
            type="button"
            class="bar-grid-category-btn"
            :class="{ active: buildGridCategory === category.id }"
            :title="buildGridCategory === category.id ? 'Back to build categories' : `${category.label} buildings - ${hotkey(category.keyCommandId)}`"
            @click="selectBuildGridCategory(category.id)"
          >
            <span class="bar-category-key">{{ hotkey(category.keyCommandId) }}</span>
            <span>{{ category.label }}</span>
          </button>
          <button
            v-if="showBuildGridPager"
            type="button"
            class="bar-grid-footer-btn"
            title="Next build page"
            @click="stepBuildGridPage(1)"
          >
            Next
          </button>
        </div>
        <div class="buttons bar-command-grid build-utility-grid">
        <button
          v-if="selection.canUpgradeMetalExtractors"
          type="button"
          class="action-btn"
          :class="{ active: selection.isMexUpgradeMode }"
          :style="{ '--btn-color': BUTTON_COLORS.build }"
          :title="actionTitle('Upgrade metal extractor area', 'command.upgradeMexArea', 'Click or drag over owned T1 extractors')"
          @click="actions.toggleMexUpgrade()"
        >
          <span class="btn-label">Mex Up</span>
          <span class="btn-key">{{ hotkey('command.upgradeMexArea') }}</span>
        </button>
        <button
          v-if="selection.isBuildMode"
          type="button"
          class="action-btn"
          :disabled="selection.buildLineSpacingMultiplier <= 1"
          :style="{ '--btn-color': BUTTON_COLORS.build }"
          :title="actionTitle(`Tighten build-line spacing (${buildLineSpacingLabel})`, 'build.spacingDecrease')"
          @click="actions.decreaseBuildLineSpacing()"
        >
          <span class="btn-label">Gap -</span>
          <span class="btn-key">{{ hotkey('build.spacingDecrease') }}</span>
        </button>
        <button
          v-if="selection.isBuildMode"
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.build }"
          :title="actionTitle(`Widen build-line spacing (${buildLineSpacingLabel})`, 'build.spacingIncrease')"
          @click="actions.increaseBuildLineSpacing()"
        >
          <span class="btn-label">Gap +</span>
          <span class="btn-key">{{ hotkey('build.spacingIncrease') }}</span>
        </button>
        <button
          v-if="selection.isBuildMode"
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.build }"
          :title="actionTitle(`Rotate build counterclockwise (${buildFacingLabel})`, 'build.rotateCounterClockwise')"
          @click="actions.rotateBuildFacingCounterClockwise()"
        >
          <span class="btn-label">Rot -</span>
          <span class="btn-key">{{ hotkey('build.rotateCounterClockwise') }}</span>
        </button>
        <button
          v-if="selection.isBuildMode"
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.build }"
          :title="actionTitle(`Rotate build clockwise (${buildFacingLabel})`, 'build.rotateClockwise')"
          @click="actions.rotateBuildFacingClockwise()"
        >
          <span class="btn-label">Rot +</span>
          <span class="btn-key">{{ hotkey('build.rotateClockwise') }}</span>
        </button>
        </div>
      </div>
    </div>

    <!-- Unit specials -->
    <div v-if="(selection.hasDGun || selection.hasCommander || selection.hasTransport) && showUnitActions" class="button-group">
      <div class="group-label">Special</div>
      <div class="buttons bar-command-grid">
        <button
          v-if="selection.hasDGun"
          type="button"
          class="action-btn dgun-btn"
          :class="{ active: selection.isDGunMode }"
          :title="actionTitle('D-Gun', 'command.dgun', 'Cost 200E')"
          @click="actions.toggleDGun()"
        >
          <span class="btn-label">D-Gun</span>
          <span class="btn-cost"><span class="cost-energy">200E</span></span>
          <span class="btn-key">{{ hotkey('command.dgun') }}</span>
        </button>
        <button
          v-if="selection.hasCommander"
          type="button"
          class="action-btn"
          :class="{ active: selection.isRepairAreaMode }"
          :style="{ '--btn-color': BUTTON_COLORS.repair }"
          :title="actionTitle('Repair area', 'combat.repairArea')"
          @click="actions.toggleRepairArea()"
        >
          <span class="btn-label">Repair</span>
          <span class="btn-key">{{ hotkey('combat.repairArea') }}</span>
        </button>
        <button
          v-if="selection.hasCommander"
          type="button"
          class="action-btn"
          :class="{ active: selection.isReclaimMode }"
          :style="{ '--btn-color': BUTTON_COLORS.reclaim }"
          :title="actionTitle('Reclaim', 'combat.reclaim')"
          @click="actions.toggleReclaim()"
        >
          <span class="btn-label">Reclaim</span>
          <span class="btn-key">{{ hotkey('combat.reclaim') }}</span>
        </button>
        <button
          v-if="selection.hasCommander"
          type="button"
          class="action-btn"
          :class="{ active: selection.isCaptureMode }"
          :style="{ '--btn-color': BUTTON_COLORS.reclaim }"
          :title="actionTitle('Capture', 'combat.capture')"
          @click="actions.toggleCapture()"
        >
          <span class="btn-label">Capture</span>
          <span class="btn-key">{{ hotkey('combat.capture') }}</span>
        </button>
        <button
          v-if="selection.hasCommander"
          type="button"
          class="action-btn"
          :disabled="!selection.hasReclaimableSelection"
          :style="{ '--btn-color': BUTTON_COLORS.reclaim }"
          title="Reclaim selected targets"
          @click="actions.reclaimSelected()"
        >
          <span class="btn-label">Reclaim Sel</span>
        </button>
        <button
          v-if="selection.hasTransport"
          type="button"
          class="action-btn"
          :class="{ active: selection.isLoadTransportMode }"
          :style="{ '--btn-color': BUTTON_COLORS.guard }"
          :title="actionTitle('Load transport', 'combat.loadTransport', 'Click a friendly unit')"
          @click="actions.toggleLoadTransport()"
        >
          <span class="btn-label">Load</span>
          <span class="btn-key">{{ hotkey('combat.loadTransport') }}</span>
        </button>
        <button
          v-if="selection.hasTransport"
          type="button"
          class="action-btn"
          :class="{ active: selection.isUnloadTransportMode }"
          :style="{ '--btn-color': BUTTON_COLORS.move }"
          :title="actionTitle('Unload transport', 'combat.unloadTransport', 'Click ground')"
          @click="actions.toggleUnloadTransport()"
        >
          <span class="btn-label">Unload</span>
          <span class="btn-key">{{ hotkey('combat.unloadTransport') }}</span>
        </button>
      </div>
    </div>

    <!-- Factory production control -->
    <div v-if="selection.hasFactory && selection.factoryId && showTowerActions" class="button-group">
      <div class="group-label">Factory</div>
      <div
        class="factory-status"
        :class="{ producing: selection.factoryIsProducing }"
        :title="factoryStatusTitle"
      >
        <div class="factory-status-row">
          <span class="factory-status-name">{{ factoryStatusLabel }}</span>
          <span class="factory-status-progress">{{ factoryProgressPercent }}%</span>
        </div>
        <div class="factory-progress-track">
          <div class="factory-progress-fill" :style="factoryProgressStyle"></div>
        </div>
        <div v-if="factoryQueueSummary" class="factory-queue-row">{{ factoryQueueSummary }}</div>
      </div>
      <div v-if="factoryQueueRuns.length > 0" class="factory-queue-controls">
        <div
          v-for="(run, runIndex) in factoryQueueRuns"
          :key="`${run.startIndex}-${run.unitBlueprintId}`"
          class="factory-queue-control-row"
        >
          <span class="factory-queue-control-name">{{ run.label }} x{{ run.count }}</span>
          <button
            type="button"
            class="factory-queue-control-btn"
            :disabled="runIndex === 0"
            :title="`Move ${run.label} earlier`"
            @click="moveFactoryQueueRun(runIndex, -1)"
          >Up</button>
          <button
            type="button"
            class="factory-queue-control-btn"
            :disabled="runIndex >= factoryQueueRuns.length - 1"
            :title="`Move ${run.label} later`"
            @click="moveFactoryQueueRun(runIndex, 1)"
          >Down</button>
          <button
            type="button"
            class="factory-queue-control-btn"
            :disabled="run.count <= 1"
            :title="`Decrease ${run.label} quantity`"
            @click="setFactoryQueueRunCount(run, run.count - 1)"
          >-</button>
          <button
            type="button"
            class="factory-queue-control-btn"
            :title="`Increase ${run.label} quantity`"
            @click="setFactoryQueueRunCount(run, run.count + 1)"
          >+</button>
          <button
            type="button"
            class="factory-queue-control-btn remove"
            :title="`Remove ${run.label}`"
            @click="editFactoryQueueRun(run, 'remove')"
          >Del</button>
        </div>
      </div>
      <div class="buttons">
        <button
          type="button"
          class="action-btn"
          :disabled="!hasFactoryProduction"
          :style="{ '--btn-color': BUTTON_COLORS.stop }"
          :title="actionTitle('Stop production', 'factory.stopProduction')"
          @click="actions.stopFactoryProduction(selection.factoryId!)"
        >
          <span class="btn-label">Stop</span>
          <span class="btn-key">{{ hotkey('factory.stopProduction') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :disabled="selection.factoryGuardTargetId === null || selection.factoryGuardTargetId === undefined"
          :style="{ '--btn-color': BUTTON_COLORS.guard }"
          :title="actionTitle('Clear factory guard', 'command.factoryGuard')"
          @click="actions.clearFactoryGuard(selection.factoryId!)"
        >
          <span class="btn-label">Clr Guard</span>
          <span class="btn-key">{{ hotkey('command.factoryGuard') }}</span>
        </button>
      </div>
    </div>

    <div v-if="selection.hasFactory && selection.factoryId && showTowerActions" class="button-group factory-preset-group">
      <div class="group-label">Presets</div>
      <div class="factory-preset-grid">
        <button
          v-for="(_, index) in factoryPresetSlots"
          :key="`load-${index}`"
          type="button"
          class="action-btn factory-preset-btn"
          :class="{ active: factoryPresetSlots[index] === selectedBuildUnitBlueprintId && factoryPresetSlots[index] !== null }"
          :disabled="factoryPresetSlots[index] === null && !hasFactoryProduction"
          :style="{ '--btn-color': BUTTON_COLORS.vehicleProduce }"
          :title="factoryPresetActionTitle(index, factoryPresetLoadCommandId(index), 'Load')"
          @click="loadFactoryPreset(index)"
        >
          <span class="btn-label">P{{ index + 1 }}</span>
          <span class="btn-key">{{ factoryPresetLoadKey(index) }} / {{ factoryPresetShortName(factoryPresetSlots[index]) }}</span>
        </button>
        <button
          v-for="(_, index) in factoryPresetSlots"
          :key="`save-${index}`"
          type="button"
          class="action-btn factory-preset-btn save"
          :disabled="!hasFactoryPresetToSave"
          :style="{ '--btn-color': BUTTON_COLORS.botProduce }"
          :title="factoryPresetActionTitle(index, factoryPresetSaveCommandId(index), 'Save current')"
          @click="saveFactoryPreset(index)"
        >
          <span class="btn-label">S{{ index + 1 }}</span>
          <span class="btn-key">{{ factoryPresetSaveKey(index) }}</span>
        </button>
      </div>
    </div>

    <!-- Factory production (for fabricator towers). BAR labs use a
         fixed 3x4 unit grid with pages instead of separate long rows. -->
    <div v-if="selection.hasFactory && selection.factoryId && showTowerActions" class="button-group bar-menu-group">
      <div class="group-label">Produce</div>
      <div class="bar-grid-menu">
        <div class="bar-grid-heading">
          <span>Units</span>
          <span v-if="factoryGridPageCount > 1">Page {{ factoryGridPage + 1 }}/{{ factoryGridPageCount }}</span>
        </div>
        <div class="bar-option-grid">
          <div
            v-for="(uo, index) in factoryGridCells"
            :key="factoryGridCellKey(uo, index)"
            class="bar-grid-slot"
          >
            <button
              v-if="uo"
              type="button"
              class="action-btn produce-btn thumbnail-action-btn bar-grid-cell"
              :class="{
                active: selectedBuildUnitBlueprintId === uo.unitBlueprintId,
                'vehicle-btn': uo.locomotion !== 'legs',
                'bot-btn': uo.locomotion === 'legs',
              }"
              :title="costTitle(`Repeat ${uo.label}; Shift-click queue; Shift+Alt queues five`, uo.cost)"
              @click="(event) => queueFactoryUnitFromClick(selection.factoryId!, uo.unitBlueprintId, event)"
            >
              <span class="btn-thumb" aria-hidden="true">
                <img
                  v-if="unitThumbnailSrc(uo.unitBlueprintId)"
                  class="btn-thumb-img"
                  :src="unitThumbnailSrc(uo.unitBlueprintId)!"
                  alt=""
                >
                <span v-else class="btn-thumb-fallback">{{ uo.shortName }}</span>
              </span>
              <span class="btn-label">{{ uo.shortName }}</span>
              <span class="btn-cost"><span class="cost-resource">{{ uo.cost }}</span></span>
            </button>
            <div v-else class="bar-grid-cell empty" aria-hidden="true"></div>
          </div>
        </div>
        <div v-if="factoryGridPageCount > 1" class="bar-grid-footer">
          <button
            type="button"
            class="bar-grid-footer-btn"
            title="Previous unit page"
            @click="stepFactoryGridPage(-1)"
          >
            Prev
          </button>
          <button
            type="button"
            class="bar-grid-footer-btn"
            title="Next unit page"
            @click="stepFactoryGridPage(1)"
          >
            Next
          </button>
        </div>
      </div>
    </div>

    <!-- Combat lock-on. Set Target enters a no-ground click-pick mode
         (the next left-click on any entity with an ID sets the host-level
         priorityTargetId; ground clicks are ignored); Clear Target
         drops the lock and reverts to autonomous acquisition.
         Applies to selected combat units and towers with turrets. -->
    <div v-if="selection.hasTowerTargetControl && showCombatActions" class="button-group">
      <div class="group-label">Target</div>
      <div class="buttons bar-command-grid">
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isTowerTargetMode }"
          :style="{ '--btn-color': BUTTON_COLORS.attackArea }"
          :title="actionTitle('Set target no ground', 'combat.towerTargetSet', 'Click an entity to lock on; ground clicks are ignored')"
          @click="actions.setTowerTargetMode()"
        >
          <span class="btn-label">No Ground</span>
          <span class="btn-key">{{ hotkey('combat.towerTargetSet') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isManualLaunchMode }"
          :style="{ '--btn-color': BUTTON_COLORS.attackArea }"
          :title="actionTitle('Manual launch', 'combat.manualLaunch', 'Click ground to force one volley')"
          @click="actions.toggleManualLaunch()"
        >
          <span class="btn-label">Launch</span>
          <span class="btn-key">{{ hotkey('combat.manualLaunch') }}</span>
        </button>
        <button
          type="button"
          class="action-btn"
          :disabled="!selection.hasTowerTargetActive"
          :style="{ '--btn-color': BUTTON_COLORS.stop }"
          :title="actionTitle('Clear target', 'combat.towerTargetClear')"
          @click="actions.clearTowerTarget()"
        >
          <span class="btn-label">Clear</span>
          <span class="btn-key">{{ hotkey('combat.towerTargetClear') }}</span>
        </button>
      </div>
    </div>

    <!-- Metal extractor upgrade. Selected T1 extractors can be replaced
         by T2 construction shells; the command chooses an owned builder. -->
    <div v-if="selection.hasUpgradeableMetalExtractor && showBuildingActions" class="button-group">
      <div class="group-label">Upgrade</div>
      <div class="buttons bar-command-grid">
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.build }"
          :title="actionTitle('Upgrade selected metal extractor', 'command.upgradeMexSelected')"
          @click="actions.upgradeSelectedMetalExtractors()"
        >
          <span class="btn-label">T2 Mex</span>
          <span class="btn-key">{{ hotkey('command.upgradeMexSelected') }}</span>
        </button>
      </div>
    </div>

    <!-- Building ON/OFF. Producer Buildings Are ON/OFF in
         budget_design_philosophy.html: solar/wind/extractor selections expose
         this toggle. ON = producing + normal damage; OFF = not
         producing + 10x damage resistance. -->
    <div v-if="selection.hasBuildingActiveControl && showBuildingActions" class="button-group">
      <div class="group-label">Power</div>
      <div class="buttons bar-command-grid">
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.buildingsActive }"
          :style="{ '--btn-color': BUTTON_COLORS.buildingActive }"
          :title="actionTitle(selection.buildingsActive ? 'Turn off' : 'Turn on', 'command.buildingActive')"
          @click="actions.toggleBuildingActive()"
        >
          <span class="btn-label">{{ selection.buildingsActive ? 'On' : 'Off' }}</span>
          <span class="btn-key">{{ hotkey('command.buildingActive') }}</span>
        </button>
      </div>
    </div>

    <!-- Self-Destruct. Per "Selection Menus Are Uniform Per Entity Type"
         every unit / tower / building selection panel exposes a
         self-destruct affordance. -->
    <div v-if="selection.hasSelfDestructable" class="button-group">
      <div class="group-label">Demolish</div>
      <div class="buttons bar-command-grid">
        <button
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.selfDestruct }"
          :title="actionTitle('Destroy selection', 'command.selfDestruct')"
          @click="actions.selfDestructSelected()"
        >
          <span class="btn-label">Destroy</span>
          <span class="btn-key">{{ hotkey('command.selfDestruct') }}</span>
        </button>
      </div>
    </div>

    <!-- Cancel affordance appears only while a click-pick mode is active. -->
    <div v-if="showCancelHint" class="message-area">
      Press ESC or Right-click to cancel
    </div>
  </div>
</template>

<style scoped>
/* Base panel styles — aligned with the bottom-bar aesthetic
 * (dark semi-transparent base + muted gray border). Rounded
 * corners stay so the panel still reads as a discrete card. */
.options-panel {
  position: fixed;
  left: calc(50% - 212px);
  bottom: clamp(300px, 39.5vh, 356px);
  display: flex;
  flex-direction: column;
  width: 424px;
  background: var(--selection-panel-bg);
  border: 1px solid var(--selection-panel-border);
  border-radius: 6px;
  padding: 6px;
  max-width: min(424px, calc(100vw - 32px));
  max-height: min(168px, calc(100vh - 420px));
  overflow-y: auto;
  font-family: monospace;
  color: var(--selection-panel-text);
  pointer-events: auto;
  z-index: 1000;
}

.options-panel::-webkit-scrollbar {
  width: 7px;
}

.options-panel::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.04);
}

.options-panel::-webkit-scrollbar-thumb {
  background: rgba(237, 243, 255, 0.18);
  border-radius: 4px;
}

@media (max-width: 900px) {
  .options-panel {
    right: 0;
    left: auto;
    width: min(360px, calc(100vw - 350px));
    min-width: min(300px, calc(100vw - 16px));
  }
}

.panel-header {
  order: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  font-weight: bold;
  margin-top: 5px;
  margin-bottom: 0;
  padding-top: 5px;
  border-top: 1px solid var(--selection-panel-header-border);
}

.selection-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unit-type.commander {
  color: var(--selection-panel-commander);
}

.unit-type.factory {
  color: var(--selection-panel-factory);
}

.panel-help {
  position: relative;
  flex: 0 0 auto;
}

.help-btn {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  background: var(--selection-panel-button-bg);
  border: 1px solid var(--selection-panel-button-border);
  border-radius: 50%;
  color: var(--selection-panel-key);
  font-family: monospace;
  font-size: 11px;
  line-height: 1;
  cursor: help;
}

.help-btn:hover,
.help-btn:focus-visible {
  background: var(--selection-panel-button-hover-bg);
  border-color: var(--selection-panel-button-group-accent);
  color: var(--selection-panel-text);
}

.hotkey-popover {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  width: 245px;
  padding: 8px;
  background: var(--selection-panel-bg);
  border: 1px solid var(--selection-panel-button-group-accent);
  border-radius: 5px;
  color: var(--selection-panel-text);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
  font-size: 10px;
  font-weight: normal;
  line-height: 1.45;
  opacity: 0;
  pointer-events: none;
  transform: translateY(4px);
  transition: opacity 0.12s ease, transform 0.12s ease;
  z-index: 3;
}

.panel-help:hover .hotkey-popover,
.panel-help:focus-within .hotkey-popover {
  opacity: 1;
  transform: translateY(0);
}

.hotkey-title {
  margin-bottom: 3px;
  color: var(--selection-panel-label);
  font-size: 9px;
  font-weight: bold;
  text-transform: uppercase;
}

.hotkey-footnote {
  margin-top: 4px;
  color: var(--selection-panel-key);
}

kbd {
  padding: 0 3px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 3px;
  color: var(--selection-panel-text);
  font-family: monospace;
  font-size: 9px;
}

.control-group-strip {
  order: 41;
  display: grid;
  grid-template-columns: repeat(10, 30px);
  gap: 3px;
  margin-top: 5px;
  margin-bottom: 5px;
}

.control-group-chip {
  position: relative;
  display: grid;
  grid-template-columns: 10px 1fr;
  align-items: center;
  width: 30px;
  height: 22px;
  padding: 0 3px;
  background: var(--selection-panel-button-bg);
  border: 1px solid var(--selection-panel-button-border);
  border-radius: 3px;
  color: var(--selection-panel-key);
  font-family: monospace;
  font-size: 8px;
  line-height: 1;
  cursor: pointer;
}

.control-group-chip:disabled {
  opacity: var(--selection-panel-button-disabled-opacity);
  cursor: default;
}

.control-group-chip.active {
  border-color: var(--selection-panel-button-group-accent);
  color: var(--selection-panel-text);
  box-shadow: 0 0 5px var(--selection-panel-group-active-shadow);
}

.control-group-chip.auto {
  border-color: var(--selection-panel-vehicle-produce);
}

.control-group-index {
  font-weight: bold;
}

.control-group-count {
  min-width: 0;
  overflow: hidden;
  text-align: right;
  text-overflow: clip;
}

.control-group-auto {
  position: absolute;
  top: -5px;
  right: -4px;
  display: grid;
  place-items: center;
  width: 12px;
  height: 12px;
  background: var(--selection-panel-bg);
  border: 1px solid var(--selection-panel-vehicle-produce);
  border-radius: 50%;
  color: var(--selection-panel-vehicle-produce);
  font-weight: 700;
  font-size: 9px;
  font-weight: bold;
}

.button-group {
  order: 10;
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 4px;
}

.group-label {
  flex: 0 0 48px;
  font-size: 8px;
  color: var(--selection-panel-label);
  margin-bottom: 0;
  text-align: right;
  text-transform: uppercase;
}

.details-group {
  order: 42;
  align-items: stretch;
}

.build-menu-group {
  order: 3;
}

.message-area {
  order: 99;
}

.details-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(120px, 1fr));
  gap: 3px;
  min-width: 0;
}

.factory-preset-group {
  align-items: flex-start;
}

.factory-preset-grid {
  display: grid;
  grid-template-columns: repeat(4, 30px);
  grid-auto-rows: 30px;
  gap: 3px;
  min-width: 0;
}

.factory-preset-btn {
  width: 30px;
  height: 30px;
}

.factory-preset-btn.save {
  opacity: 0.88;
}

.factory-status {
  flex: 0 1 150px;
  min-width: 120px;
  padding: 3px 5px;
  background: rgba(20, 22, 26, 0.66);
  border: 1px solid var(--selection-panel-button-border);
  border-radius: 3px;
}

.factory-status.producing {
  border-color: var(--selection-panel-vehicle-produce);
}

.factory-status-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  margin-bottom: 3px;
  font-family: monospace;
  font-size: 8px;
  line-height: 1;
}

.factory-status-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: clip;
  white-space: nowrap;
}

.factory-status-progress {
  color: var(--selection-panel-key);
  font-weight: bold;
}

.factory-queue-row {
  margin-top: 3px;
  color: var(--selection-panel-text-muted);
  font-family: monospace;
  font-size: 8px;
  line-height: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.factory-queue-controls {
  flex: 1 1 100%;
  display: grid;
  gap: 3px;
  min-width: 0;
}

.factory-queue-control-row {
  display: grid;
  grid-template-columns: minmax(54px, 1fr) repeat(5, minmax(28px, auto));
  gap: 3px;
  align-items: center;
  min-width: 0;
  padding: 2px 3px;
  background: rgba(20, 22, 26, 0.46);
  border: 1px solid rgba(237, 243, 255, 0.1);
  border-radius: 3px;
}

.factory-queue-control-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9px;
}

.factory-queue-control-btn {
  min-width: 28px;
  height: 18px;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--selection-panel-button-border);
  background: rgba(40, 44, 54, 0.86);
  color: var(--selection-panel-text);
  font-size: 8px;
  line-height: 1;
  cursor: pointer;
}

.factory-queue-control-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.factory-queue-control-btn.remove {
  color: var(--selection-panel-stop);
}

.factory-progress-track {
  height: 4px;
  overflow: hidden;
  background: rgba(237, 243, 255, 0.12);
  border-radius: 2px;
}

.factory-progress-fill {
  height: 100%;
  background: var(--selection-panel-vehicle-produce);
  transition: width 0.12s ease;
}

.detail-item {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 5px;
  min-height: 20px;
  padding: 2px 5px;
  background: rgba(20, 22, 26, 0.66);
  border: 1px solid var(--selection-panel-button-border);
  border-radius: 3px;
  font-size: 10px;
  line-height: 1.1;
}

.detail-label {
  color: var(--selection-panel-label);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-value {
  color: var(--selection-panel-text);
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modifier-hint {
  font-size: 9px;
  color: var(--selection-panel-hint);
  text-transform: none;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.buttons.bar-command-grid {
  display: grid;
  grid-template-columns: repeat(4, 46px);
  gap: 3px;
  align-items: stretch;
}

.bar-command-grid .action-btn {
  width: 46px;
  min-width: 46px;
  height: 26px;
  padding: 0 3px;
}

.bar-menu-group {
  position: fixed;
  top: 264px;
  left: 0;
  bottom: auto;
  z-index: 1001;
  align-items: flex-start;
  margin: 0;
  padding: 6px;
  background: var(--selection-panel-bg);
  border: 1px solid var(--selection-panel-border);
  border-left: 0;
  border-radius: 0 6px 6px 0;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
}

@media (max-width: 900px) {
  .bar-menu-group {
    left: 0;
  }
}

.bar-grid-menu {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.bar-grid-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 12px;
  color: var(--selection-panel-label);
  font-size: 8px;
  font-weight: bold;
  line-height: 1;
  text-transform: uppercase;
}

.bar-option-grid {
  display: grid;
  grid-template-columns: repeat(4, 66px);
  grid-auto-rows: 62px;
  gap: 3px;
}

.bar-grid-slot {
  min-width: 0;
  min-height: 0;
}

.bar-grid-cell {
  width: 66px;
  min-width: 66px;
  height: 62px;
  border-radius: 3px;
}

.bar-grid-cell.empty {
  background:
    linear-gradient(135deg, transparent 47%, rgba(237, 243, 255, 0.08) 48%, rgba(237, 243, 255, 0.08) 52%, transparent 53%),
    rgba(20, 22, 26, 0.42);
  border: 1px solid rgba(237, 243, 255, 0.08);
}

.bar-grid-cell.thumbnail-action-btn {
  width: 66px;
  min-width: 66px;
  height: 62px;
  padding: 0;
  overflow: hidden;
}

.bar-grid-cell .btn-thumb {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  background: rgba(255, 255, 255, 0.035);
  border-radius: 0;
}

.bar-grid-cell .btn-thumb::after {
  content: "";
  position: absolute;
  inset: auto 0 0;
  height: 55%;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.82), rgba(0, 0, 0, 0));
  pointer-events: none;
}

.bar-grid-cell .btn-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scale(2.2);
  transform-origin: center;
}

.bar-grid-cell .btn-label {
  position: absolute;
  right: 2px;
  bottom: 12px;
  left: 2px;
  z-index: 1;
  max-width: none;
  color: #ffffff;
  font-size: 8px;
  line-height: 1;
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 1);
}

.bar-grid-cell .btn-cost {
  position: absolute;
  right: 3px;
  bottom: 3px;
  z-index: 1;
  display: block;
  font-size: 8px;
  font-weight: bold;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}

.bar-cell-key {
  position: absolute;
  left: 3px;
  top: 3px;
  display: grid;
  place-items: center;
  min-width: 12px;
  height: 12px;
  padding: 0 2px;
  background: rgba(5, 7, 10, 0.68);
  border: 1px solid color-mix(in srgb, var(--btn-color) 52%, transparent);
  border-radius: 2px;
  color: var(--selection-panel-key);
  font-size: 8px;
  font-weight: bold;
  line-height: 1;
  z-index: 1;
}

.bar-grid-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.bar-grid-category-btn,
.bar-grid-footer-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px;
  background: var(--selection-panel-button-bg);
  border: 1px solid var(--selection-panel-button-border);
  border-radius: 3px;
  color: var(--selection-panel-text);
  font-family: monospace;
  font-size: 8px;
  font-weight: bold;
  line-height: 1;
  cursor: pointer;
}

.bar-grid-category-btn {
  width: 66px;
  justify-content: flex-start;
  padding: 0 4px;
}

.bar-grid-category-btn:hover,
.bar-grid-footer-btn:hover,
.bar-grid-category-btn.active {
  border-color: var(--selection-panel-build);
  background: var(--selection-panel-button-hover-bg);
}

.bar-grid-category-btn.active {
  box-shadow: 0 0 5px var(--selection-panel-build);
}

.bar-category-key {
  display: grid;
  place-items: center;
  min-width: 13px;
  height: 13px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 2px;
  color: var(--selection-panel-key);
}

.build-utility-grid {
  margin-top: 1px;
}

.build-utility-grid:empty {
  display: none;
}

.action-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  min-width: 30px;
  padding: 0 5px;
  background: var(--selection-panel-button-bg);
  border: 1px solid var(--selection-panel-button-border);
  border-radius: 3px;
  color: var(--selection-panel-text);
  font-family: monospace;
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s ease;
  --btn-color: var(--selection-panel-button-default);
}

.action-btn:hover {
  background: var(--selection-panel-button-hover-bg);
  border-color: var(--btn-color);
}

.action-btn:disabled {
  opacity: var(--selection-panel-action-disabled-opacity);
  cursor: default;
}

.action-btn:disabled:hover {
  background: var(--selection-panel-button-bg);
  border-color: var(--selection-panel-button-border);
}

.action-btn.active {
  background: var(--selection-panel-button-active-bg);
  border-color: var(--btn-color);
  box-shadow: 0 0 5px var(--btn-color);
}

.btn-label {
  display: block;
  max-width: 8ch;
  overflow: hidden;
  font-weight: bold;
  text-overflow: clip;
  white-space: nowrap;
}

.btn-cost {
  display: none;
}

.cost-energy {
  color: var(--selection-panel-cost-energy);
}

/* Unified construction cost across energy and metal. */
.cost-resource {
  color: var(--selection-panel-cost-resource);
}

.btn-key {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 5px);
  padding: 2px 5px;
  background: var(--selection-panel-bg);
  border: 1px solid var(--btn-color);
  border-radius: 3px;
  color: var(--selection-panel-key);
  font-size: 10px;
  font-weight: bold;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
  transform: translateX(-50%) translateY(2px);
  transition: opacity 0.12s ease, transform 0.12s ease;
  white-space: nowrap;
  z-index: 2;
}

.action-btn:hover .btn-key,
.action-btn:focus-visible .btn-key {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.build-btn {
  --btn-color: var(--selection-panel-build);
}

.thumbnail-action-btn {
  flex-direction: column;
  gap: 1px;
  width: 46px;
  height: 42px;
  min-width: 46px;
  padding: 2px 3px 3px;
}

.btn-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 25px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.055);
  border: 1px solid color-mix(in srgb, var(--btn-color) 32%, transparent);
  border-radius: 2px;
}

.btn-thumb-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.btn-thumb-fallback {
  color: var(--selection-panel-hint);
  font-size: 8px;
  font-weight: bold;
  line-height: 1;
}

.thumbnail-action-btn .btn-label {
  max-width: 40px;
  font-size: 8px;
  line-height: 1;
  text-align: center;
}

.build-category-group {
  display: flex;
  align-items: center;
  gap: 3px;
}

.build-category-label {
  color: var(--selection-panel-label);
  font-size: 7px;
  font-weight: bold;
  line-height: 1;
  text-transform: uppercase;
}

.dgun-btn {
  --btn-color: var(--selection-panel-dgun);
}

.produce-btn.vehicle-btn {
  --btn-color: var(--selection-panel-vehicle-produce);
}

.produce-btn.bot-btn {
  --btn-color: var(--selection-panel-bot-produce);
}

.message-area {
  font-size: 9px;
  color: var(--selection-panel-key);
  margin-top: 4px;
  text-align: center;
}

</style>
