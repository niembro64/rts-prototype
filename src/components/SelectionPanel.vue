<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { COLORS, WAYPOINT_COLOR_CSS } from '@/colorsConfig';
import type { CombatFireState, UnitAirIdleState, UnitMoveState, WaypointType } from '../game/sim/types';
import {
  getUnitRosterDisplay,
  structureRosterDisplay,
  type BuildMenuCategory,
} from '../game/sim/blueprints/displayRosters';
import {
  commandHotkeyLabel,
  hasBarFactoryPresetHotkeys,
  isBarCommandHotkeyPreset,
  isBarGridCommandHotkeyPreset,
  isBarLegacyCommandHotkeyPreset,
  type CommandHotkeyId,
  type CommandHotkeyPresetId,
} from '../game/input/commandHotkeys';
import {
  BAR_BUILD_CATEGORIES,
  BAR_GRID_SLOT_COUNT,
  BUILD_MENU_GRID_SLOT_COMMAND_IDS,
  buildBarClassicBuildMenuItems,
  buildFactoryUnitBlueprintIdsForPreset,
  buildFactoryUnitGridCellsForPreset,
  buildBarHomeBuildMenuCells,
  buildStructureMenuLayout,
  type BuildMenuLayoutItem,
  type BarBuildCategoryId,
} from '../game/input/buildMenuLayout';
import {
  getCachedEntityPreviewImage,
  getCachedEntityThumbnail,
  requestEntityPreviewImage,
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
  createFactoryProductionPresetSnapshot,
  getFactoryProductionPresetUnitBlueprintIds,
  getFactoryProductionPresetSlot,
  loadFactoryProductionPresetSlots,
  resolveFactoryProductionPresetReplay,
  setFactoryProductionPresetSlot,
  type FactoryProductionPresetSnapshot,
} from '../game/input/factoryProductionPresets';
import { factoryProductionClickModeFromEvent, queueModeFromEvent } from '../game/input/queueModifiers';
import type { StructureBlueprintId } from '@/types/blueprintIds';

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
  playableBottomInsetPx: number;
}>();

// Per budget_design_philosophy.html "Selection Menus Are Uniform Per Host
// Kind", units and buildings carry uniform base actions while mounted
// capabilities add combat, sensor, builder, or factory controls.
const showPanel = computed(() =>
  props.selection.unitCount > 0
  || props.selection.buildingCount > 0
  || props.selection.hasFactory,
);
const AREA_MEX_BLUEPRINT_ID: StructureBlueprintId = 'buildingExtractor';
const selectedEntityTypeCount = computed(() =>
  (props.selection.unitCount > 0 ? 1 : 0)
  + (props.selection.buildingCount > 0 ? 1 : 0),
);
const hasMixedEntityTypes = computed(() => selectedEntityTypeCount.value > 1);
// BAR merges command descriptors across a mixed selection. Host-kind sections
// stay visible whenever that kind is present; execution capability-filters the
// entity list instead of hiding every command because a building and unit are
// selected together.
const showUnitActions = computed(() => props.selection.unitCount > 0);
const showBuildingActions = computed(() => props.selection.buildingCount > 0);
const showCombatActions = computed(() => props.selection.hasFireControl);
const isBarHotkeyPreset = computed(() => isBarCommandHotkeyPreset(props.hotkeyPreset));
const showBarGridBuildCategories = computed(() => isBarGridCommandHotkeyPreset(props.hotkeyPreset));
const showBarClassicBuildMenu = computed(() => isBarLegacyCommandHotkeyPreset(props.hotkeyPreset));
const showFormationCommands = computed(() => !isBarHotkeyPreset.value);
const showAttackCommand = computed(() =>
  isBarHotkeyPreset.value ? props.selection.hasBarAttackControl : props.selection.unitCount > 0,
);
const showAttackLineCommand = computed(() => !isBarHotkeyPreset.value);
const showAttackGroundCommand = computed(() => !isBarHotkeyPreset.value);
const showPrototypeOnlyCommandButtons = computed(() => !isBarHotkeyPreset.value);
const showAttackAreaCommand = computed(() => props.selection.hasBarAreaAttackControl);
// BAR's order menu hides CMD.GATHERWAIT, settargetnoground, and CMD.SELFD even
// though several remain hotkey-accessible. Keep those as prototype-only visible
// affordances so BAR presets match the in-game order surface.
const showGatherWaitButton = computed(() => showPrototypeOnlyCommandButtons.value);
const showTowerTargetNoGroundButton = computed(() => showPrototypeOnlyCommandButtons.value);
const showSelfDestructButton = computed(() =>
  showPrototypeOnlyCommandButtons.value && props.selection.hasSelfDestructable,
);
const showFactoryQueueModeButton = computed(() => props.selection.hasFactory);
const showBuildUtilityGrid = computed(() =>
  showPrototypeOnlyCommandButtons.value &&
  (props.selection.canUpgradeMetalExtractors || props.selection.isBuildMode),
);
const showAreaMexButton = computed(() =>
  isBarHotkeyPreset.value &&
  props.selection.hasBuilder &&
  props.selection.allowedBuildBlueprintIds.includes(AREA_MEX_BLUEPRINT_ID),
);
const selectedMetalExtractorUpgradeCommandId = computed<CommandHotkeyId>(() =>
  isBarHotkeyPreset.value ? 'command.morph' : 'command.upgradeMexSelected',
);
const showBuilderPriorityButton = computed(() =>
  isBarHotkeyPreset.value && props.selection.hasBuilderPriorityControl,
);
const showCarrierSpawnButton = computed(() =>
  isBarHotkeyPreset.value && props.selection.hasCarrierSpawnControl,
);
const showFactoryGuardButton = computed(() =>
  isBarHotkeyPreset.value && props.selection.hasFactoryGuardControl,
);
const showFactoryAirIdleButton = computed(() =>
  isBarHotkeyPreset.value && props.selection.hasFactoryAirIdleControl,
);
const showTowerTargetClearButton = computed(() =>
  showPrototypeOnlyCommandButtons.value || props.selection.hasTowerTargetActive,
);
const showResurrectButton = computed(() =>
  isBarHotkeyPreset.value
    ? props.selection.hasBarResurrectControl
    : showPrototypeOnlyCommandButtons.value && props.selection.hasCommander,
);
const showCaptureButton = computed(() =>
  isBarHotkeyPreset.value ? props.selection.hasBarCaptureControl : props.selection.hasCommander,
);
const showTrajectoryButton = computed(() =>
  isBarHotkeyPreset.value ? props.selection.hasBarTrajectoryControl : props.selection.hasTrajectoryControl,
);
const visibleTrajectoryMode = computed(() =>
  isBarHotkeyPreset.value ? props.selection.barTrajectoryMode : props.selection.trajectoryMode,
);
const visibleTrajectoryStateCount = computed(() =>
  isBarHotkeyPreset.value ? props.selection.barTrajectoryStateCount : 3,
);
const showManualLaunchButton = computed(() =>
  isBarHotkeyPreset.value ? props.selection.hasManualLaunchControl : props.selection.hasTowerTargetControl,
);
// BAR ARM static defenses such as armllt/armbeamer/armrl set removewait=true
// but do not set removestop, so pure armed-building selections keep Stop
// visible while Wait stays absent.
const showStaticStopButton = computed(() =>
  isBarHotkeyPreset.value &&
  showBuildingActions.value &&
  props.selection.hasFireControl &&
  !props.selection.hasFactory,
);
// BAR armamex sets removewait=true but does not set removestop, so the
// advanced metal extractor keeps Stop visible while T1 mex/solar do not.
const showBuildingStopButton = computed(() =>
  isBarHotkeyPreset.value &&
  showBuildingActions.value &&
  props.selection.hasBarBuildingStopControl,
);
const showBuildingActiveButton = computed(() =>
  isBarHotkeyPreset.value ? props.selection.hasBarBuildingActiveControl : props.selection.hasBuildingActiveControl,
);
const selectedBuildingsActive = computed(() =>
  isBarHotkeyPreset.value ? props.selection.barBuildingsActive : props.selection.buildingsActive,
);
const showQueueInsertPicker = computed(() =>
  !isBarHotkeyPreset.value
  && showUnitActions.value
  && props.selection.queueInsertOptions.length > 0,
);
const selectOnlyOptions = computed<
  { entityType: SelectionEntityType; label: string; count: number }[]
>(() => {
  if (!hasMixedEntityTypes.value) return [];
  const options: { entityType: SelectionEntityType; label: string; count: number }[] = [];
  if (props.selection.unitCount > 0) {
    options.push({ entityType: 'unit', label: 'Units', count: props.selection.unitCount });
  }
  if (props.selection.buildingCount > 0) {
    options.push({ entityType: 'building', label: 'Buildings', count: props.selection.buildingCount });
  }
  return options;
});
// True iff the selection contains no movable unit at all — used to
// fold the unit-only action groups (movement, build, commander
// specials) out of view when only buildings are selected.
const SELECTION_PANEL = COLORS.ui.selectionPanel;
const BUTTON_COLORS = SELECTION_PANEL.buttons;
const BUILD_MENU_CATEGORY_BORDER_COLORS: Record<BuildMenuCategory, string> =
  SELECTION_PANEL.buildMenuCategoryBorders;
const BAR_WAYPOINT_COMMAND_COUNT = 3;
const BAR_ORDER_PANEL_HEIGHT_VH = 14;
const BAR_FLOW_ELEMENT_PADDING_VH = 0.3;
const BAR_ORDER_ACTIVE_PADDING_VH = BAR_FLOW_ELEMENT_PADDING_VH * 1.4;
const BAR_ORDER_BOTTOM_ACTIVE_PADDING_VH = BAR_ORDER_ACTIVE_PADDING_VH / 3;
const BAR_ORDER_ACTIVE_HEIGHT_VH =
  BAR_ORDER_PANEL_HEIGHT_VH - BAR_ORDER_ACTIVE_PADDING_VH - BAR_ORDER_BOTTOM_ACTIVE_PADDING_VH;
const BAR_ORDER_CELL_MARGIN_ORIGINAL = 0.055;

type BarOrderGridSize = {
  columns: number;
  rows: number;
};

function barOrderGridSizeForCommandCount(commandCount: number): BarOrderGridSize {
  const count = Math.max(1, Math.floor(commandCount));
  if (count <= 16) return { columns: 4, rows: 4 };
  if (count <= 20) return { columns: 5, rows: 4 };
  if (count <= 25) return { columns: 5, rows: 5 };
  if (count <= 30) return { columns: 5, rows: 6 };
  if (count <= 36) return { columns: 6, rows: 6 };
  if (count <= 42) return { columns: 6, rows: 7 };
  return { columns: 7, rows: 7 };
}

function barOrderCellMarginVh(
  gridSize: BarOrderGridSize,
  cellMarginHeightMultiplier: number,
): number {
  const sizeDivider = (gridSize.columns + gridSize.rows) / 16;
  const cellMargin = BAR_ORDER_CELL_MARGIN_ORIGINAL / sizeDivider;
  const cellHeight = BAR_ORDER_ACTIVE_HEIGHT_VH / gridSize.rows;
  return cellHeight * cellMarginHeightMultiplier * cellMargin;
}

function barOrderCellMarginCss(valueVh: number, minPixels: 0 | 1): string {
  return `max(${minPixels}px, round(up, ${valueVh.toFixed(4)}vh, 1px))`;
}

const barOrderCommandCellCount = computed(() => {
  let count = 0;
  const showPrototypeOnly = showPrototypeOnlyCommandButtons.value;

  if (showUnitActions.value) {
    count += BAR_WAYPOINT_COMMAND_COUNT;
    if (showFormationCommands.value) count += 2;
    if (showAttackCommand.value) count += 1; // attack
    if (showAttackLineCommand.value) count += 1;
    if (showAttackAreaCommand.value) count += 1;
    if (showAttackGroundCommand.value) count += 1;
    if (showPrototypeOnly) count += 1; // ping
    count += 1; // guard
    count += 1; // stop
    count += 1; // wait
    if (showGatherWaitButton.value) count += 1; // prototype Gather Wait
    count += 1; // repeat
    if (props.selection.hasMoveStateControl) count += 1;
    if (props.selection.hasCloakControl) count += 1;
    if (isBarHotkeyPreset.value) {
      if (showCombatActions.value) count += 1; // fire state
      if (showTrajectoryButton.value) count += 1;
      if (showBuilderPriorityButton.value) count += 1;
      if (showCarrierSpawnButton.value) count += 1;
    }
    if (showPrototypeOnly) count += 2; // prototype visible skip/cancel queue buttons
    if (showPrototypeOnly) count += 1; // clear queue
  }

  if (showBuildingActions.value && showAttackCommand.value) {
    count += 1;
  }

  if (showQueueInsertPicker.value) {
    count += 1 + props.selection.queueInsertOptions.length;
  }

  if (showCombatActions.value && (!isBarHotkeyPreset.value || !showUnitActions.value)) {
    count += 1; // fire state
    if (showTrajectoryButton.value) count += 1;
    if (showStaticStopButton.value) count += 1;
  }

  if (
    showUnitActions.value &&
    (
      props.selection.hasDGun ||
      props.selection.hasBuilder ||
      showCaptureButton.value ||
      showResurrectButton.value ||
      props.selection.hasCommander ||
      props.selection.hasTransport
    )
  ) {
    if (props.selection.hasDGun) count += 1;
    if (props.selection.hasBuilder) count += 2; // repair, reclaim
    if (showAreaMexButton.value) count += 1;
    if (showCaptureButton.value) count += 1; // capture
    if (showResurrectButton.value) count += 1;
    if (props.selection.hasCommander && showPrototypeOnly) count += 1; // resurrect area
    if (props.selection.hasBuilder && showPrototypeOnly) count += 1; // reclaim selected
    if (props.selection.hasTransport) count += 2; // load, unload
  }

  if (props.selection.hasTowerTargetControl && showCombatActions.value) {
    count += 1; // set target
    if (showTowerTargetNoGroundButton.value) count += 1;
    if (showManualLaunchButton.value) count += 1;
    if (showTowerTargetClearButton.value) count += 1;
  }

  if (props.selection.hasFactory && props.selection.factoryId && showBuildingActions.value) {
    if (showPrototypeOnly) count += 2; // prototype factory status spans two cells
    count += 3; // repeat, wait, stop production
    if (isBarHotkeyPreset.value && props.selection.hasMoveStateControl) count += 1;
    if (showFactoryAirIdleButton.value) count += 1;
    if (showFactoryGuardButton.value) count += 1;
    if (showBuilderPriorityButton.value) count += 1;
    if (showPrototypeOnly) count += 1; // clear explicit guard target
    if (showFactoryQueueModeButton.value) count += 1; // factory queue/quota mode
  }

  if (props.selection.hasUpgradeableMetalExtractor && showBuildingActions.value) count += 1;
  if (showBuildingActiveButton.value && showBuildingActions.value) count += 1;
  if (showBuildingStopButton.value) count += 1;
  if (showSelfDestructButton.value) count += 1;

  return count;
});

const barOrderGridSize = computed(() =>
  barOrderGridSizeForCommandCount(barOrderCommandCellCount.value),
);
const barOrderCellMarginPrimary = computed(() =>
  barOrderCellMarginCss(barOrderCellMarginVh(barOrderGridSize.value, 0.5), 1),
);
const barOrderCellMarginSecondary = computed(() =>
  barOrderCellMarginCss(barOrderCellMarginVh(barOrderGridSize.value, 0.18), 0),
);

const selectionPanelStyle = computed(() => ({
  '--bar-order-columns': String(barOrderGridSize.value.columns),
  '--bar-order-rows': String(barOrderGridSize.value.rows),
  '--bar-order-cell-margin-primary': barOrderCellMarginPrimary.value,
  '--bar-order-cell-margin-secondary': barOrderCellMarginSecondary.value,
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
  '--selection-panel-playable-bottom': `${Math.max(0, Math.round(props.playableBottomInsetPx))}px`,
}) as const);

// Factory-selected unit blueprint, whether it is a finite active job or a
// repeated selection. Used to light up the matching production button.
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
const factoryQueuedCountByUnitBlueprintId = computed(() => {
  const counts = new Map<string, number>();
  for (const unit of factoryQueuedUnits.value) {
    counts.set(unit.unitBlueprintId, (counts.get(unit.unitBlueprintId) ?? 0) + 1);
  }
  const selectedUnitBlueprintId = selectedBuildUnitBlueprintId.value;
  if (selectedUnitBlueprintId !== null && props.selection.factoryRepeatsProduction !== true) {
    counts.set(selectedUnitBlueprintId, (counts.get(selectedUnitBlueprintId) ?? 0) + 1);
  }
  return counts;
});
const factoryQuotaByUnitBlueprintId = computed(() => {
  const quotas = new Map<string, { current: number; quota: number }>();
  for (const quota of props.selection.factoryProductionQuotas ?? []) {
    quotas.set(quota.unitBlueprintId, { current: quota.current, quota: quota.quota });
  }
  return quotas;
});
const hasFactoryProduction = computed(() =>
  selectedBuildUnitBlueprintId.value !== null ||
    props.selection.factoryIsProducing === true ||
    factoryQueueCount.value > 0 ||
    (props.selection.factoryProductionQuotas?.length ?? 0) > 0,
);
const hasFactoryPresetToSave = computed(() => props.selection.factoryId !== undefined);
const factoryProgressPercent = computed(() =>
  Math.max(0, Math.min(100, Math.round((props.selection.factoryProgress ?? 0) * 100))),
);
const factoryProgressStyle = computed(() => ({
  width: `${factoryProgressPercent.value}%`,
}));
function factoryCellShowsBuildProgress(unitBlueprintId: string): boolean {
  return props.selection.factoryIsProducing === true &&
    selectedBuildUnitBlueprintId.value === unitBlueprintId;
}

function factoryCellBuildProgressStyle(unitBlueprintId: string): { '--bar-cell-progress-remaining': string } | undefined {
  if (!factoryCellShowsBuildProgress(unitBlueprintId)) return undefined;
  const progress = Math.max(0, Math.min(1, props.selection.factoryProgress ?? 0));
  return {
    '--bar-cell-progress-remaining': `${((1 - progress) * 100).toFixed(3)}%`,
  };
}

function builderTypeBuildProgressStyle(active: boolean): { '--bar-builder-progress-remaining': string } | undefined {
  if (!active || props.selection.factoryUnderConstruction !== true) return undefined;
  const progress = Math.max(0, Math.min(1, props.selection.factoryConstructionProgress ?? 0));
  return {
    '--bar-builder-progress-remaining': `${((1 - progress) * 100).toFixed(3)}%`,
  };
}
const factoryStatusLabel = computed(() => {
  const unitLabel = props.selection.factorySelectedUnit?.label ?? 'No unit';
  if (unitLabel === 'No unit') return `${unitLabel} idle`;
  const modeLabel = props.selection.factoryRepeatsProduction === true ? 'Repeat' : 'Queue';
  const queuedLabel = factoryQueueCount.value > 0 ? ` +${factoryQueueCount.value}` : '';
  if (props.selection.isWaiting) return `${modeLabel} ${unitLabel} waiting${queuedLabel}`;
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
  || props.selection.isRestoreAreaMode
  || props.selection.isAttackMode
  || props.selection.isAttackAreaMode
  || props.selection.isAttackGroundMode
  || props.selection.isGuardMode
  || props.selection.isReclaimMode
  || props.selection.isCaptureMode
  || props.selection.isResurrectMode
  || props.selection.isResurrectAreaMode
  || props.selection.isLoadTransportMode
  || props.selection.isUnloadTransportMode
  || props.selection.isManualLaunchMode
  || props.selection.isMexUpgradeMode
  || props.selection.isPingMode
  || props.selection.isTowerTargetMode
  || props.selection.isTowerTargetNoGroundMode,
);
type WaypointModeOption = {
  mode: WaypointType;
  label: string;
  commandId: CommandHotkeyId;
  key: string;
  color: string;
};

type BuildingGridOption = {
  buildingBlueprintId: StructureBlueprintId;
  label: string;
  key: string;
  cost: number;
  energyCost: number;
  metalCost: number;
  category: BuildMenuCategory;
  slotIndex: number;
  commandId: CommandHotkeyId;
  gridRow: number;
  gridColumn: number;
};

type FactoryGridOption = {
  unitBlueprintId: string;
  label: string;
  shortName: string;
  cost: number;
  energyCost: number;
  metalCost: number;
  locomotion: string;
};

function hotkey(commandId: CommandHotkeyId): string {
  void props.hotkeyRevision;
  return commandHotkeyLabel(commandId, props.hotkeyPreset);
}

function publicAssetSrc(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

function buildOptionBorderColor(category: BuildMenuCategory): string {
  return BUILD_MENU_CATEGORY_BORDER_COLORS[category];
}

type BarGroupIconId =
  | 'aa'
  | 'builder'
  | 'energy'
  | 'metal'
  | 'util'
  | 'weapon';

const BAR_GROUP_ICON_BY_STRUCTURE_BLUEPRINT_ID: Partial<Record<StructureBlueprintId, BarGroupIconId>> = {
  buildingExtractor: 'metal',
  buildingExtractorT2: 'metal',
  buildingResourceConverter: 'metal',
  buildingSolar: 'energy',
  buildingWind: 'energy',
  buildingRadar: 'util',
  buildingSonar: 'util',
  towerFabricator: 'builder',
  towerAntiAir: 'aa',
  towerBeamMega: 'weapon',
  towerCannon: 'weapon',
};

const BAR_GROUP_ICON_BY_UNIT_BLUEPRINT_ID: Readonly<Record<string, BarGroupIconId>> = {
  unitAlbatros: 'weapon',
  unitBadger: 'weapon',
  unitBee: 'util',
  unitConstructionDrone: 'builder',
  unitDaddy: 'weapon',
  unitDragonfly: 'weapon',
  unitEagle: 'aa',
  unitFormik: 'weapon',
  unitHippo: 'weapon',
  unitJackal: 'weapon',
  unitLoris: 'weapon',
  unitLynx: 'weapon',
  unitMammoth: 'weapon',
  unitMongoose: 'weapon',
  unitSeaTurtle: 'weapon',
  unitOrca: 'weapon',
  unitQueenBee: 'weapon',
  unitQueenTick: 'weapon',
  unitTarantula: 'weapon',
  unitTick: 'weapon',
  unitWidow: 'weapon',
};

function barGroupIconSrc(groupId: BarGroupIconId): string {
  return publicAssetSrc(`assets/bar/groupicons/${groupId}.png`);
}

function buildingGroupIconSrc(buildingBlueprintId: StructureBlueprintId): string | null {
  const groupId = BAR_GROUP_ICON_BY_STRUCTURE_BLUEPRINT_ID[buildingBlueprintId];
  return groupId === undefined ? null : barGroupIconSrc(groupId);
}

function unitGroupIconSrc(unitBlueprintId: string): string | null {
  const groupId = BAR_GROUP_ICON_BY_UNIT_BLUEPRINT_ID[unitBlueprintId];
  return groupId === undefined ? null : barGroupIconSrc(groupId);
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
  Sonar: 'Son',
  Converter: 'Conv',
  'Anti-Air Tower': 'AA',
};
function compactBuildingLabel(label: string): string {
  return COMPACT_BUILDING_LABELS[label] ?? label.slice(0, 5);
}

const BAR_ORDER_TOOLTIP_BY_COMMAND_ID: Partial<Record<CommandHotkeyId, string>> = {
  'waypoint.move': 'Move a unit towards a position or follow other units',
  'waypoint.patrol': 'Patrol along one or more waypoints',
  'waypoint.fight': 'Order units to take action while moving to a position',
  'combat.attack': 'Attack a unit or ground position',
  'combat.attackArea': 'Area attack everything within a circle (click-drag)',
  'combat.guard': 'Guard another unit against enemy units attacking it',
  'command.stop': 'Cancel the units current actions',
  'command.wait': 'Pause a unit/factory on processing command/build queues',
  'command.repeat': 'Repeat unit command queue',
  'command.moveState': 'Set how far out of its way a unit should move to attack enemies',
  'command.fireToggle': 'Set under what conditions a unit should start firing at enemies (without explicit attack order)',
  'command.cloak': 'Visibility state',
  'command.trajectoryToggle': 'Switch artillery firing angle between low, high and automatic trajectory',
  'command.dgun': 'Fire the powerful commander Disintegrator-gun',
  'combat.manualLaunch': 'Launch a missile at a target',
  'combat.repair': 'Repair a damaged unit',
  'combat.reclaim': 'Suck metal/energy from wrecks or features (trees/stones)',
  'combat.capture': 'Convert units that belong to the enemy (or ally)',
  'combat.resurrect': 'Revive wrecks to become units again (click-drag for area)',
  'command.areaMex': 'Click-drag an area to auto queue metal extractors for all available metal spots',
  'command.builderPriority': 'Assigns resources to use for this builder when not having enough for all',
  'command.carrierSpawn': 'Sets the spawning state of the carrier',
  'combat.loadTransport': 'Load unit or multiple units within an area in the transport',
  'combat.unloadTransport': 'Unload unit or multiple units within an area in the transport',
  'factory.stopProduction': 'Clear build queue and quotas for all units on selected factories',
  'command.factoryGuard': 'Builders produced by this factory will automatically guard it',
  'factory.airIdleState': 'Sets what aircraft do when leaving air factory',
  'factory.queueMode': 'Queue: Build each queued unit once\nQuota: Maintain a minimum quota of each unit on the battlefield',
  'combat.towerTargetSet': 'Set a prioritized target (prioritizes targeting when target in range) ',
  'combat.towerTargetClear': 'Removes the priority target',
  'command.morph': 'Upgrade to next Tech-level (second click to cancel)',
  'command.buildingActive': 'Active state: turn a unit on/off',
};

function actionTitle(label: string, commandId: CommandHotkeyId, detail?: string): string {
  const key = hotkey(commandId);
  const barTooltip = isBarHotkeyPreset.value ? BAR_ORDER_TOOLTIP_BY_COMMAND_ID[commandId] : undefined;
  if (barTooltip !== undefined) {
    const hotkeyText = key === '' ? '' : `${key.toUpperCase()} - `;
    return `${label} - ${hotkeyText}${barTooltip}`;
  }
  const hotkeyText = key === '' ? '' : ` - Hotkey ${key}`;
  return `${label}${hotkeyText}${detail === undefined ? '' : ` - ${detail}`}`;
}

function barOrderLabel(barLabel: string, prototypeLabel: string): string {
  return isBarHotkeyPreset.value ? barLabel : prototypeLabel;
}

function stateActionTitle(barLabel: string, prototypeLabel: string, commandId: CommandHotkeyId): string {
  return actionTitle(isBarHotkeyPreset.value ? barLabel : prototypeLabel, commandId);
}

function barStateButtonColor(prototypeColor: string): string {
  return isBarHotkeyPreset.value ? BUTTON_COLORS.default : prototypeColor;
}

function factoryStopProductionButtonColor(): string {
  return isBarHotkeyPreset.value ? BUTTON_COLORS.default : BUTTON_COLORS.stop;
}

function trajectoryModeLabel(mode: SelectionInfo['trajectoryMode']): string {
  if (isBarHotkeyPreset.value) {
    switch (mode) {
      case 'high': return 'High Trajectory';
      case 'low': return 'Low Trajectory';
      case 'auto': return visibleTrajectoryStateCount.value === 3 ? 'Auto Trajectory' : 'High Trajectory';
    }
  }
  return mode === 'high' ? 'Arc Hi' : mode === 'low' ? 'Arc Lo' : 'Arc Auto';
}

function moveStateLabel(moveState: SelectionInfo['unitMoveState']): string {
  switch (moveState) {
    case 'holdPosition': return isBarHotkeyPreset.value ? 'Hold pos' : 'Hold';
    case 'roam': return 'Roam';
    case 'mixed': return 'Mixed';
    case 'maneuver': return isBarHotkeyPreset.value ? 'Maneuver' : 'Move';
  }
}

function factoryAirIdleStateLabel(airIdleState: SelectionInfo['factoryAirIdleState']): string {
  return airIdleState === 'fly' ? 'Fly' : 'Land';
}

function nextFactoryAirIdleState(airIdleState: SelectionInfo['factoryAirIdleState']): UnitAirIdleState {
  return airIdleState === 'fly' ? 'land' : 'fly';
}

function nextMoveStateLabel(moveState: SelectionInfo['unitMoveState']): string {
  switch (moveState) {
    case 'holdPosition': return 'Roam';
    case 'roam': return 'Maneuver';
    case 'maneuver': return isBarHotkeyPreset.value ? 'Hold pos' : 'Hold';
    case 'mixed': return isBarHotkeyPreset.value ? 'Hold pos' : 'Hold';
  }
}

function previousMoveState(moveState: SelectionInfo['unitMoveState']): UnitMoveState {
  switch (moveState) {
    case 'holdPosition': return 'maneuver';
    case 'maneuver': return 'roam';
    case 'roam': return 'holdPosition';
    case 'mixed': return 'roam';
  }
}

function fireStateLabel(fireState: SelectionInfo['fireState']): string {
  switch (fireState) {
    case 'fireAtWill': return isBarHotkeyPreset.value ? 'Fire at will' : 'Fire';
    case 'returnFire': return isBarHotkeyPreset.value ? 'Return fire' : 'Return';
    case 'holdFire': return isBarHotkeyPreset.value ? 'Hold fire' : 'Hold';
    case 'defend': return 'Defend';
    case 'fireAtAll': return isBarHotkeyPreset.value ? 'Fire at all' : 'Fire all';
    case 'mixed': return 'Mixed';
  }
}

function nextFireStateLabel(fireState: SelectionInfo['fireState']): string {
  switch (fireState) {
    case 'fireAtWill': return isBarHotkeyPreset.value ? 'Return fire' : 'Return';
    case 'returnFire': return isBarHotkeyPreset.value ? 'Hold fire' : 'Hold';
    case 'holdFire': return isBarHotkeyPreset.value ? 'Fire at will' : 'Fire';
    case 'defend': return isBarHotkeyPreset.value ? 'Hold fire' : 'Hold';
    case 'fireAtAll': return isBarHotkeyPreset.value ? 'Hold fire' : 'Hold';
    case 'mixed': return isBarHotkeyPreset.value ? 'Fire at will' : 'Fire';
  }
}

function previousFireState(fireState: SelectionInfo['fireState']): CombatFireState {
  switch (fireState) {
    case 'fireAtWill': return 'holdFire';
    case 'holdFire': return 'returnFire';
    case 'returnFire': return 'fireAtWill';
    case 'defend': return 'fireAtWill';
    case 'fireAtAll': return 'fireAtWill';
    case 'mixed': return 'holdFire';
  }
}

function cloakStateLabel(selection: SelectionInfo): string {
  if (isBarHotkeyPreset.value) return selection.wantsCloak || selection.isCloaked ? 'Cloaked' : 'Visible';
  if (selection.isCloaked) return 'Cloaked';
  return selection.wantsCloak ? 'Cloaking' : 'Cloak';
}

function repeatStateLabel(active: boolean): string {
  return isBarHotkeyPreset.value ? (active ? 'Repeat On' : 'Repeat Off') : 'Repeat';
}

function builderPriorityLabel(lowPriority: boolean): string {
  return isBarHotkeyPreset.value
    ? lowPriority ? 'Low Priority' : 'High Priority'
    : lowPriority ? 'Low Prio' : 'High Prio';
}

function carrierSpawnLabel(enabled: boolean): string {
  return isBarHotkeyPreset.value
    ? enabled ? 'Spawning enabled' : 'Spawning disabled'
    : enabled ? 'Spawning Enabled' : 'Spawning Disabled';
}

function factoryQueueModeLabel(enabled: boolean): string {
  return isBarHotkeyPreset.value ? (enabled ? 'Quota Mode' : 'Queue Mode') : enabled ? 'Quota' : 'Queue';
}

function factoryGuardStateLabel(active: boolean): string {
  return isBarHotkeyPreset.value ? 'Factory Guard' : active ? 'Factory guard on' : 'Factory guard off';
}

function stopFactoryProductionLabel(): string {
  return isBarHotkeyPreset.value ? 'Clear Queue' : 'Stop Production';
}

type BarStateLightTone = 'off' | 'mid' | 'on';
type BarStateLight = {
  key: string;
  tone: BarStateLightTone;
  active: boolean;
};

const BINARY_STATE_LIGHT_TONES = ['off', 'on'] as const satisfies readonly BarStateLightTone[];
const THREE_STATE_LIGHT_TONES = ['off', 'mid', 'on'] as const satisfies readonly BarStateLightTone[];

function stateLights(
  activeIndex: number | null,
  tones: readonly BarStateLightTone[],
): BarStateLight[] {
  return tones.map((tone, index) => ({
    key: `${tone}-${index}`,
    tone,
    active: activeIndex === index,
  }));
}

function binaryStateLights(active: boolean): BarStateLight[] {
  return stateLights(active ? 1 : 0, BINARY_STATE_LIGHT_TONES);
}

function moveStateLights(moveState: SelectionInfo['unitMoveState']): BarStateLight[] {
  switch (moveState) {
    case 'holdPosition': return stateLights(0, THREE_STATE_LIGHT_TONES);
    case 'maneuver': return stateLights(1, THREE_STATE_LIGHT_TONES);
    case 'roam': return stateLights(2, THREE_STATE_LIGHT_TONES);
    case 'mixed': return stateLights(null, THREE_STATE_LIGHT_TONES);
  }
}

function fireStateLights(fireState: SelectionInfo['fireState']): BarStateLight[] {
  switch (fireState) {
    case 'holdFire': return stateLights(0, THREE_STATE_LIGHT_TONES);
    case 'returnFire': return stateLights(1, THREE_STATE_LIGHT_TONES);
    case 'fireAtWill': return stateLights(2, THREE_STATE_LIGHT_TONES);
    case 'defend': return stateLights(1, THREE_STATE_LIGHT_TONES);
    case 'fireAtAll': return THREE_STATE_LIGHT_TONES.map((tone, index) => ({
      key: String(index),
      active: true,
      tone,
    }));
    case 'mixed': return stateLights(null, THREE_STATE_LIGHT_TONES);
  }
}

function trajectoryStateLights(mode: SelectionInfo['trajectoryMode']): BarStateLight[] {
  if (isBarHotkeyPreset.value) {
    if (visibleTrajectoryStateCount.value === 3) {
      switch (mode) {
        case 'low': return stateLights(0, THREE_STATE_LIGHT_TONES);
        case 'high': return stateLights(1, THREE_STATE_LIGHT_TONES);
        case 'auto': return stateLights(2, THREE_STATE_LIGHT_TONES);
      }
    }
    return stateLights(mode === 'low' ? 0 : 1, BINARY_STATE_LIGHT_TONES);
  }
  switch (mode) {
    case 'low': return stateLights(0, THREE_STATE_LIGHT_TONES);
    case 'auto': return stateLights(1, THREE_STATE_LIGHT_TONES);
    case 'high': return stateLights(2, THREE_STATE_LIGHT_TONES);
  }
}

function queueInsertOptionTitle(option: QueueInsertOption): string {
  return option.label === 'End'
    ? 'Insert queued commands at the end'
    : `Insert queued commands after order ${option.label.replace('+', '')}`;
}

function formatCostPart(cost: number): string {
  const rounded = Math.round(cost);
  if (rounded < 1000) return String(rounded);
  const leading = Math.floor(rounded / 1000);
  const remainder = String(rounded % 1000).padStart(3, '0');
  return `${leading} ${remainder}`;
}

function costTitle(
  label: string,
  cost: number,
  key?: string,
  metalCost?: number,
  energyCost?: number,
): string {
  const hotkey = key === undefined ? '' : ` - Hotkey ${key}`;
  const resourceBreakdown = metalCost === undefined || energyCost === undefined
    ? ''
    : ` (${formatCostPart(metalCost)}M / ${formatCostPart(energyCost)}E)`;
  return `${label}${hotkey} - Cost ${formatCostPart(cost)}${resourceBreakdown}`;
}

function factoryProductionCellTitle(option: FactoryGridOption): string {
  const modeLabel = props.selection.factoryQueueMode
    ? 'Quota'
    : props.selection.factoryRepeatsProduction === true
      ? 'Repeat'
      : 'Queue';
  const queueModeKey = hotkey('factory.queueMode');
  const queueModeHint = queueModeKey === '' ? '' : `; ${queueModeKey} toggles quota mode`;
  return costTitle(
    `${modeLabel} ${option.label}; T toggles repeat${queueModeHint}; Shift adds five; Ctrl adds twenty; Shift+Ctrl adds one hundred; right-click removes queued/quota with the same multipliers`,
    option.cost,
    undefined,
    option.metalCost,
    option.energyCost,
  );
}

function barBuildCategoryTitle(category: (typeof BAR_BUILD_CATEGORIES)[number]): string {
  const key = hotkey(category.keyCommandId);
  return key === ''
    ? category.description
    : `${category.description} - Hotkey: [${key}]`;
}

const buildingMenuLayout = computed(() =>
  buildStructureMenuLayout(props.selection.allowedBuildBlueprintIds),
);

function buildingOptionForLayoutItem(item: BuildMenuLayoutItem): BuildingGridOption | null {
  const { buildingBlueprintId, commandId } = item;
  const option = structureRosterDisplay.find((entry) => entry.buildingBlueprintId === buildingBlueprintId);
  return option === undefined
    ? null
    : {
      ...option,
      buildingBlueprintId: option.buildingBlueprintId as StructureBlueprintId,
      key: hotkey(commandId),
      commandId,
      slotIndex: item.slotIndex,
      gridRow: item.gridRow,
      gridColumn: item.gridColumn,
    };
}

const buildingOptions = computed(() =>
  buildingMenuLayout.value.items
    .map(buildingOptionForLayoutItem)
    .filter((option) => option !== null),
);
const barClassicBuildOptions = computed(() =>
  buildBarClassicBuildMenuItems(props.selection.allowedBuildBlueprintIds)
    .map(buildingOptionForLayoutItem)
    .filter((option) => option !== null),
);
const buildLineSpacingLabel = computed(() =>
  `${Math.round(props.selection.buildLineSpacingMultiplier * 100)}%`,
);
const buildFacingLabel = computed(() => `${props.selection.buildFacingDegrees}deg`);
const barGridNextPageHotkey = computed(() =>
  isBarGridCommandHotkeyPreset(props.hotkeyPreset) ? 'B' : '',
);
const barGridCycleBuilderHotkey = computed(() =>
  isBarGridCommandHotkeyPreset(props.hotkeyPreset) ? '.' : '',
);
const barGridCycleBuilderTitle = computed(() => 'Next Builder');
const unitOptions = computed<FactoryGridOption[]>(() => {
  return unitOptionsForBlueprintIds(props.selection.factoryAllowedUnitBlueprintIds);
});
const factoryDisplayUnitBlueprintIds = computed(() =>
  buildFactoryUnitBlueprintIdsForPreset(
    props.selection.factoryAllowedUnitBlueprintIds,
    props.hotkeyPreset,
  ),
);
const factoryGridUnitBlueprintCells = computed(() =>
  buildFactoryUnitGridCellsForPreset(
    props.selection.factoryAllowedUnitBlueprintIds,
    props.hotkeyPreset,
  ),
);

function unitOptionsForBlueprintIds(unitBlueprintIds: readonly string[]): FactoryGridOption[] {
  const options: FactoryGridOption[] = [];
  for (const unitBlueprintId of unitBlueprintIds) {
    const option = getUnitRosterDisplay(unitBlueprintId);
    if (option !== null) options.push(option);
  }
  return options;
}
const factoryDisplayUnitSet = computed(() => new Set(factoryDisplayUnitBlueprintIds.value));

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
  !showBarGridBuildCategories.value || props.selection.buildGridCategory === null
    ? null
    : BAR_BUILD_CATEGORIES.find((category) => category.id === props.selection.buildGridCategory) ?? null,
);

const currentBuildCategoryOptions = computed(() => {
  const category = currentBuildCategory.value;
  return category === null ? [] : buildOptionsByBarCategory.value.get(category.id) ?? [];
});

const buildGridPageCount = computed(() =>
  showBarClassicBuildMenu.value
    ? Math.max(1, Math.ceil(barClassicBuildOptions.value.length / BAR_GRID_SLOT_COUNT))
    : Math.max(1, Math.ceil(currentBuildCategoryOptions.value.length / BAR_GRID_SLOT_COUNT)),
);

const buildGridPage = computed(() =>
  normalizeGridPageIndex(props.selection.buildGridPage, buildGridPageCount.value),
);

const buildGridCells = computed<(BuildingGridOption | null)[]>(() => {
  if (showBarClassicBuildMenu.value) {
    const start = buildGridPage.value * BAR_GRID_SLOT_COUNT;
    return gridCells(barClassicBuildOptions.value.slice(start, start + BAR_GRID_SLOT_COUNT));
  }

  if (currentBuildCategory.value !== null) {
    const start = buildGridPage.value * BAR_GRID_SLOT_COUNT;
    return gridCellsBySlotIndex(currentBuildCategoryOptions.value.slice(start, start + BAR_GRID_SLOT_COUNT));
  }

  return buildBarHomeBuildMenuCells(props.selection.allowedBuildBlueprintIds)
    .map((item) => item === null ? null : buildingOptionForLayoutItem(item));
});

const showBuildGridPager = computed(() =>
  (showBarClassicBuildMenu.value || currentBuildCategory.value !== null) &&
  buildGridPageCount.value > 1,
);
const showBuildGridFooter = computed(() =>
  showBarGridBuildCategories.value || showBuildGridPager.value,
);

const showBuilderTypeStrip = computed(() =>
  props.selection.selectedBuilderTypes.length > 1,
);
const showBuilderCycleButton = computed(() => isBarGridCommandHotkeyPreset(props.hotkeyPreset));

function setActiveBuilder(unitBlueprintId: string): void {
  props.actions.setActiveBuilder(unitBlueprintId);
}

function cycleActiveBuilder(): void {
  props.actions.cycleActiveBuilder();
}

function factoryGridCellHotkey(index: number): string {
  const commandId = BUILD_MENU_GRID_SLOT_COMMAND_IDS[index];
  return commandId === undefined ? '' : hotkey(commandId);
}

function buildGridCellHotkey(option: BuildingGridOption): string {
  return showBarGridBuildCategories.value && currentBuildCategory.value === null
    ? ''
    : option.key;
}

const factoryGridPageCount = computed(() =>
  Math.max(1, Math.ceil(factoryGridUnitBlueprintCells.value.length / BAR_GRID_SLOT_COUNT)),
);

const factoryGridPage = computed(() =>
  normalizeGridPageIndex(props.selection.factoryGridPage, factoryGridPageCount.value),
);

const factoryGridCells = computed<(FactoryGridOption | null)[]>(() => {
  const start = factoryGridPage.value * BAR_GRID_SLOT_COUNT;
  return factoryGridUnitBlueprintCells.value
    .slice(start, start + BAR_GRID_SLOT_COUNT)
    .map((unitBlueprintId) =>
      unitBlueprintId === null ? null : getUnitRosterDisplay(unitBlueprintId),
    );
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

function gridCellsBySlotIndex<T extends { slotIndex: number }>(items: readonly T[]): (T | null)[] {
  const cells = emptyGridCells<T>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.slotIndex < 0 || item.slotIndex >= cells.length) continue;
    cells[item.slotIndex] = item;
  }
  return cells;
}

function normalizeGridPageIndex(pageIndex: number, pageCount: number): number {
  const count = Math.max(1, Math.floor(pageCount));
  const index = Math.floor(pageIndex);
  return ((index % count) + count) % count;
}

function selectBuildGridCategory(categoryId: BarBuildCategoryId): void {
  props.actions.setBuildGridCategory(props.selection.buildGridCategory === categoryId ? null : categoryId);
}

function clearBuildGridCategory(): void {
  props.actions.setBuildGridCategory(null);
}

function stepBuildGridPage(delta: number): void {
  props.actions.stepBuildGridPage(delta);
}

function stepFactoryGridPage(delta: number): void {
  props.actions.stepFactoryGridPage(delta);
}

function clickBuildGridOption(buildingBlueprintId: StructureBlueprintId): void {
  if (
    !isBarHotkeyPreset.value &&
    props.selection.isBuildMode &&
    props.selection.selectedBuildingBlueprintId === buildingBlueprintId
  ) {
    props.actions.cancelBuild();
    return;
  }
  props.actions.startBuild(buildingBlueprintId);
}

function startAreaMexBuild(): void {
  props.actions.startBuild(AREA_MEX_BLUEPRINT_ID);
}

function buildGridCellKey(option: BuildingGridOption | null, index: number): string {
  return option === null ? `empty-build-${index}` : option.buildingBlueprintId;
}

function factoryGridCellKey(option: FactoryGridOption | null, index: number): string {
  return option === null ? `empty-factory-${index}` : option.unitBlueprintId;
}

function factoryQueuedCount(unitBlueprintId: string): number {
  return factoryQueuedCountByUnitBlueprintId.value.get(unitBlueprintId) ?? 0;
}

function factoryQuotaTarget(unitBlueprintId: string): number {
  return factoryQuotaByUnitBlueprintId.value.get(unitBlueprintId)?.quota ?? 0;
}

function factoryQuotaLabel(unitBlueprintId: string): string {
  const quota = factoryQuotaByUnitBlueprintId.value.get(unitBlueprintId);
  return quota === undefined ? '' : `${quota.current}/${quota.quota}`;
}

const FACTORY_PRESET_LOAD_COMMAND_IDS = [
  'factoryPreset.load1',
  'factoryPreset.load2',
  'factoryPreset.load3',
  'factoryPreset.load4',
  'factoryPreset.load5',
  'factoryPreset.load6',
  'factoryPreset.load7',
  'factoryPreset.load8',
  'factoryPreset.load9',
  'factoryPreset.load10',
] as const satisfies readonly CommandHotkeyId[];
const FACTORY_PRESET_SAVE_COMMAND_IDS = [
  'factoryPreset.save1',
  'factoryPreset.save2',
  'factoryPreset.save3',
  'factoryPreset.save4',
  'factoryPreset.save5',
  'factoryPreset.save6',
  'factoryPreset.save7',
  'factoryPreset.save8',
  'factoryPreset.save9',
  'factoryPreset.save10',
] as const satisfies readonly CommandHotkeyId[];

const factoryPresetSlots = ref<(FactoryProductionPresetSnapshot | null)[]>(loadFactoryProductionPresetSlots());
const FACTORY_PRESET_OVERLAY_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0] as const;
const FACTORY_PRESET_OVERLAY_MAX_RUNS = 7;

type FactoryPresetOverlayEntry = {
  index: number;
  label: string;
  snapshot: FactoryProductionPresetSnapshot;
  unitBlueprintIds: string[];
  canLoad: boolean;
};

type FactoryPresetOverlayRun = {
  unitBlueprintId: string;
  shortName: string;
  count: number;
};

const showBarFactoryPresetOverlay = computed(() =>
  hasBarFactoryPresetHotkeys(props.hotkeyPreset) &&
  props.selection.factoryPresetOverlayVisible &&
  props.selection.hasFactory &&
  props.selection.factoryId !== undefined &&
  showBuildingActions.value,
);
const barFactoryPresetTitle = computed(() =>
  props.selection.details.find((detail) => detail.label === 'Name')?.value ?? 'Factory',
);

const factoryPresetOverlayEntries = computed<FactoryPresetOverlayEntry[]>(() => {
  const entries: FactoryPresetOverlayEntry[] = [];
  for (const index of FACTORY_PRESET_OVERLAY_ORDER) {
    const snapshot = factoryPresetSlots.value[index] ?? null;
    if (snapshot === null) continue;
    entries.push({
      index,
      label: String(index),
      snapshot,
      unitBlueprintIds: getFactoryProductionPresetUnitBlueprintIds(snapshot),
      canLoad: resolveFactoryProductionPresetReplay(snapshot, factoryDisplayUnitSet.value) !== null,
    });
  }
  return entries;
});

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
  void buildingBlueprintId;
  return 'building';
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

function selectedEntityPreviewKind(): LoadingPreviewKind | null {
  const info = props.selection.selectedEntityInfo;
  if (info === null || info.blueprintKind === null || info.blueprintId === null) return null;
  return info.blueprintKind;
}

function selectedEntityImageSrc(): string | null {
  thumbnailRevision.value;
  const info = props.selection.selectedEntityInfo;
  const kind = selectedEntityPreviewKind();
  if (info === null || kind === null || info.blueprintId === null) return null;
  return getCachedEntityPreviewImage('panel', kind, info.blueprintId as LoadingEntityBlueprintId);
}

const selectedEntityDetailRows = computed(() =>
  props.selection.details
    .filter((detail) => detail.label !== 'Name' && detail.label !== 'HP')
    .slice(0, 8),
);

const selectedEntityHealthLabel = computed(() => {
  const info = props.selection.selectedEntityInfo;
  if (info === null || info.hp === null || info.maxHp === null || info.maxHp <= 0) return '';
  return `${formatCostPart(info.hp)}/${formatCostPart(info.maxHp)}`;
});

const selectedEntityHealthStyle = computed(() => {
  const info = props.selection.selectedEntityInfo;
  if (info === null || info.hp === null || info.maxHp === null || info.maxHp <= 0) {
    return { width: '0%' };
  }
  const fraction = Math.max(0, Math.min(1, info.hp / info.maxHp));
  return { width: `${(fraction * 100).toFixed(2)}%` };
});

const selectedEntityBuildProgressStyle = computed(() => {
  const progress = props.selection.selectedEntityInfo?.buildProgress;
  if (progress === null || progress === undefined || progress >= 1) return null;
  const fraction = Math.max(0, Math.min(1, progress));
  return { width: `${(fraction * 100).toFixed(2)}%` };
});

function prefetchBuildButtonThumbnails(): void {
  if (props.selection.hasBuilder && showUnitActions.value) {
    for (const option of buildingOptions.value) {
      const blueprintId = option.buildingBlueprintId as StructureBlueprintId;
      void requestEntityThumbnail(structurePreviewKind(blueprintId), blueprintId);
    }
    for (const builderType of props.selection.selectedBuilderTypes) {
      void requestEntityThumbnail('unit', builderType.unitBlueprintId as LoadingEntityBlueprintId);
    }
  }

  if (props.selection.hasFactory && showBuildingActions.value) {
    for (const option of unitOptions.value) {
      void requestEntityThumbnail('unit', option.unitBlueprintId as LoadingEntityBlueprintId);
    }
  }

  const selectedInfo = props.selection.selectedEntityInfo;
  const selectedKind = selectedEntityPreviewKind();
  if (selectedInfo !== null && selectedKind !== null && selectedInfo.blueprintId !== null) {
    void requestEntityPreviewImage(
      'panel',
      selectedKind,
      selectedInfo.blueprintId as LoadingEntityBlueprintId,
    );
  }
}

watch(
  () => [
    props.selection.hasBuilder,
    showUnitActions.value,
    buildingOptions.value.map((option) => option.buildingBlueprintId).join('|'),
    props.selection.selectedBuilderTypes.map((builderType) => builderType.unitBlueprintId).join('|'),
    props.selection.hasFactory,
    showBuildingActions.value,
    unitOptions.value.map((option) => option.unitBlueprintId).join('|'),
    props.selection.selectedEntityInfo?.blueprintKind ?? '',
    props.selection.selectedEntityInfo?.blueprintId ?? '',
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

function factoryPresetLoadCommandId(index: number): CommandHotkeyId {
  return FACTORY_PRESET_LOAD_COMMAND_IDS[index] ?? 'factoryPreset.load1';
}

function factoryPresetSaveCommandId(index: number): CommandHotkeyId {
  return FACTORY_PRESET_SAVE_COMMAND_IDS[index] ?? 'factoryPreset.save1';
}

function unitShortName(unitBlueprintId: string | null): string {
  if (unitBlueprintId === null) return '-';
  return unitOptions.value.find((unit) => unit.unitBlueprintId === unitBlueprintId)?.shortName
    ?? unitBlueprintId.slice(0, 3).toUpperCase();
}

function unitFullName(unitBlueprintId: string): string {
  return unitOptions.value.find((unit) => unit.unitBlueprintId === unitBlueprintId)?.label
    ?? unitBlueprintId;
}

function factoryPresetShortName(snapshot: FactoryProductionPresetSnapshot | null): string {
  const unitIds = getFactoryProductionPresetUnitBlueprintIds(snapshot);
  if (unitIds.length === 0) return '-';
  const suffix = unitIds.length > 1 ? `+${unitIds.length - 1}` : '';
  return `${unitShortName(unitIds[0])}${suffix}`;
}

function factoryPresetOverlayRuns(entry: FactoryPresetOverlayEntry): FactoryPresetOverlayRun[] {
  const runs: FactoryPresetOverlayRun[] = [];
  const counts = new Map<string, number>();
  for (const unitBlueprintId of entry.unitBlueprintIds) {
    counts.set(unitBlueprintId, (counts.get(unitBlueprintId) ?? 0) + 1);
  }
  for (const [unitBlueprintId, count] of counts) {
    runs.push({
      unitBlueprintId,
      shortName: unitShortName(unitBlueprintId),
      count,
    });
    if (runs.length >= FACTORY_PRESET_OVERLAY_MAX_RUNS) break;
  }
  return runs;
}

function factoryPresetOverlayOverflow(entry: FactoryPresetOverlayEntry): number {
  const shown = factoryPresetOverlayRuns(entry).reduce((sum, run) => sum + run.count, 0);
  return Math.max(0, entry.unitBlueprintIds.length - shown);
}

function factoryPresetMatchesCurrent(snapshot: FactoryProductionPresetSnapshot | null): boolean {
  if (snapshot === null) return false;
  if (snapshot.selectedUnitBlueprintId !== selectedBuildUnitBlueprintId.value) return false;
  if (snapshot.repeatProduction !== (props.selection.factoryRepeatsProduction === true)) return false;
  if (snapshot.productionQueue.length !== factoryQueuedUnits.value.length) return false;
  for (let i = 0; i < snapshot.productionQueue.length; i++) {
    if (snapshot.productionQueue[i] !== factoryQueuedUnits.value[i].unitBlueprintId) return false;
  }
  return true;
}

function factoryPresetTitle(index: number): string {
  const snapshot = factoryPresetSlots.value[index] ?? null;
  const unitIds = getFactoryProductionPresetUnitBlueprintIds(snapshot);
  const label = snapshot === null || unitIds.length === 0
    ? 'empty'
    : `${snapshot.repeatProduction ? 'Repeat' : 'Queue'} ${unitIds.map(unitFullName).join(' -> ')}`;
  return `Factory preset ${index}: ${label}`;
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

function canLoadFactoryPreset(index: number): boolean {
  const snapshot = factoryPresetSlots.value[index] ?? null;
  return resolveFactoryProductionPresetReplay(snapshot, factoryDisplayUnitSet.value) !== null;
}

function saveFactoryPreset(index: number): void {
  if (index < 0 || index >= FACTORY_PRODUCTION_PRESET_COUNT) return;
  setFactoryProductionPresetSlot(index, createFactoryProductionPresetSnapshot(
    selectedBuildUnitBlueprintId.value,
    props.selection.factoryRepeatsProduction,
    factoryQueuedUnits.value.map((unit) => unit.unitBlueprintId),
  ));
  refreshFactoryPresetSlots();
}

function loadFactoryPreset(index: number): void {
  if (index < 0 || index >= FACTORY_PRODUCTION_PRESET_COUNT) return;
  const factoryId = props.selection.factoryId;
  if (factoryId === undefined) return;
  const snapshot = getFactoryProductionPresetSlot(index);
  const replay = resolveFactoryProductionPresetReplay(snapshot, factoryDisplayUnitSet.value);
  if (replay === null) return;
  props.actions.stopFactoryProduction(factoryId);
  props.actions.queueUnit(
    factoryId,
    replay.selectedUnitBlueprintId,
    replay.repeatProduction,
  );
  for (let i = 0; i < replay.productionQueue.length; i++) {
    props.actions.queueUnit(factoryId, replay.productionQueue[i], false);
  }
}

function toggleWaitFromClick(event: MouseEvent): void {
  const queueMode = queueModeFromEvent(event, props.selection.queueInsertIndex);
  props.actions.toggleSelectedWait(queueMode.queue, queueMode.queueFront, queueMode.queueInsertIndex);
}

function toggleGatherWaitFromClick(event: MouseEvent): void {
  const queueMode = queueModeFromEvent(event, props.selection.queueInsertIndex);
  props.actions.toggleSelectedGatherWait(queueMode.queue, queueMode.queueFront, queueMode.queueInsertIndex);
}

function reverseUnitMoveStateFromClick(): void {
  props.actions.setUnitMoveState(previousMoveState(props.selection.unitMoveState));
}

function reverseFireStateFromClick(): void {
  props.actions.setSelectedFireState(previousFireState(props.selection.fireState));
}

function queueFactoryUnitFromClick(factoryId: number, unitBlueprintId: string, event: MouseEvent): void {
  const productionMode = factoryProductionClickModeFromEvent(
    event,
    props.selection.factoryRepeatsProduction === true,
  );
  if (props.selection.factoryQueueMode && !productionMode.front) {
    props.actions.changeFactoryUnitQuota(factoryId, unitBlueprintId, productionMode.count);
    return;
  }
  const queueLengthBeforeAdd = factoryQueuedUnits.value.length;
  props.actions.queueUnit(factoryId, unitBlueprintId, productionMode.repeat, productionMode.count);
  // BAR gui_gridmenu.lua: Alt-queued clicks insert at the FRONT of the build
  // queue. queueUnit appends, so compose the insert client-side by moving the
  // appended run to index 0 (server-authorized editFactoryQueue move).
  if (productionMode.front && !productionMode.repeat && queueLengthBeforeAdd > 0) {
    props.actions.editFactoryQueue(factoryId, 'move', queueLengthBeforeAdd, productionMode.count, 0);
  }
}

function removeFactoryQueuedUnitFromCell(factoryId: number, unitBlueprintId: string, event: MouseEvent): void {
  const productionMode = factoryProductionClickModeFromEvent(event, false);
  const quotaDelta = -productionMode.count;
  if (props.selection.factoryQueueMode && !productionMode.front && factoryQuotaTarget(unitBlueprintId) > 0) {
    props.actions.changeFactoryUnitQuota(factoryId, unitBlueprintId, quotaDelta);
    return;
  }
  if (factoryQueuedCount(unitBlueprintId) > 0) {
    props.actions.removeFactoryUnitProduction(factoryId, unitBlueprintId, productionMode.count);
    return;
  }
  if (factoryQuotaTarget(unitBlueprintId) > 0) {
    props.actions.changeFactoryUnitQuota(factoryId, unitBlueprintId, quotaDelta);
  }
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
  <div
    v-if="showPanel"
    class="options-panel"
    :class="{ 'bar-hotkey-preset': isBarHotkeyPreset }"
    :style="selectionPanelStyle"
  >
    <!-- Selection header. The header reflects the host kind and mounted
         capability: commanders read as Commander, factory buildings as
         Fabricator, other static hosts as Building, otherwise N units. -->
    <div v-if="showPrototypeOnlyCommandButtons" class="panel-header">
      <div class="selection-title">
        <span v-if="selection.hasCommander" class="unit-type commander">Commander</span>
        <span v-else-if="selection.hasFactory" class="unit-type factory">Fabricator</span>
        <span v-else-if="selection.buildingCount > 0 && selection.unitCount === 0" class="unit-type">
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

    <div v-if="selection.controlGroups.length > 0 && showPrototypeOnlyCommandButtons" class="control-group-strip" aria-label="Control groups">
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

    <div
      v-if="selection.selectedEntityInfo !== null"
      class="selection-info-panel"
      aria-label="Selected entity information"
    >
      <div class="selection-info-portrait" aria-hidden="true">
        <img
          v-if="selectedEntityImageSrc()"
          class="selection-info-image"
          :src="selectedEntityImageSrc()!"
          alt=""
        >
        <div v-else class="selection-info-fallback">
          {{ selection.selectedEntityInfo.label.slice(0, 3).toUpperCase() }}
        </div>
      </div>
      <div class="selection-info-main">
        <div class="selection-info-title-row">
          <div class="selection-info-title">{{ selection.selectedEntityInfo.label }}</div>
          <div v-if="selection.selectedEntityInfo.count > 1" class="selection-info-count">
            x{{ selection.selectedEntityInfo.count }}
          </div>
        </div>
        <div class="selection-info-subtitle">{{ selection.selectedEntityInfo.subtitle }}</div>
        <div
          v-if="selectedEntityHealthLabel"
          class="selection-info-meter health"
          aria-hidden="true"
        >
          <div class="selection-info-meter-fill" :style="selectedEntityHealthStyle"></div>
          <span>{{ selectedEntityHealthLabel }}</span>
        </div>
        <div
          v-if="selectedEntityBuildProgressStyle"
          class="selection-info-meter build"
          aria-hidden="true"
        >
          <div class="selection-info-meter-fill" :style="selectedEntityBuildProgressStyle"></div>
          <span>Build</span>
        </div>
        <div class="selection-info-details">
          <div
            v-for="detail in selectedEntityDetailRows"
            :key="detail.label"
            class="selection-info-detail"
          >
            <span>{{ detail.label }}</span>
            <strong>{{ detail.value }}</strong>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showPrototypeOnlyCommandButtons" class="button-group selection-command-group">
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
        <template v-if="isBarHotkeyPreset">
          <button
            type="button"
            class="action-btn bar-order-state"
            :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
            :title="actionTitle(repeatStateLabel(selection.isRepeatQueue), 'command.repeat')"
            @click="actions.toggleRepeatQueue()"
          >
            <span class="btn-label">{{ repeatStateLabel(selection.isRepeatQueue) }}</span>
            <span class="btn-key">{{ hotkey('command.repeat') }}</span>
            <span class="bar-state-lights" aria-hidden="true">
              <span
                v-for="light in binaryStateLights(selection.isRepeatQueue)"
                :key="light.key"
                class="bar-state-light"
                :class="[light.tone, { active: light.active }]"
              ></span>
            </span>
          </button>
          <button
            v-if="selection.hasMoveStateControl"
            type="button"
            class="action-btn bar-order-state"
            :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
            :title="stateActionTitle(moveStateLabel(selection.unitMoveState), `Move state: ${moveStateLabel(selection.unitMoveState)}; next ${nextMoveStateLabel(selection.unitMoveState)}`, 'command.moveState')"
            @click="actions.toggleUnitMoveState()"
            @contextmenu.prevent="reverseUnitMoveStateFromClick"
          >
            <span class="btn-label">{{ moveStateLabel(selection.unitMoveState) }}</span>
            <span class="btn-key">{{ hotkey('command.moveState') }}</span>
            <span class="bar-state-lights" aria-hidden="true">
              <span
                v-for="light in moveStateLights(selection.unitMoveState)"
                :key="light.key"
                class="bar-state-light"
                :class="[light.tone, { active: light.active }]"
              ></span>
            </span>
          </button>
          <button
            v-if="selection.hasCloakControl"
            type="button"
            class="action-btn bar-order-state"
            :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
            :title="stateActionTitle(cloakStateLabel(selection), selection.wantsCloak ? 'Disable cloak' : 'Enable cloak', 'command.cloak')"
            @click="actions.toggleCloakState()"
          >
            <span class="btn-label">{{ cloakStateLabel(selection) }}</span>
            <span class="btn-key">{{ hotkey('command.cloak') }}</span>
            <span class="bar-state-lights" aria-hidden="true">
              <span
                v-for="light in binaryStateLights(selection.wantsCloak || selection.isCloaked)"
                :key="light.key"
                class="bar-state-light"
                :class="[light.tone, { active: light.active }]"
              ></span>
            </span>
          </button>
          <button
            v-if="showCombatActions"
            type="button"
            class="action-btn bar-order-state"
            :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.fireControl) }"
            :title="stateActionTitle(fireStateLabel(selection.fireState), `Fire state: ${fireStateLabel(selection.fireState)}; next ${nextFireStateLabel(selection.fireState)}`, 'command.fireToggle')"
            @click="actions.toggleSelectedFire()"
            @contextmenu.prevent="reverseFireStateFromClick"
          >
            <span class="btn-label">{{ fireStateLabel(selection.fireState) }}</span>
            <span class="btn-key">{{ hotkey('command.fireToggle') }}</span>
            <span class="bar-state-lights" aria-hidden="true">
              <span
                v-for="light in fireStateLights(selection.fireState)"
                :key="light.key"
                class="bar-state-light"
                :class="[light.tone, { active: light.active }]"
              ></span>
            </span>
          </button>
          <button
            v-if="showTrajectoryButton"
            type="button"
            class="action-btn bar-order-state"
            :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.fireControl) }"
            :title="actionTitle(trajectoryModeLabel(visibleTrajectoryMode), 'command.trajectoryToggle')"
            @click="actions.toggleTrajectoryMode()"
          >
            <span class="btn-label">{{ trajectoryModeLabel(visibleTrajectoryMode) }}</span>
            <span class="btn-key">{{ hotkey('command.trajectoryToggle') }}</span>
            <span class="bar-state-lights" aria-hidden="true">
              <span
                v-for="light in trajectoryStateLights(visibleTrajectoryMode)"
                :key="light.key"
                class="bar-state-light"
                :class="[light.tone, { active: light.active }]"
              ></span>
            </span>
          </button>
          <button
            v-if="showBuilderPriorityButton"
            type="button"
            class="action-btn bar-order-state"
            :class="{ active: selection.builderPriorityLow }"
            :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
            :title="actionTitle(builderPriorityLabel(selection.builderPriorityLow), 'command.builderPriority', 'Assigns resources to use for this builder when not having enough for all')"
            @click="actions.toggleBuilderPriority()"
          >
            <span class="btn-label">{{ builderPriorityLabel(selection.builderPriorityLow) }}</span>
            <span class="btn-key">{{ hotkey('command.builderPriority') }}</span>
            <span class="bar-state-lights" aria-hidden="true">
              <span
                v-for="light in binaryStateLights(selection.builderPriorityLow)"
                :key="light.key"
                class="bar-state-light"
                :class="[light.tone, { active: light.active }]"
              ></span>
            </span>
          </button>
          <button
            v-if="showCarrierSpawnButton"
            type="button"
            class="action-btn bar-order-state"
            :class="{ active: selection.carrierSpawnEnabled }"
            :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
            :title="actionTitle(carrierSpawnLabel(selection.carrierSpawnEnabled), 'command.carrierSpawn', 'Enable/Disable drone spawning')"
            @click="actions.toggleCarrierSpawn()"
          >
            <span class="btn-label">{{ carrierSpawnLabel(selection.carrierSpawnEnabled) }}</span>
            <span class="btn-key">{{ hotkey('command.carrierSpawn') }}</span>
            <span class="bar-state-lights" aria-hidden="true">
              <span
                v-for="light in binaryStateLights(selection.carrierSpawnEnabled)"
                :key="light.key"
                class="bar-state-light"
                :class="[light.tone, { active: light.active }]"
              ></span>
            </span>
          </button>
          <button
            type="button"
            class="action-btn bar-order-wait"
            :style="{ '--btn-color': BUTTON_COLORS.wait }"
            :title="actionTitle('Wait', 'command.wait', 'Shift-click queues; Ctrl/Cmd+Shift-click inserts next')"
            @click="toggleWaitFromClick"
          >
            <span class="btn-label">Wait</span>
            <span class="btn-key">{{ hotkey('command.wait') }}</span>
            <span class="bar-state-lights" aria-hidden="true">
              <span
                v-for="light in binaryStateLights(selection.isWaiting)"
                :key="light.key"
                class="bar-state-light"
                :class="[light.tone, { active: light.active }]"
              ></span>
            </span>
          </button>
        </template>
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
          v-if="showFormationCommands"
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
          v-if="showFormationCommands"
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
          v-if="showAttackCommand"
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
          v-if="showAttackLineCommand"
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
          v-if="showAttackAreaCommand"
          type="button"
          class="action-btn"
          :class="{ active: selection.isAttackAreaMode }"
          :style="{ '--btn-color': BUTTON_COLORS.attackGround }"
          :title="actionTitle(barOrderLabel('Area Attack', 'Area attack'), 'combat.attackArea', 'Toggle targeting for selected units')"
          @click="actions.toggleAttackArea()"
        >
          <span class="btn-label">{{ barOrderLabel('Area Attack', 'Area') }}</span>
          <span class="btn-key">{{ hotkey('combat.attackArea') }}</span>
        </button>
        <button
          v-if="showAttackGroundCommand"
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
          v-if="showPrototypeOnlyCommandButtons"
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
          v-if="!isBarHotkeyPreset"
          type="button"
          class="action-btn bar-order-wait"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          :title="actionTitle('Wait', 'command.wait', 'Shift-click queues; Ctrl/Cmd+Shift-click inserts next')"
          @click="toggleWaitFromClick"
        >
          <span class="btn-label">Wait</span>
          <span class="btn-key">{{ hotkey('command.wait') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selection.isWaiting)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="showGatherWaitButton"
          type="button"
          class="action-btn bar-order-wait"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          :title="actionTitle('Gather Wait', 'command.gatherWait', 'Shift-click queues; Ctrl/Cmd+Shift-click inserts next')"
          @click="toggleGatherWaitFromClick"
        >
          <span class="btn-label">Gather</span>
          <span class="btn-key">{{ hotkey('command.gatherWait') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selection.isGatherWaiting)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="!isBarHotkeyPreset"
          type="button"
          class="action-btn bar-order-state"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
          :title="actionTitle(repeatStateLabel(selection.isRepeatQueue), 'command.repeat')"
          @click="actions.toggleRepeatQueue()"
        >
          <span class="btn-label">{{ repeatStateLabel(selection.isRepeatQueue) }}</span>
          <span class="btn-key">{{ hotkey('command.repeat') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selection.isRepeatQueue)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="!isBarHotkeyPreset && selection.hasMoveStateControl"
          type="button"
          class="action-btn bar-order-state"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
          :title="stateActionTitle(moveStateLabel(selection.unitMoveState), `Move state: ${moveStateLabel(selection.unitMoveState)}; next ${nextMoveStateLabel(selection.unitMoveState)}`, 'command.moveState')"
          @click="actions.toggleUnitMoveState()"
          @contextmenu.prevent="reverseUnitMoveStateFromClick"
        >
          <span class="btn-label">{{ moveStateLabel(selection.unitMoveState) }}</span>
          <span class="btn-key">{{ hotkey('command.moveState') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in moveStateLights(selection.unitMoveState)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="!isBarHotkeyPreset && selection.hasCloakControl"
          type="button"
          class="action-btn bar-order-state"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
          :title="stateActionTitle(cloakStateLabel(selection), selection.wantsCloak ? 'Disable cloak' : 'Enable cloak', 'command.cloak')"
          @click="actions.toggleCloakState()"
        >
          <span class="btn-label">{{ cloakStateLabel(selection) }}</span>
          <span class="btn-key">{{ hotkey('command.cloak') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selection.wantsCloak || selection.isCloaked)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="showPrototypeOnlyCommandButtons"
          type="button"
          class="action-btn"
          :disabled="!selection.hasQueuedOrders"
          :style="{ '--btn-color': BUTTON_COLORS.skipQueue }"
          :title="actionTitle('Skip current order', 'command.skipCurrent')"
          @click="actions.skipCurrentOrder()"
        >
          <span class="btn-label">Skip</span>
          <span class="btn-key">{{ hotkey('command.skipCurrent') }}</span>
        </button>
        <button
          v-if="showPrototypeOnlyCommandButtons"
          type="button"
          class="action-btn"
          :disabled="!selection.hasQueuedOrders"
          :style="{ '--btn-color': BUTTON_COLORS.undoQueue }"
          :title="actionTitle('Cancel last order', 'command.undoQueue')"
          @click="actions.removeLastQueuedOrder()"
        >
          <span class="btn-label">Cancel</span>
          <span class="btn-key">{{ hotkey('command.undoQueue') }}</span>
        </button>
        <button
          v-if="showPrototypeOnlyCommandButtons"
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

    <!-- Fire control is capability-driven for armed units and buildings. -->
    <div v-if="showCombatActions && (!isBarHotkeyPreset || !showUnitActions)" class="button-group">
      <div class="group-label">Combat</div>
      <div class="buttons bar-command-grid">
        <button
          v-if="showBuildingActions && showAttackCommand"
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
          class="action-btn bar-order-state"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.fireControl) }"
          :title="stateActionTitle(fireStateLabel(selection.fireState), `Fire state: ${fireStateLabel(selection.fireState)}; next ${nextFireStateLabel(selection.fireState)}`, 'command.fireToggle')"
          @click="actions.toggleSelectedFire()"
          @contextmenu.prevent="reverseFireStateFromClick"
        >
          <span class="btn-label">{{ fireStateLabel(selection.fireState) }}</span>
          <span class="btn-key">{{ hotkey('command.fireToggle') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in fireStateLights(selection.fireState)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="showTrajectoryButton"
          type="button"
          class="action-btn bar-order-state"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.fireControl) }"
          :title="actionTitle(trajectoryModeLabel(visibleTrajectoryMode), 'command.trajectoryToggle')"
          @click="actions.toggleTrajectoryMode()"
        >
          <span class="btn-label">{{ trajectoryModeLabel(visibleTrajectoryMode) }}</span>
          <span class="btn-key">{{ hotkey('command.trajectoryToggle') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in trajectoryStateLights(visibleTrajectoryMode)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="showStaticStopButton"
          type="button"
          class="action-btn"
          :style="{ '--btn-color': BUTTON_COLORS.stop }"
          :title="actionTitle('Stop', 'command.stop')"
          @click="actions.stopSelectedUnits()"
        >
          <span class="btn-label">Stop</span>
          <span class="btn-key">{{ hotkey('command.stop') }}</span>
        </button>
      </div>
    </div>

    <!-- Build options (for units with builder capability) -->
    <div v-if="selection.hasBuilder && showUnitActions" class="button-group bar-menu-group build-menu-group">
      <div class="group-label">Build</div>
      <div class="bar-grid-menu" @contextmenu.prevent>
        <div v-if="showBuilderTypeStrip" class="bar-builder-strip" aria-label="Selected builder types">
          <div class="bar-builder-type-list">
            <button
              v-for="builderType in selection.selectedBuilderTypes"
              :key="builderType.unitBlueprintId"
              type="button"
              class="bar-builder-type-btn"
              :class="{ active: builderType.active }"
              :title="`${builderType.label} x${builderType.count}`"
              @click="setActiveBuilder(builderType.unitBlueprintId)"
            >
              <span class="bar-builder-thumb" aria-hidden="true">
                <img
                  v-if="unitThumbnailSrc(builderType.unitBlueprintId)"
                  class="bar-builder-thumb-img"
                  :src="unitThumbnailSrc(builderType.unitBlueprintId)!"
                  alt=""
                >
                <span v-else class="bar-builder-thumb-fallback">{{ builderType.shortName }}</span>
              </span>
              <span v-if="builderType.count > 1" class="bar-builder-count">{{ builderType.count }}</span>
              <span
                v-if="builderTypeBuildProgressStyle(builderType.active)"
                class="bar-builder-build-progress"
                :style="builderTypeBuildProgressStyle(builderType.active)"
                aria-hidden="true"
              ></span>
            </button>
          </div>
          <button
            v-if="showBuilderCycleButton"
            type="button"
            class="bar-grid-footer-btn bar-builder-cycle-btn"
            :title="barGridCycleBuilderTitle"
            @click="cycleActiveBuilder()"
          >
            <span class="bar-builder-cycle-label">›</span>
            <span v-if="barGridCycleBuilderHotkey" class="bar-category-key">{{ barGridCycleBuilderHotkey }}</span>
          </button>
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
            :style="{ '--btn-color': buildOptionBorderColor(bo.category) }"
            :title="costTitle(`Build ${bo.label}`, bo.cost, undefined, bo.metalCost, bo.energyCost)"
            @click="clickBuildGridOption(bo.buildingBlueprintId)"
          >
            <span class="btn-thumb" aria-hidden="true">
              <img
                v-if="structureThumbnailSrc(bo.buildingBlueprintId)"
                class="btn-thumb-img"
                :src="structureThumbnailSrc(bo.buildingBlueprintId)!"
                alt=""
              >
              <span v-else class="btn-thumb-fallback">{{ compactBuildingLabel(bo.label) }}</span>
              <img
                v-if="buildingGroupIconSrc(bo.buildingBlueprintId)"
                class="bar-cell-group-icon"
                :src="buildingGroupIconSrc(bo.buildingBlueprintId)!"
                alt=""
              >
            </span>
            <span class="btn-cost bar-cost-stack">
              <span class="cost-metal">{{ formatCostPart(bo.metalCost) }}</span>
              <span class="cost-energy">{{ formatCostPart(bo.energyCost) }}</span>
            </span>
            <span v-if="buildGridCellHotkey(bo)" class="btn-key bar-cell-key">{{ buildGridCellHotkey(bo) }}</span>
          </button>
          <div v-else class="bar-grid-cell empty" aria-hidden="true"></div>
        </div>
        </div>
        <div
          v-if="showBuildGridFooter"
          class="bar-grid-footer"
          :class="{
            'category-active': showBarGridBuildCategories && currentBuildCategory !== null,
            'page-only': !showBarGridBuildCategories,
          }"
        >
          <template v-if="showBarGridBuildCategories && currentBuildCategory === null">
            <button
              v-for="category in BAR_BUILD_CATEGORIES"
              :key="category.id"
              type="button"
              class="bar-grid-category-btn"
              :title="barBuildCategoryTitle(category)"
              @click="selectBuildGridCategory(category.id)"
            >
              <img
                class="bar-category-icon"
                :src="publicAssetSrc(category.iconPath)"
                alt=""
              >
              <span class="bar-category-label">{{ category.label }}</span>
              <span class="bar-category-key">{{ hotkey(category.keyCommandId) }}</span>
            </button>
          </template>
          <template v-else-if="showBarGridBuildCategories && currentBuildCategory !== null">
            <button
              type="button"
              class="bar-grid-footer-btn bar-grid-back-btn"
              title="Go back to main view"
              @click="clearBuildGridCategory()"
            >
              <span class="bar-back-arrow" aria-hidden="true">⟵</span>
              <span class="bar-back-label">Back</span>
              <span class="bar-category-key">Shift</span>
            </button>
            <div
              class="bar-grid-category-btn bar-grid-current-category active"
              aria-current="true"
            >
              <img
                class="bar-category-icon"
                :src="publicAssetSrc(currentBuildCategory.iconPath)"
                alt=""
              >
              <span class="bar-category-label">{{ currentBuildCategory.label }}</span>
            </div>
            <button
              v-if="showBuildGridPager"
              type="button"
              class="bar-grid-footer-btn bar-grid-next-page-btn"
              title="Next page"
              @click="stepBuildGridPage(1)"
            >
              <span class="bar-page-label">Page {{ buildGridPage + 1 }}/{{ buildGridPageCount }}&nbsp;&nbsp;🠚</span>
              <span v-if="barGridNextPageHotkey" class="bar-category-key">{{ barGridNextPageHotkey }}</span>
            </button>
          </template>
          <button
            v-else-if="showBuildGridPager"
            type="button"
            class="bar-grid-footer-btn bar-grid-next-page-btn"
            title="Next page"
            @click="stepBuildGridPage(1)"
          >
            <span class="bar-page-label">Page {{ buildGridPage + 1 }}/{{ buildGridPageCount }}&nbsp;&nbsp;🠚</span>
            <span v-if="barGridNextPageHotkey" class="bar-category-key">{{ barGridNextPageHotkey }}</span>
          </button>
        </div>
        <div v-if="showBuildUtilityGrid" class="buttons bar-command-grid build-utility-grid">
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
    <div v-if="(selection.hasDGun || selection.hasBuilder || selection.hasCommander || showCaptureButton || showResurrectButton || selection.hasTransport) && showUnitActions" class="button-group">
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
          v-if="selection.hasBuilder"
          type="button"
          class="action-btn"
          :class="{ active: selection.isRepairAreaMode }"
          :style="{ '--btn-color': BUTTON_COLORS.repair }"
          :title="actionTitle('Repair', 'combat.repair')"
          @click="actions.toggleRepairArea()"
        >
          <span class="btn-label">Repair</span>
          <span class="btn-key">{{ hotkey('combat.repair') }}</span>
        </button>
        <button
          v-if="selection.hasBuilder"
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
          v-if="showAreaMexButton"
          type="button"
          class="action-btn"
          :class="{ active: selection.isBuildMode && selection.selectedBuildingBlueprintId === AREA_MEX_BLUEPRINT_ID }"
          :style="{ '--btn-color': BUTTON_COLORS.build }"
          :title="actionTitle('Area Mex', 'command.areaMex', 'Click-drag an area to auto queue metal extractors for all available metal spots')"
          @click="startAreaMexBuild()"
        >
          <span class="btn-label">Area Mex</span>
          <span class="btn-key">{{ hotkey('command.areaMex') }}</span>
        </button>
        <button
          v-if="showCaptureButton"
          type="button"
          class="action-btn"
          :class="{ active: selection.isCaptureMode }"
          :style="{ '--btn-color': BUTTON_COLORS.capture }"
          :title="actionTitle('Capture', 'combat.capture')"
          @click="actions.toggleCapture()"
        >
          <span class="btn-label">Capture</span>
          <span class="btn-key">{{ hotkey('combat.capture') }}</span>
        </button>
        <button
          v-if="showResurrectButton"
          type="button"
          class="action-btn"
          :class="{ active: selection.isResurrectMode }"
          :style="{ '--btn-color': BUTTON_COLORS.resurrect }"
          :title="actionTitle('Resurrect', 'combat.resurrect')"
          @click="actions.toggleResurrect()"
        >
          <span class="btn-label">Resurrect</span>
          <span class="btn-key">{{ hotkey('combat.resurrect') }}</span>
        </button>
        <button
          v-if="selection.hasCommander && showPrototypeOnlyCommandButtons"
          type="button"
          class="action-btn"
          :class="{ active: selection.isResurrectAreaMode }"
          :style="{ '--btn-color': BUTTON_COLORS.resurrect }"
          :title="actionTitle('Resurrect area', 'combat.resurrectArea')"
          @click="actions.toggleResurrectArea()"
        >
          <span class="btn-label">Res Area</span>
          <span class="btn-key">{{ hotkey('combat.resurrectArea') }}</span>
        </button>
        <button
          v-if="selection.hasBuilder && showPrototypeOnlyCommandButtons"
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
          :style="{ '--btn-color': BUTTON_COLORS.loadTransport }"
          :title="actionTitle(barOrderLabel('Load units', 'Load transport'), 'combat.loadTransport', 'Click a friendly unit or click-drag an area')"
          @click="actions.toggleLoadTransport()"
        >
          <span class="btn-label">{{ barOrderLabel('Load units', 'Load') }}</span>
          <span class="btn-key">{{ hotkey('combat.loadTransport') }}</span>
        </button>
        <button
          v-if="selection.hasTransport"
          type="button"
          class="action-btn"
          :class="{ active: selection.isUnloadTransportMode }"
          :style="{ '--btn-color': BUTTON_COLORS.unloadTransport }"
          :title="actionTitle(barOrderLabel('Unload units', 'Unload transport'), 'combat.unloadTransport', 'Click ground or click-drag an area')"
          @click="actions.toggleUnloadTransport()"
        >
          <span class="btn-label">{{ barOrderLabel('Unload units', 'Unload') }}</span>
          <span class="btn-key">{{ hotkey('combat.unloadTransport') }}</span>
        </button>
      </div>
    </div>

    <!-- Factory production control -->
    <div v-if="selection.hasFactory && selection.factoryId && showBuildingActions" class="button-group">
      <div class="group-label">Factory</div>
      <div
        v-if="showPrototypeOnlyCommandButtons"
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
      <div v-if="factoryQueueRuns.length > 0 && showPrototypeOnlyCommandButtons" class="factory-queue-controls">
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
      <div class="buttons bar-command-grid">
        <button
          type="button"
          class="action-btn bar-order-state"
          :class="{ active: selection.factoryRepeatsProduction === true }"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
          :title="actionTitle(repeatStateLabel(selection.factoryRepeatsProduction === true), 'command.repeat')"
          @click="actions.setFactoryRepeatProduction(selection.factoryId!, selection.factoryRepeatsProduction !== true)"
        >
          <span class="btn-label">{{ repeatStateLabel(selection.factoryRepeatsProduction === true) }}</span>
          <span class="btn-key">{{ hotkey('command.repeat') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selection.factoryRepeatsProduction === true)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="isBarHotkeyPreset && selection.hasMoveStateControl"
          type="button"
          class="action-btn bar-order-state"
          :class="{ active: selection.unitMoveState === 'holdPosition' }"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
          :title="stateActionTitle(moveStateLabel(selection.unitMoveState), `Move state: ${moveStateLabel(selection.unitMoveState)}; next ${nextMoveStateLabel(selection.unitMoveState)}`, 'command.moveState')"
          @click="actions.toggleUnitMoveState()"
          @contextmenu.prevent="reverseUnitMoveStateFromClick"
        >
          <span class="btn-label">{{ moveStateLabel(selection.unitMoveState) }}</span>
          <span class="btn-key">{{ hotkey('command.moveState') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in moveStateLights(selection.unitMoveState)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="showFactoryAirIdleButton"
          type="button"
          class="action-btn bar-order-state"
          :class="{ active: selection.factoryAirIdleState === 'land' }"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
          :title="actionTitle(factoryAirIdleStateLabel(selection.factoryAirIdleState), 'factory.airIdleState', 'Sets what aircraft do when leaving air factory')"
          @click="actions.setFactoryAirIdleState(selection.factoryId!, nextFactoryAirIdleState(selection.factoryAirIdleState))"
        >
          <span class="btn-label">{{ factoryAirIdleStateLabel(selection.factoryAirIdleState) }}</span>
          <span class="btn-key">{{ hotkey('factory.airIdleState') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selection.factoryAirIdleState === 'land')"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="showBuilderPriorityButton"
          type="button"
          class="action-btn bar-order-state"
          :class="{ active: selection.builderPriorityLow }"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
          :title="actionTitle(builderPriorityLabel(selection.builderPriorityLow), 'command.builderPriority', 'Assigns resources to use for this builder when not having enough for all')"
          @click="actions.toggleBuilderPriority()"
        >
          <span class="btn-label">{{ builderPriorityLabel(selection.builderPriorityLow) }}</span>
          <span class="btn-key">{{ hotkey('command.builderPriority') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selection.builderPriorityLow)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="showFactoryGuardButton"
          type="button"
          class="action-btn bar-order-state"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.guard) }"
          :title="actionTitle(factoryGuardStateLabel(selection.factoryGuardTargetId === selection.factoryId), 'command.factoryGuard')"
          @click="actions.toggleFactoryGuard(selection.factoryId!)"
        >
          <span class="btn-label">{{ barOrderLabel('Factory Guard', 'Guard') }}</span>
          <span class="btn-key">{{ hotkey('command.factoryGuard') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selection.factoryGuardTargetId === selection.factoryId)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          v-if="showPrototypeOnlyCommandButtons"
          type="button"
          class="action-btn"
          :disabled="selection.factoryGuardTargetId === null || selection.factoryGuardTargetId === undefined || selection.factoryGuardTargetId === selection.factoryId"
          :style="{ '--btn-color': BUTTON_COLORS.guard }"
          title="Clear explicit factory guard target"
          @click="actions.clearFactoryGuard(selection.factoryId!)"
        >
          <span class="btn-label">Clr Target</span>
        </button>
        <button
          v-if="showFactoryQueueModeButton"
          type="button"
          class="action-btn bar-order-state"
          :class="{ active: selection.factoryQueueMode }"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.wait) }"
          :title="actionTitle(factoryQueueModeLabel(selection.factoryQueueMode), 'factory.queueMode')"
          @click="actions.toggleFactoryQueueMode()"
        >
          <span class="btn-label">{{ factoryQueueModeLabel(selection.factoryQueueMode) }}</span>
          <span class="btn-key">{{ hotkey('factory.queueMode') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selection.factoryQueueMode)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          type="button"
          class="action-btn bar-order-wait"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          :title="actionTitle('Wait', 'command.wait', 'Shift-click queues; Ctrl/Cmd+Shift-click inserts next')"
          @click="toggleWaitFromClick"
        >
          <span class="btn-label">Wait</span>
          <span class="btn-key">{{ hotkey('command.wait') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selection.isWaiting)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
        <button
          type="button"
          class="action-btn"
          :disabled="!isBarHotkeyPreset && !hasFactoryProduction"
          :style="{ '--btn-color': factoryStopProductionButtonColor() }"
          :title="actionTitle(stopFactoryProductionLabel(), 'factory.stopProduction', isBarHotkeyPreset ? 'Clear build queue and quotas for all units on selected factories' : undefined)"
          @click="actions.stopFactoryProduction(selection.factoryId!)"
        >
          <span class="btn-label">{{ stopFactoryProductionLabel() }}</span>
          <span class="btn-key">{{ hotkey('factory.stopProduction') }}</span>
        </button>
      </div>
    </div>

    <div v-if="selection.hasFactory && selection.factoryId && showBuildingActions && showPrototypeOnlyCommandButtons" class="button-group factory-preset-group">
      <div class="group-label">Presets</div>
      <div class="factory-preset-grid">
        <button
          v-for="(_, index) in factoryPresetSlots"
          :key="`load-${index}`"
          type="button"
          class="action-btn factory-preset-btn"
          :class="{ active: factoryPresetMatchesCurrent(factoryPresetSlots[index] ?? null) }"
          :disabled="!canLoadFactoryPreset(index)"
          :style="{ '--btn-color': BUTTON_COLORS.vehicleProduce }"
          :title="factoryPresetActionTitle(index, factoryPresetLoadCommandId(index), 'Load')"
          @click="loadFactoryPreset(index)"
        >
          <span class="btn-label">P{{ index }}</span>
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
          <span class="btn-label">S{{ index }}</span>
          <span class="btn-key">{{ factoryPresetSaveKey(index) }}</span>
        </button>
      </div>
    </div>

    <div v-if="showBarFactoryPresetOverlay" class="bar-factory-preset-overlay" aria-label="Factory presets">
      <div class="bar-factory-preset-title">
        <span class="bar-factory-preset-title-thumb" aria-hidden="true">
          <img
            v-if="structureThumbnailSrc('towerFabricator')"
            class="bar-factory-preset-title-thumb-img"
            :src="structureThumbnailSrc('towerFabricator')!"
            alt=""
          >
        </span>
        <span class="bar-factory-preset-title-main">{{ barFactoryPresetTitle }}</span>
      </div>
      <button
        v-for="entry in factoryPresetOverlayEntries"
        :key="entry.index"
        type="button"
        class="bar-factory-preset-row"
        :class="{
          repeat: entry.snapshot.repeatProduction,
          queue: !entry.snapshot.repeatProduction,
          disabled: !entry.canLoad,
          active: factoryPresetMatchesCurrent(entry.snapshot),
        }"
        :disabled="!entry.canLoad"
        :title="factoryPresetActionTitle(entry.index, factoryPresetLoadCommandId(entry.index), 'Load')"
        @click="loadFactoryPreset(entry.index)"
      >
        <span class="bar-factory-preset-number">{{ entry.label }}</span>
        <span class="bar-factory-preset-units">
          <span
            v-for="run in factoryPresetOverlayRuns(entry)"
            :key="run.unitBlueprintId"
            class="bar-factory-preset-unit"
          >
            <span class="bar-factory-preset-thumb" aria-hidden="true">
              <img
                v-if="unitThumbnailSrc(run.unitBlueprintId)"
                class="bar-factory-preset-thumb-img"
                :src="unitThumbnailSrc(run.unitBlueprintId)!"
                alt=""
              >
              <span v-else class="bar-factory-preset-thumb-fallback">{{ run.shortName }}</span>
            </span>
            <span class="bar-factory-preset-count">{{ run.count }}</span>
          </span>
          <span v-if="factoryPresetOverlayOverflow(entry) > 0" class="bar-factory-preset-more">
            +{{ factoryPresetOverlayOverflow(entry) }}
          </span>
        </span>
      </button>
    </div>

    <!-- Factory production (for fabricator buildings). BAR labs use a
         fixed 3x4 unit grid with pages instead of separate long rows. -->
    <div v-if="selection.hasFactory && selection.factoryId && showBuildingActions" class="button-group bar-menu-group">
      <div class="group-label">Produce</div>
      <div class="bar-grid-menu">
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
                'factory-under-construction': selection.factoryUnderConstruction === true,
                'vehicle-btn': uo.locomotion !== 'legs',
                'bot-btn': uo.locomotion === 'legs',
              }"
              :title="factoryProductionCellTitle(uo)"
              @click="(event) => queueFactoryUnitFromClick(selection.factoryId!, uo.unitBlueprintId, event)"
              @contextmenu.prevent="(event) => removeFactoryQueuedUnitFromCell(selection.factoryId!, uo.unitBlueprintId, event)"
            >
              <span v-if="factoryQuotaTarget(uo.unitBlueprintId) > 0" class="bar-cell-quota-count">{{ factoryQuotaLabel(uo.unitBlueprintId) }}</span>
              <span v-if="factoryQueuedCount(uo.unitBlueprintId) > 0" class="bar-cell-queue-count">{{ factoryQueuedCount(uo.unitBlueprintId) }}</span>
              <span class="btn-thumb" aria-hidden="true">
                <img
                  v-if="unitThumbnailSrc(uo.unitBlueprintId)"
                  class="btn-thumb-img"
                  :src="unitThumbnailSrc(uo.unitBlueprintId)!"
                  alt=""
                >
                <span v-else class="btn-thumb-fallback">{{ uo.shortName }}</span>
                <img
                  v-if="unitGroupIconSrc(uo.unitBlueprintId)"
                  class="bar-cell-group-icon"
                  :src="unitGroupIconSrc(uo.unitBlueprintId)!"
                  alt=""
                >
              </span>
              <span
                v-if="factoryCellShowsBuildProgress(uo.unitBlueprintId)"
                class="bar-cell-build-progress"
                :style="factoryCellBuildProgressStyle(uo.unitBlueprintId)"
                aria-hidden="true"
              ></span>
              <span class="btn-cost bar-cost-stack">
                <span class="cost-metal">{{ formatCostPart(uo.metalCost) }}</span>
                <span class="cost-energy">{{ formatCostPart(uo.energyCost) }}</span>
              </span>
              <span v-if="factoryGridCellHotkey(index)" class="btn-key bar-cell-key">{{ factoryGridCellHotkey(index) }}</span>
            </button>
            <div v-else class="bar-grid-cell empty" aria-hidden="true"></div>
          </div>
        </div>
        <div
          v-if="selection.factoryUnderConstruction === true || factoryGridPageCount > 1"
          class="bar-grid-footer page-only"
          :class="{ 'under-construction': selection.factoryUnderConstruction === true }"
        >
          <div v-if="selection.factoryUnderConstruction === true" class="bar-grid-under-construction">
            Under Construction
          </div>
          <button
            v-if="factoryGridPageCount > 1"
            type="button"
            class="bar-grid-footer-btn bar-grid-next-page-btn"
            title="Next page"
            @click="stepFactoryGridPage(1)"
          >
            <span class="bar-page-label">Page {{ factoryGridPage + 1 }}/{{ factoryGridPageCount }}&nbsp;&nbsp;🠚</span>
            <span v-if="barGridNextPageHotkey" class="bar-category-key">{{ barGridNextPageHotkey }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Combat lock-on applies to selected combat hosts with weapon turrets. -->
    <div v-if="selection.hasTowerTargetControl && showCombatActions" class="button-group">
      <div class="group-label">Target</div>
      <div class="buttons bar-command-grid">
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.isTowerTargetMode }"
          :style="{ '--btn-color': BUTTON_COLORS.setTarget }"
          :title="actionTitle(barOrderLabel('Set Target', 'Set target'), 'combat.towerTargetSet', 'Click an entity or ground point to lock on')"
          @click="actions.setTowerTargetMode()"
        >
          <span class="btn-label">Set Target</span>
          <span class="btn-key">{{ hotkey('combat.towerTargetSet') }}</span>
        </button>
        <button
          v-if="showTowerTargetNoGroundButton"
          type="button"
          class="action-btn"
          :class="{ active: selection.isTowerTargetNoGroundMode }"
          :style="{ '--btn-color': BUTTON_COLORS.setTarget }"
          :title="actionTitle('Set target no ground', 'combat.towerTargetSetNoGround', 'Click an entity to lock on; ground clicks are ignored')"
          @click="actions.setTowerTargetNoGroundMode()"
        >
          <span class="btn-label">No Ground</span>
          <span class="btn-key">{{ hotkey('combat.towerTargetSetNoGround') }}</span>
        </button>
        <button
          v-if="showManualLaunchButton"
          type="button"
          class="action-btn"
          :class="{ active: selection.isManualLaunchMode }"
          :style="{ '--btn-color': BUTTON_COLORS.manualFire }"
          :title="actionTitle(barOrderLabel('Launch', 'Manual launch'), 'combat.manualLaunch', 'Click ground to force one volley')"
          @click="actions.toggleManualLaunch()"
        >
          <span class="btn-label">{{ barOrderLabel('Launch', 'Launch') }}</span>
          <span class="btn-key">{{ hotkey('combat.manualLaunch') }}</span>
        </button>
        <button
          v-if="showTowerTargetClearButton"
          type="button"
          class="action-btn"
          :disabled="!selection.hasTowerTargetActive"
          :style="{ '--btn-color': BUTTON_COLORS.cancelTarget }"
          :title="actionTitle(barOrderLabel('Clear Target', 'Clear target'), 'combat.towerTargetClear')"
          @click="actions.clearTowerTarget()"
        >
          <span class="btn-label">{{ barOrderLabel('Clear Target', 'Clear') }}</span>
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
          :title="actionTitle(barOrderLabel('Upgrade', 'Upgrade selected metal extractor'), selectedMetalExtractorUpgradeCommandId)"
          @click="actions.upgradeSelectedMetalExtractors()"
        >
          <span class="btn-label">{{ barOrderLabel('Upgrade', 'T2 Mex') }}</span>
          <span class="btn-key">{{ hotkey(selectedMetalExtractorUpgradeCommandId) }}</span>
        </button>
      </div>
    </div>

    <!-- Building ON/OFF. Prototype active-state covers the broader
         budget_design_philosophy.html mechanic; BAR-visible ON/OFF follows
         BAR onoffable unit defs, so only solar and metal extractor analogues
         expose this command in BAR presets. -->
    <div v-if="showBuildingActiveButton && showBuildingActions" class="button-group">
      <div class="group-label">Power</div>
      <div class="buttons bar-command-grid">
        <button
          type="button"
          class="action-btn bar-order-state"
          :style="{ '--btn-color': barStateButtonColor(BUTTON_COLORS.buildingActive) }"
          :title="stateActionTitle(selectedBuildingsActive ? 'On' : 'Off', selectedBuildingsActive ? 'Turn off' : 'Turn on', 'command.buildingActive')"
          @click="actions.toggleBuildingActive()"
        >
          <span class="btn-label">{{ selectedBuildingsActive ? 'On' : 'Off' }}</span>
          <span class="btn-key">{{ hotkey('command.buildingActive') }}</span>
          <span class="bar-state-lights" aria-hidden="true">
            <span
              v-for="light in binaryStateLights(selectedBuildingsActive)"
              :key="light.key"
              class="bar-state-light"
              :class="[light.tone, { active: light.active }]"
            ></span>
          </span>
        </button>
      </div>
    </div>

    <!-- BAR armamex keeps CMD.STOP because it omits customParams.removestop;
         T1 mex and solar set removestop=true, so this is capability-gated. -->
    <div v-if="showBuildingStopButton" class="button-group">
      <div class="group-label">Orders</div>
      <div class="buttons bar-command-grid">
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
      </div>
    </div>

    <!-- Self-Destruct. Prototype presets keep the budget affordance visible;
         BAR presets match BAR's order menu, where CMD.SELFD is hotkey-only. -->
    <div v-if="showSelfDestructButton" class="button-group">
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
  --bar-order-panel-width: 37.825vh;
  --bar-order-panel-height: 14vh;
  --bar-flow-element-margin: 0.45vh;
  --bar-flow-element-padding: 0.3vh;
  --bar-order-active-padding: calc(var(--bar-flow-element-padding) * 1.4);
  --bar-order-bottom-active-padding: calc(var(--bar-order-active-padding) / 3);
  --bar-order-button-padding: max(1px, calc(var(--bar-flow-element-padding) * 0.52));
  --bar-order-corner-size: calc(var(--bar-order-cell-width) * 0.019);
  --bar-order-active-height: calc(var(--bar-order-panel-height) - var(--bar-order-active-padding) - var(--bar-order-bottom-active-padding));
  --bar-order-active-width: calc(var(--bar-order-panel-width) - (var(--bar-order-active-padding) * 2));
  --bar-order-cell-width: round(down, calc(var(--bar-order-active-width) / var(--bar-order-columns)), 1px);
  --bar-order-cell-height: round(down, calc(var(--bar-order-active-height) / var(--bar-order-rows)), 1px);
  --bar-order-cell-inner-width: round(down, calc(var(--bar-order-cell-width) - var(--bar-order-cell-margin-primary) - var(--bar-order-cell-margin-secondary)), 1px);
  --bar-order-cell-inner-height: round(down, calc(var(--bar-order-cell-height) - var(--bar-order-cell-margin-primary) - var(--bar-order-cell-margin-secondary)), 1px);
  --bar-order-label-max-size: calc(var(--bar-order-cell-inner-width) / 7);
  --bar-order-state-light-height: calc(var(--bar-order-cell-inner-height) * 0.14);
  --bar-order-font-size: clamp(9px, 1.18vh, 13px);
  --bar-order-key-font-size: clamp(9px, 1.05vh, 12px);
  position: fixed;
  left: calc(var(--bar-order-panel-width) + var(--bar-flow-element-margin));
  bottom: var(--selection-panel-playable-bottom, 0px);
  display: grid;
  grid-template-columns: repeat(var(--bar-order-columns), minmax(0, 1fr));
  grid-template-rows: repeat(var(--bar-order-rows), minmax(0, 1fr));
  grid-auto-flow: row;
  align-items: stretch;
  justify-items: stretch;
  gap: 0;
  width: var(--bar-order-panel-width);
  height: var(--bar-order-panel-height);
  box-sizing: border-box;
  background: var(--selection-panel-bg);
  border: 1px solid var(--selection-panel-border);
  border-radius: 4px 4px 0 0;
  padding:
    var(--bar-order-active-padding)
    var(--bar-order-active-padding)
    var(--bar-order-bottom-active-padding)
    var(--bar-order-active-padding);
  max-width: calc(100vw - 280px);
  overflow: visible;
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
    --bar-order-panel-width: min(calc(100vw - 4px), clamp(232px, 76vw, 360px));
    --bar-order-panel-height: clamp(104px, 28vw, 150px);
    max-width: calc(100vw - 4px);
  }
}

.panel-header {
  display: none;
  order: 40;
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
  display: none;
  order: 41;
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
  gap: 0;
  margin-bottom: 2px;
}

.options-panel > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) {
  display: contents;
}

.options-panel > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) > .buttons,
.options-panel > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) > .buttons.bar-command-grid,
.options-panel > .factory-preset-group > .factory-preset-grid {
  display: contents;
}

.selection-command-group {
  display: none;
}

.group-label {
  display: none;
  flex: 0 0 0;
  font-size: 8px;
  color: var(--selection-panel-label);
  margin-bottom: 0;
  text-align: right;
  text-transform: uppercase;
}

.details-group {
  display: none;
  order: 42;
  align-items: stretch;
}

.selection-info-panel {
  position: fixed;
  left: 0;
  bottom: var(--selection-panel-playable-bottom, 0px);
  z-index: 1000;
  display: grid;
  grid-template-columns: minmax(76px, 34%) minmax(0, 1fr);
  gap: calc(var(--bar-flow-element-padding) * 2);
  width: var(--bar-order-panel-width);
  height: var(--bar-order-panel-height);
  box-sizing: border-box;
  padding: calc(var(--bar-flow-element-padding) * 2.1);
  overflow: hidden;
  background: rgba(5, 7, 10, 0.9);
  border: 1px solid var(--selection-panel-border);
  border-radius: 4px 4px 0 0;
  color: var(--selection-panel-text);
  font-family: monospace;
  pointer-events: auto;
}

.selection-info-portrait {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 58%, rgba(92, 132, 162, 0.2), transparent 67%),
    rgba(20, 22, 26, 0.96);
  border: 1px solid rgba(237, 243, 255, 0.13);
  border-radius: 3px;
}

.selection-info-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  transform: scale(1.08);
  transform-origin: center;
  filter: drop-shadow(0 9px 12px rgba(0, 0, 0, 0.48));
}

.selection-info-fallback {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  color: var(--selection-panel-hint);
  font-size: clamp(18px, 3.2vh, 34px);
  font-weight: 900;
  line-height: 1;
}

.selection-info-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: calc(var(--bar-flow-element-padding) * 1.2);
}

.selection-info-title-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: baseline;
}

.selection-info-title {
  min-width: 0;
  overflow: hidden;
  color: rgb(125, 255, 125);
  font-size: clamp(12px, 1.7vh, 18px);
  font-weight: 800;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 1);
}

.selection-info-count {
  color: var(--selection-panel-key);
  font-size: clamp(10px, 1.25vh, 13px);
  font-weight: 800;
}

.selection-info-subtitle {
  min-width: 0;
  overflow: hidden;
  color: var(--selection-panel-label);
  font-size: clamp(8px, 1.08vh, 11px);
  line-height: 1;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.selection-info-meter {
  position: relative;
  height: clamp(12px, 1.7vh, 18px);
  overflow: hidden;
  background: rgba(12, 16, 18, 0.9);
  border: 1px solid rgba(237, 243, 255, 0.13);
  border-radius: 2px;
}

.selection-info-meter-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0%;
  transition: width 0.12s ease-out;
}

.selection-info-meter.health .selection-info-meter-fill {
  background: linear-gradient(90deg, rgb(75, 180, 82), rgb(135, 230, 118));
}

.selection-info-meter.build .selection-info-meter-fill {
  background: linear-gradient(90deg, rgb(206, 155, 48), rgb(255, 210, 74));
}

.selection-info-meter span {
  position: relative;
  z-index: 1;
  display: block;
  color: rgba(246, 255, 246, 0.95);
  font-size: clamp(8px, 1.05vh, 11px);
  font-weight: 800;
  line-height: clamp(12px, 1.7vh, 18px);
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 1);
}

.selection-info-details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 8px;
  min-height: 0;
  overflow: hidden;
}

.selection-info-detail {
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(0, 1fr);
  gap: 4px;
  min-width: 0;
  color: var(--selection-panel-text);
  font-size: clamp(8px, 1.02vh, 10px);
  line-height: 1.12;
}

.selection-info-detail span,
.selection-info-detail strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selection-info-detail span {
  color: var(--selection-panel-label);
  font-weight: 500;
  text-align: right;
}

.selection-info-detail strong {
  color: rgba(242, 247, 250, 0.94);
  font-weight: 700;
  text-align: left;
}

@media (max-width: 900px) {
  .selection-info-panel {
    right: calc(var(--bar-order-panel-width) + 4px);
    width: auto;
    min-width: 0;
  }

  .selection-info-details {
    grid-template-columns: 1fr;
  }
}

.build-menu-group {
  order: 3;
}

.message-area {
  position: fixed;
  left: 50%;
  bottom: calc(var(--selection-panel-playable-bottom, 0px) + 96px);
  z-index: 1002;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  padding: 0 10px;
  background: #05070a;
  border: 1px solid var(--selection-panel-border);
  border-radius: 3px;
  color: var(--selection-panel-key);
  font-size: 9px;
  line-height: 1;
  pointer-events: none;
  text-align: center;
  transform: translateX(-50%);
  white-space: nowrap;
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

.bar-factory-preset-overlay {
  --bar-factory-preset-width: round(nearest, 31.0416667vh, 1px);
  --bar-factory-preset-row-height: round(nearest, 4.1666667vh, 1px);
  --bar-factory-preset-title-height: round(nearest, 5.2083333vh, 1px);
  --bar-factory-preset-icon-border: round(nearest, 0.3125vh, 1px);
  --bar-factory-preset-font-title: round(nearest, 1.6666667vh, 1px);
  --bar-factory-preset-font-group: round(nearest, 1.6666667vh, 1px);
  --bar-factory-preset-font-unit-count: round(nearest, 1.25vh, 1px);
  --bar-factory-preset-group-label-margin: round(nearest, 3.125vh, 1px);
  --bar-factory-preset-title-text-x: round(nearest, 1.0416667vh, 1px);
  --bar-factory-preset-unit-gap: round(nearest, 0.5208333vh, 1px);
  --bar-factory-preset-unit-size: calc(var(--bar-factory-preset-row-height) - (var(--bar-factory-preset-icon-border) * 2));
  position: fixed;
  right: 18px;
  bottom: calc(var(--selection-panel-playable-bottom, 0px) + 134px);
  z-index: 1004;
  width: var(--bar-factory-preset-width);
  color: var(--selection-panel-text);
  filter: drop-shadow(0 8px 20px rgba(0, 0, 0, 0.55));
}

.bar-factory-preset-title,
.bar-factory-preset-row {
  width: var(--bar-factory-preset-width);
  box-sizing: border-box;
  border: 1px solid rgba(170, 194, 178, 0.34);
  background: rgba(9, 12, 14, 0.94);
}

.bar-factory-preset-title {
  display: grid;
  grid-template-columns: var(--bar-factory-preset-title-height) minmax(0, 1fr);
  align-items: center;
  height: var(--bar-factory-preset-title-height);
  padding: 0;
  border-bottom: 0;
}

.bar-factory-preset-title-thumb {
  display: block;
  width: calc(var(--bar-factory-preset-title-height) - var(--bar-factory-preset-icon-border));
  height: calc(var(--bar-factory-preset-title-height) - (var(--bar-factory-preset-icon-border) * 2));
  margin-left: var(--bar-factory-preset-icon-border);
  overflow: hidden;
}

.bar-factory-preset-title-thumb-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bar-factory-preset-title-main {
  min-width: 0;
  overflow: hidden;
  color: rgb(128, 255, 128);
  font-size: var(--bar-factory-preset-font-title);
  font-weight: 700;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateX(var(--bar-factory-preset-title-text-x));
}

.bar-factory-preset-row {
  display: grid;
  grid-template-columns: var(--bar-factory-preset-group-label-margin) minmax(0, 1fr);
  align-items: center;
  height: var(--bar-factory-preset-row-height);
  padding: 0;
  color: inherit;
  cursor: pointer;
}

.bar-factory-preset-row + .bar-factory-preset-row {
  margin-top: 0;
}

.bar-factory-preset-row:hover:not(:disabled),
.bar-factory-preset-row.active {
  background: rgba(23, 31, 27, 0.98);
  border-color: rgba(148, 224, 167, 0.62);
}

.bar-factory-preset-row:disabled {
  cursor: default;
  opacity: 0.5;
}

.bar-factory-preset-number {
  justify-self: center;
  font-size: var(--bar-factory-preset-font-group);
  font-weight: 800;
}

.bar-factory-preset-row.repeat .bar-factory-preset-number {
  color: rgb(0, 255, 0);
}

.bar-factory-preset-row.queue .bar-factory-preset-number {
  color: rgb(255, 255, 255);
}

.bar-factory-preset-units {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--bar-factory-preset-unit-gap);
  overflow: hidden;
}

.bar-factory-preset-unit {
  position: relative;
  flex: 0 0 var(--bar-factory-preset-unit-size);
  width: var(--bar-factory-preset-unit-size);
  height: var(--bar-factory-preset-unit-size);
}

.bar-factory-preset-thumb {
  display: flex;
  width: var(--bar-factory-preset-unit-size);
  height: var(--bar-factory-preset-unit-size);
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #14181c;
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.bar-factory-preset-thumb-img {
  width: 100%;
  height: 100%;
  filter: brightness(0.8);
  object-fit: cover;
}

.bar-factory-preset-thumb-fallback {
  color: var(--selection-panel-key);
  font-size: 8px;
  font-weight: 800;
}

.bar-factory-preset-count {
  position: absolute;
  right: 1px;
  bottom: 0;
  color: #fff;
  font-size: var(--bar-factory-preset-font-unit-count);
  font-weight: 800;
  text-shadow: 0 1px 2px #000, 0 0 3px #000;
}

.bar-factory-preset-more {
  flex: 0 0 auto;
  color: var(--selection-panel-hint);
  font-size: 11px;
  font-weight: 700;
}

.factory-status {
  grid-column: span 2;
  align-self: stretch;
  min-width: 0;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: calc(var(--bar-order-button-padding) + 1px) calc(var(--bar-order-button-padding) + 3px);
  background: #14161a;
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
  margin-bottom: 2px;
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
  grid-column: span 6;
  flex: 1 1 100%;
  display: grid;
  gap: 2px;
  min-width: 0;
}

.factory-queue-control-row {
  display: grid;
  grid-template-columns: minmax(46px, 1fr) repeat(5, 22px);
  gap: 2px;
  align-items: center;
  min-width: 0;
  padding: 1px 2px;
  background: #14161a;
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
  min-width: 22px;
  height: 18px;
  padding: 0 2px;
  border-radius: 3px;
  border: 1px solid var(--selection-panel-button-border);
  background: #282c36;
  color: var(--selection-panel-text);
  font-size: 7px;
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
  background: #14161a;
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

.options-panel > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn {
  width: calc(100% - var(--bar-order-cell-margin-primary) - var(--bar-order-cell-margin-secondary));
  min-width: 0;
  height: calc(100% - var(--bar-order-cell-margin-primary) - var(--bar-order-cell-margin-secondary));
  box-sizing: border-box;
  margin:
    var(--bar-order-cell-margin-primary)
    var(--bar-order-cell-margin-secondary)
    var(--bar-order-cell-margin-secondary)
    var(--bar-order-cell-margin-primary);
  padding: var(--bar-order-button-padding);
  border-radius: var(--bar-order-corner-size);
  font-size: var(--bar-order-font-size);
}

.options-panel .bar-order-state {
  order: 0;
}

.options-panel .bar-order-wait {
  order: 1;
}

.options-panel .bar-order-command {
  order: 2;
}

.options-panel > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-order-state):not(.bar-order-wait):not(.bar-order-command) {
  order: 2;
}

.options-panel .bar-state-lights {
  --bar-state-light-count: 2;
  --bar-state-light-width: calc((var(--bar-order-cell-inner-width) / var(--bar-state-light-count)) - (var(--bar-order-button-padding) * 2));
  --bar-state-light-gap: calc((var(--bar-state-light-width) * 0.075) + (var(--bar-order-button-padding) * 2));
  position: absolute;
  right: calc(var(--bar-order-button-padding) * 2);
  bottom: var(--bar-order-button-padding);
  left: calc(var(--bar-order-button-padding) * 2);
  display: grid;
  grid-template-columns: repeat(var(--bar-state-light-count), minmax(0, 1fr));
  gap: var(--bar-state-light-gap);
  height: var(--bar-order-state-light-height);
  pointer-events: none;
}

.options-panel .bar-state-lights:has(.bar-state-light:nth-child(3)) {
  --bar-state-light-count: 3;
}

.options-panel .bar-state-light {
  min-width: 0;
  background: rgba(0, 0, 0, 0.36);
  border-radius: 0;
}

.options-panel .bar-state-light:first-child {
  border-top-left-radius: calc(var(--bar-order-state-light-height) * 0.33);
  border-bottom-left-radius: calc(var(--bar-order-state-light-height) * 0.33);
}

.options-panel .bar-state-light:last-child {
  border-top-right-radius: calc(var(--bar-order-state-light-height) * 0.33);
  border-bottom-right-radius: calc(var(--bar-order-state-light-height) * 0.33);
}

.options-panel .bar-state-light.off.active {
  background: rgba(255, 26, 26, 0.8);
  box-shadow: 0 0 calc(var(--bar-order-state-light-height) * 8) rgba(255, 26, 26, 0.09);
}

.options-panel .bar-state-light.mid.active {
  background: rgba(255, 255, 26, 0.8);
  box-shadow: 0 0 calc(var(--bar-order-state-light-height) * 8) rgba(255, 255, 26, 0.09);
}

.options-panel .bar-state-light.on.active {
  background: rgba(26, 255, 26, 0.8);
  box-shadow: 0 0 calc(var(--bar-order-state-light-height) * 8) rgba(26, 255, 26, 0.09);
}

.bar-menu-group {
  position: fixed;
  top: var(--hud-minimap-follow-top, 326px);
  left: 0;
  bottom: auto;
  z-index: 1001;
  align-items: flex-start;
  margin: 0;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

@media (max-width: 900px) {
  .bar-menu-group {
    left: 0;
  }
}

.bar-grid-menu {
  --bar-grid-bg-padding: var(--bar-flow-element-padding);
  --bar-grid-icon-margin: round(nearest, calc(var(--bar-grid-bg-padding) * 0.5), 1px);
  --bar-grid-cell-size: round(down, calc((37.825vh - (var(--bar-grid-bg-padding) * 2)) / 4), 1px);
  --bar-grid-cell-padding: round(down, calc(var(--bar-grid-cell-size) * 0.007), 1px);
  --bar-grid-icon-padding: max(1px, round(down, calc(var(--bar-grid-cell-size) * 0.015), 1px));
  --bar-grid-corner-size: round(down, calc(var(--bar-grid-cell-size) * 0.025), 1px);
  --bar-grid-progress-corner-size: calc(var(--bar-grid-cell-size) * 0.03);
  --bar-grid-cell-inner-size: calc(var(--bar-grid-cell-size) - (var(--bar-grid-cell-padding) * 2));
  --bar-grid-icon-inner-size: calc(var(--bar-grid-cell-inner-size) - (var(--bar-grid-icon-padding) * 2));
  --bar-grid-default-unit-scale: 1.0610079576;
  --bar-grid-hover-unit-scale: 1.2048192771;
  --bar-grid-selected-unit-scale: 1.2861736334;
  --bar-grid-unit-base-outline-width: max(1px, round(down, calc(var(--bar-grid-icon-inner-size) * 0.044), 1px));
  --bar-grid-unit-border-size: min(max(1px, round(down, calc(var(--bar-grid-icon-inner-size) * 0.024), 1px)), round(nearest, 0.15vh, 1px));
  --bar-grid-group-icon-size: round(down, calc(var(--bar-grid-icon-inner-size) * 0.3), 1px);
  --bar-grid-queue-font-size: calc(var(--bar-grid-cell-inner-size) * 0.29);
  --bar-grid-queue-badge-height: round(down, calc(var(--bar-grid-cell-inner-size) * 0.365), 1px);
  --bar-grid-queue-text-padding: round(down, calc(var(--bar-grid-cell-inner-size) * 0.1), 1px);
  --bar-grid-queue-corner-size: calc(var(--bar-grid-corner-size) * 3.3);
  --bar-grid-footer-third-width: calc(var(--bar-grid-cell-size) * 1.3333333333);
  --bar-grid-category-font-size: 1.3vh;
  --bar-grid-page-font-size: var(--bar-grid-category-font-size);
  --bar-grid-hotkey-font-size: calc(var(--bar-grid-category-font-size) + 5px);
  --bar-grid-category-button-base-height: round(down, calc(var(--bar-grid-category-font-size) * 2.3), 1px);
  --bar-grid-category-button-height: calc(var(--bar-grid-category-button-base-height) * 1.4);
  --bar-grid-button-padding: max(1px, calc(var(--bar-grid-bg-padding) * 0.52));
  --bar-grid-active-area-margin: calc(var(--bar-grid-bg-padding) * 0.1);
  --bar-grid-category-rect-height: calc(var(--bar-grid-category-button-height) - var(--bar-grid-active-area-margin) - (var(--bar-grid-button-padding) * 2));
  --bar-grid-category-icon-size: min(calc(var(--bar-grid-category-rect-height) * 1.1), var(--bar-grid-category-button-height));
  --bar-grid-footer-button-height: calc(var(--bar-grid-category-button-height) - (var(--bar-grid-button-padding) * 2));
  --bar-builder-button-size: calc(var(--bar-grid-category-button-base-height) * 2);
  --bar-builder-next-height: calc(var(--bar-builder-button-size) * 0.6);
  --bar-builder-next-width: calc((var(--bar-builder-button-size) * 0.45) + (var(--bar-grid-bg-padding) * 2) + 1ch);
  --bar-builder-count-font-size: calc(var(--bar-builder-button-size) * 0.3);
  --bar-builder-count-pad: round(down, calc(var(--bar-builder-button-size) * 0.03), 1px);
  --bar-builder-progress-corner-size: min(max(1px, round(down, calc(var(--bar-builder-button-size) * 0.024), 1px)), round(nearest, 0.15vh, 1px));
  --bar-grid-price-font-size: round(nearest, calc(var(--bar-grid-cell-inner-size) * 0.16), 1px);
  --bar-grid-key-font-size: calc(var(--bar-grid-price-font-size) * 1.1);
  --bar-grid-label-font-size: 1.2vh;
  position: relative;
  display: grid;
  gap: 0;
  min-width: 0;
  padding: var(--bar-grid-bg-padding);
  background: rgba(5, 7, 10, 0.88);
  border: 1px solid var(--selection-panel-border);
  border-radius: 3px;
}

.bar-option-grid {
  display: grid;
  grid-template-columns: repeat(4, var(--bar-grid-cell-size));
  grid-auto-rows: var(--bar-grid-cell-size);
  gap: 0;
}

.bar-grid-slot {
  min-width: 0;
  min-height: 0;
}

.bar-grid-slot:nth-child(n + 1):nth-child(-n + 4) {
  grid-row: 3;
}

.bar-grid-slot:nth-child(n + 5):nth-child(-n + 8) {
  grid-row: 2;
}

.bar-grid-slot:nth-child(n + 9):nth-child(-n + 12) {
  grid-row: 1;
}

.bar-grid-cell {
  width: var(--bar-grid-cell-size);
  min-width: var(--bar-grid-cell-size);
  height: var(--bar-grid-cell-size);
  border-radius: var(--bar-grid-corner-size);
}

.bar-grid-cell.empty {
  position: relative;
  background: transparent;
  border: 0;
}

.bar-grid-cell.empty::before {
  content: "";
  position: absolute;
  inset: calc(var(--bar-grid-cell-padding) + var(--bar-grid-icon-padding));
  background: rgba(26, 26, 26, 0.7);
  border-radius: var(--bar-grid-corner-size);
  pointer-events: none;
}

.bar-grid-cell.thumbnail-action-btn {
  width: var(--bar-grid-cell-size);
  min-width: var(--bar-grid-cell-size);
  height: var(--bar-grid-cell-size);
  padding: calc(var(--bar-grid-cell-padding) + var(--bar-grid-icon-padding));
  overflow: hidden;
}

.bar-grid-cell .btn-thumb {
  position: absolute;
  inset: calc(var(--bar-grid-cell-padding) + var(--bar-grid-icon-padding));
  width: auto;
  height: auto;
  isolation: isolate;
  border: 0;
  background: rgba(255, 255, 255, 0.035);
  border-radius: var(--bar-grid-corner-size);
  box-shadow: 0 0 0 var(--bar-grid-unit-base-outline-width) rgba(0, 0, 0, 0.22);
}

.bar-grid-cell .btn-thumb::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2;
  border-radius: inherit;
  pointer-events: none;
}

.bar-grid-cell .btn-thumb::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  background:
    linear-gradient(to bottom, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0) 40%, rgba(255, 255, 255, 0) 100%),
    linear-gradient(to top, rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0));
  box-shadow:
    inset 0 0 0 var(--bar-grid-unit-border-size) rgba(255, 255, 255, 0.14),
    inset 0 0 calc(var(--bar-grid-unit-border-size) * 2) rgba(255, 255, 255, 0.1);
  pointer-events: none;
}

.bar-grid-cell .btn-thumb-img {
  position: relative;
  z-index: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scale(var(--bar-grid-default-unit-scale));
  transform-origin: center;
}

.bar-grid-cell:hover .btn-thumb-img,
.bar-grid-cell:focus-visible .btn-thumb-img {
  transform: scale(var(--bar-grid-hover-unit-scale));
}

.bar-grid-cell.active .btn-thumb-img {
  transform: scale(var(--bar-grid-selected-unit-scale));
}

.bar-grid-cell.factory-under-construction:not(:hover):not(:focus-visible) .btn-thumb-img {
  filter: brightness(0.77);
}

.bar-grid-cell.active .btn-thumb::before {
  background: rgba(255, 217, 51, 0.25);
  mix-blend-mode: screen;
}

.bar-cell-build-progress {
  position: absolute;
  inset: calc(var(--bar-grid-cell-padding) + var(--bar-grid-icon-padding));
  z-index: 3;
  border-radius: var(--bar-grid-progress-corner-size);
  background: conic-gradient(
    from 0deg,
    rgba(20, 20, 20, 0.6) 0 var(--bar-cell-progress-remaining),
    transparent var(--bar-cell-progress-remaining) 100%
  );
  pointer-events: none;
  transform: scaleX(-1);
}

.bar-cell-group-icon {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  width: var(--bar-grid-group-icon-size);
  height: var(--bar-grid-group-icon-size);
  object-fit: contain;
  pointer-events: none;
  filter: none;
}

.bar-grid-cell.factory-under-construction:not(:hover):not(:focus-visible) .bar-cell-group-icon {
  filter: brightness(0.63);
}

.bar-grid-cell .btn-label {
  position: absolute;
  right: calc(var(--bar-grid-cell-padding) + 2px);
  bottom: calc(var(--bar-grid-price-font-size) + var(--bar-grid-cell-padding) + 8px);
  left: calc(var(--bar-grid-cell-padding) + 2px);
  z-index: 1;
  max-width: none;
  color: #ffffff;
  font-size: var(--bar-grid-label-font-size);
  line-height: 1;
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 1);
}

.bar-grid-cell .btn-cost {
  position: absolute;
  right: calc(var(--bar-grid-cell-padding) + (var(--bar-grid-cell-inner-size) * 0.048));
  bottom: calc(var(--bar-grid-cell-padding) + (var(--bar-grid-price-font-size) * 0.35));
  z-index: 1;
  display: grid;
  justify-items: end;
  font-size: var(--bar-grid-price-font-size);
  font-weight: bold;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}

.bar-cost-stack {
  gap: 0;
  text-align: right;
}

.bar-cell-queue-count,
.bar-cell-quota-count {
  position: absolute;
  left: 0;
  z-index: 2;
  display: grid;
  place-items: center;
  min-width: 0;
  height: var(--bar-grid-queue-badge-height);
  padding: 0 var(--bar-grid-queue-text-padding);
  box-sizing: border-box;
  background: linear-gradient(to top, rgba(38, 38, 38, 0.95), rgba(64, 64, 64, 0.95));
  border: 0;
  font-size: var(--bar-grid-queue-font-size);
  font-weight: bold;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 1);
}

.bar-cell-queue-count {
  top: calc(var(--bar-grid-cell-padding) + var(--bar-grid-icon-padding));
  border-radius: 0 0 var(--bar-grid-queue-corner-size) 0;
  color: rgb(190, 255, 190);
}

.bar-cell-quota-count {
  bottom: calc(var(--bar-grid-cell-padding) + var(--bar-grid-icon-padding));
  border-radius: 0 var(--bar-grid-queue-corner-size) 0 0;
  color: rgb(255, 130, 190);
}

.bar-grid-footer {
  display: grid;
  grid-template-columns: repeat(4, var(--bar-grid-cell-size));
  gap: 0;
}

.bar-grid-footer:not(.category-active):not(.page-only) {
  height: var(--bar-grid-category-button-height);
}

.bar-grid-footer.category-active,
.bar-grid-footer.page-only {
  position: relative;
  display: block;
  width: calc(var(--bar-grid-cell-size) * 4);
  height: var(--bar-grid-category-button-height);
}

.bar-grid-category-btn,
.bar-grid-footer-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: var(--bar-grid-category-button-height);
  padding: 0;
  overflow: hidden;
  background: var(--selection-panel-button-bg);
  border: 1px solid var(--selection-panel-button-border);
  border-radius: 3px;
  color: var(--selection-panel-text);
  font-family: monospace;
  font-size: var(--bar-grid-category-font-size);
  font-weight: bold;
  line-height: 1;
  cursor: pointer;
}

.bar-grid-category-btn {
  width: var(--bar-grid-cell-size);
  overflow: visible;
}

.bar-grid-footer:not(.category-active):not(.page-only) .bar-grid-category-btn {
  align-self: start;
  height: var(--bar-grid-category-rect-height);
  margin-top: var(--bar-grid-button-padding);
}

.bar-grid-footer.category-active .bar-grid-back-btn,
.bar-grid-footer.category-active .bar-grid-next-page-btn,
.bar-grid-footer.category-active .bar-grid-current-category,
.bar-grid-footer.page-only .bar-grid-next-page-btn {
  position: absolute;
  top: var(--bar-grid-button-padding);
}

.bar-grid-footer.category-active .bar-grid-current-category {
  height: var(--bar-grid-category-rect-height);
}

.bar-grid-footer.category-active .bar-grid-back-btn,
.bar-grid-footer.category-active .bar-grid-next-page-btn,
.bar-grid-footer.page-only .bar-grid-next-page-btn {
  height: var(--bar-grid-footer-button-height);
}

.bar-grid-footer.category-active .bar-grid-back-btn,
.bar-grid-footer.category-active .bar-grid-next-page-btn,
.bar-grid-footer.page-only .bar-grid-next-page-btn {
  width: calc(var(--bar-grid-footer-third-width) - (var(--bar-grid-bg-padding) * 2));
}

.bar-grid-footer.category-active .bar-grid-back-btn {
  left: 0;
  justify-content: space-between;
}

.bar-grid-footer.category-active .bar-grid-next-page-btn,
.bar-grid-footer.page-only .bar-grid-next-page-btn {
  right: 0;
}

.bar-grid-under-construction {
  position: absolute;
  top: var(--bar-grid-button-padding);
  right: 0;
  left: 0;
  display: grid;
  place-items: center;
  height: var(--bar-grid-footer-button-height);
  color: rgb(255, 200, 50);
  font-size: calc(var(--bar-grid-page-font-size) * 1.1);
  font-weight: bold;
  line-height: 1;
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 1);
  pointer-events: none;
}

.bar-grid-footer.category-active .bar-grid-current-category {
  left: 50%;
  width: var(--bar-grid-footer-third-width);
  transform: translateX(-50%);
}

.bar-grid-current-category {
  cursor: default;
}

.bar-builder-strip {
  position: absolute;
  left: 0;
  bottom: 100%;
  display: flex;
  align-items: center;
  gap: var(--bar-grid-bg-padding);
  width: max-content;
  min-height: 0;
  margin: 0;
}

.bar-builder-type-list {
  display: flex;
  align-items: center;
  gap: calc(var(--bar-grid-bg-padding) + var(--bar-grid-icon-margin));
  padding:
    var(--bar-grid-icon-margin)
    calc(var(--bar-grid-bg-padding) * 2)
    calc(var(--bar-grid-bg-padding) + var(--bar-grid-icon-margin))
    calc(var(--bar-grid-bg-padding) + var(--bar-grid-icon-margin));
  background: rgba(5, 7, 10, 0.88);
  border-radius: 0 3px 3px 0;
}

.bar-builder-type-btn {
  position: relative;
  width: var(--bar-builder-button-size);
  height: var(--bar-builder-button-size);
  padding: 0;
  overflow: hidden;
  background: transparent;
  border: 0;
  border-radius: 3px;
  cursor: pointer;
}

.bar-builder-type-btn:focus-visible {
  outline: 1px solid rgba(255, 255, 255, 0.55);
  outline-offset: 1px;
}

.bar-builder-thumb,
.bar-builder-thumb-img,
.bar-builder-thumb-fallback {
  display: block;
  width: 100%;
  height: 100%;
}

.bar-builder-thumb-img {
  object-fit: cover;
  filter: brightness(0.5);
  transform: scale(2.1);
  transform-origin: center;
}

.bar-builder-type-btn:hover .bar-builder-thumb-img,
.bar-builder-type-btn:focus-visible .bar-builder-thumb-img {
  filter: brightness(0.75);
  transform: scale(2.2);
}

.bar-builder-type-btn.active .bar-builder-thumb-img {
  filter: brightness(1);
}

.bar-builder-type-btn.active:hover .bar-builder-thumb-img,
.bar-builder-type-btn.active:focus-visible .bar-builder-thumb-img {
  filter: brightness(1.25);
}

.bar-builder-thumb-fallback {
  display: grid;
  place-items: center;
  color: var(--selection-panel-text);
  font-family: monospace;
  font-size: var(--bar-grid-category-font-size);
  font-weight: bold;
}

.bar-builder-count {
  position: absolute;
  left: calc(var(--bar-builder-count-pad) * 2);
  bottom: var(--bar-builder-count-pad);
  color: rgb(240, 240, 240);
  font-family: monospace;
  font-size: var(--bar-builder-count-font-size);
  font-weight: bold;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 1);
}

.bar-builder-build-progress {
  position: absolute;
  inset: 0;
  z-index: 2;
  border-radius: var(--bar-builder-progress-corner-size);
  background: conic-gradient(
    from 0deg,
    rgba(13, 13, 13, 0.72) 0 var(--bar-builder-progress-remaining),
    transparent var(--bar-builder-progress-remaining) 100%
  );
  pointer-events: none;
  transform: scaleX(-1);
}

.bar-builder-cycle-btn {
  align-self: flex-start;
  width: var(--bar-builder-next-width);
  min-width: var(--bar-builder-next-width);
  height: var(--bar-builder-next-height);
  margin-top: calc(var(--bar-grid-icon-margin) + (var(--bar-builder-button-size) * 0.2));
  margin-left: 0;
}

.bar-builder-cycle-label {
  position: absolute;
  top: 50%;
  left: calc(var(--bar-builder-next-height) * 0.2);
  color: #ffffff;
  font-size: calc(var(--bar-builder-next-height) * 1.2);
  line-height: 1;
  transform: translateY(-50%);
}

.bar-builder-cycle-btn .bar-category-key {
  position: absolute;
  top: 50%;
  right: calc(var(--bar-grid-bg-padding) * 2);
  transform: translateY(-50%);
}

.bar-grid-category-btn:hover,
.bar-grid-footer-btn:hover {
  border-color: var(--selection-panel-button-border);
  background: var(--selection-panel-button-hover-bg);
}

.bar-grid-category-btn.active {
  background: rgba(51, 51, 51, 0.9);
  border-color: var(--selection-panel-button-border);
  box-shadow: none;
}

.bar-category-icon {
  position: absolute;
  top: calc(var(--bar-grid-bg-padding) * 0.5);
  left: calc(var(--bar-grid-bg-padding) * 0.5);
  width: var(--bar-grid-category-icon-size);
  height: var(--bar-grid-category-icon-size);
  object-fit: contain;
  opacity: 0.9;
  pointer-events: none;
}

.bar-category-label {
  position: absolute;
  top: 50%;
  right: calc(var(--bar-grid-bg-padding) * 2);
  left: calc(var(--bar-grid-bg-padding) * 7);
  overflow: hidden;
  text-align: left;
  text-overflow: clip;
  transform: translateY(-50%);
  white-space: nowrap;
}

.bar-back-arrow {
  position: absolute;
  top: 50%;
  left: calc(var(--bar-grid-bg-padding) * 2);
  transform: translateY(-50%);
}

.bar-back-label {
  position: absolute;
  top: 50%;
  left: 25%;
  transform: translate(-50%, -50%);
}

.bar-page-label {
  position: absolute;
  top: 50%;
  right: calc(var(--bar-grid-bg-padding) * 2);
  left: calc(var(--bar-grid-bg-padding) * 3);
  overflow: hidden;
  text-align: left;
  text-overflow: clip;
  transform: translateY(-50%);
  white-space: nowrap;
}

.bar-category-key {
  display: block;
  min-width: 0;
  height: auto;
  padding: 0;
  background: transparent;
  color: rgb(215, 255, 215);
  font-size: var(--bar-grid-hotkey-font-size);
  line-height: 1;
}

.bar-grid-footer .bar-category-key {
  position: absolute;
  top: 50%;
  right: calc(var(--bar-grid-bg-padding) * 2);
  transform: translateY(-50%);
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

.options-panel.bar-hotkey-preset .action-btn {
  transition: none;
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

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn.active:not(.bar-grid-cell):not(.bar-order-state) {
  background: linear-gradient(to top, rgba(168, 168, 168, 0.75), rgba(255, 255, 255, 0.75));
  border-color: rgba(255, 255, 255, 0.88);
  color: rgb(20, 20, 20);
  box-shadow: none;
  transform: scale(1.05);
  z-index: 2;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn.active:not(.bar-grid-cell):not(.bar-order-state) > .btn-label {
  color: rgb(20, 20, 20);
  text-shadow: none;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell) {
  --bar-order-hover-top-alpha: 0.28;
  --bar-order-hover-top-fade-alpha: 0.035;
  --bar-order-hover-bottom-alpha: 0.095;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn.active:not(.bar-grid-cell):not(.bar-order-state) {
  --bar-order-hover-top-alpha: 0.112;
  --bar-order-hover-top-fade-alpha: 0.014;
  --bar-order-hover-bottom-alpha: 0.038;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell)::before,
.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell)::after {
  content: "";
  position: absolute;
  right: calc(var(--bar-order-button-padding) * 2);
  left: calc(var(--bar-order-button-padding) * 2);
  z-index: 1;
  border-radius: var(--bar-order-corner-size);
  opacity: 0;
  pointer-events: none;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell)::before {
  top: calc(var(--bar-order-button-padding) * 2);
  height: 42%;
  background: linear-gradient(to bottom, rgba(255, 255, 255, var(--bar-order-hover-top-alpha)), rgba(255, 255, 255, var(--bar-order-hover-top-fade-alpha)));
  border-bottom-right-radius: 0;
  border-bottom-left-radius: 0;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell)::after {
  bottom: calc(var(--bar-order-button-padding) * 2);
  height: 50%;
  background: linear-gradient(to bottom, rgba(255, 255, 255, var(--bar-order-hover-bottom-alpha)), rgba(255, 255, 255, 0));
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell):hover:not(:disabled),
.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell):focus-visible:not(:disabled) {
  background: var(--selection-panel-button-bg);
  border-color: var(--selection-panel-button-border);
  box-shadow: none;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn.active:not(.bar-grid-cell):not(.bar-order-state):hover:not(:disabled),
.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn.active:not(.bar-grid-cell):not(.bar-order-state):focus-visible:not(:disabled) {
  background: linear-gradient(to top, rgba(168, 168, 168, 0.75), rgba(255, 255, 255, 0.75));
  border-color: rgba(255, 255, 255, 0.88);
  color: rgb(20, 20, 20);
  transform: scale(1.05);
  z-index: 2;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell):hover:not(:disabled),
.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell):focus-visible:not(:disabled) {
  transform: scale(1.035);
  z-index: 1;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell):hover:not(:disabled)::before,
.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell):hover:not(:disabled)::after,
.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell):focus-visible:not(:disabled)::before,
.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell):focus-visible:not(:disabled)::after {
  opacity: 1;
}

.options-panel.bar-hotkey-preset .bar-order-state.active {
  background: var(--selection-panel-button-bg);
  border-color: var(--selection-panel-button-border);
  box-shadow: none;
}

.options-panel.bar-hotkey-preset .bar-grid-cell.action-btn:hover,
.options-panel.bar-hotkey-preset .bar-grid-cell.action-btn:focus-visible,
.options-panel.bar-hotkey-preset .bar-grid-cell.action-btn.active {
  background: var(--selection-panel-button-bg);
  border-color: var(--selection-panel-button-border);
  box-shadow: none;
}

/* Build options keep the category-coded frame used by annihilation-plus-plus:
 * a quiet accent while idle, then nearly full-strength while focused or active. */
.bar-grid-cell.build-btn {
  border-color: color-mix(in srgb, var(--btn-color) 48%, transparent);
}

.bar-grid-cell.build-btn:hover,
.bar-grid-cell.build-btn:focus-visible,
.bar-grid-cell.build-btn.active,
.options-panel.bar-hotkey-preset .bar-grid-cell.build-btn.action-btn:hover,
.options-panel.bar-hotkey-preset .bar-grid-cell.build-btn.action-btn:focus-visible,
.options-panel.bar-hotkey-preset .bar-grid-cell.build-btn.action-btn.active {
  border-color: color-mix(in srgb, var(--btn-color) 92%, transparent);
}

.btn-label {
  display: block;
  max-width: 8ch;
  overflow: hidden;
  font-weight: bold;
  text-overflow: clip;
  white-space: nowrap;
}

.options-panel.bar-hotkey-preset > .button-group:not(.bar-menu-group):not(.selection-command-group):not(.details-group) .action-btn:not(.bar-grid-cell) > .btn-label {
  max-width: 100%;
  font-size: min(var(--bar-order-font-size), var(--bar-order-label-max-size));
  letter-spacing: 0;
  line-height: 0.95;
  overflow-wrap: anywhere;
  text-align: center;
  white-space: normal;
}

.btn-cost {
  display: none;
}

.cost-energy {
  color: var(--selection-panel-cost-energy);
}

.cost-metal {
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
  font-size: var(--bar-order-key-font-size, 10px);
  font-weight: bold;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
  transform: translateX(-50%) translateY(2px);
  transition: opacity 0.12s ease, transform 0.12s ease;
  white-space: nowrap;
  z-index: 2;
}

.options-panel.bar-hotkey-preset .action-btn:not(.bar-grid-cell) > .btn-key {
  display: none;
}

.action-btn:hover .btn-key,
.action-btn:focus-visible .btn-key {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.bar-grid-cell > .btn-key.bar-cell-key {
  right: calc(var(--bar-grid-cell-padding) + (var(--bar-grid-cell-inner-size) * 0.048));
  left: auto;
  top: var(--bar-grid-cell-padding);
  bottom: auto;
  display: block;
  min-width: 0;
  height: auto;
  padding: 0;
  background: transparent;
  border: 0;
  color: rgb(215, 255, 215);
  font-size: var(--bar-grid-key-font-size);
  opacity: 1;
  transform: none;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 1);
}

.bar-grid-cell:hover > .btn-key.bar-cell-key,
.bar-grid-cell:focus-visible > .btn-key.bar-cell-key {
  transform: none;
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

</style>
