<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { COLORS, WAYPOINT_COLOR_CSS } from '@/colorsConfig';
import type { WaypointType } from '../game/sim/types';
import {
  structureRosterDisplay,
  unitRosterDisplay,
} from '../game/sim/blueprints/displayRosters';
import {
  commandHotkeyLabel,
  type CommandHotkeyId,
  type CommandHotkeyPresetId,
} from '../game/input/commandHotkeys';
import { buildStructureMenuLayout } from '../game/input/buildMenuLayout';
import {
  FACTORY_PRODUCTION_PRESET_COUNT,
  FACTORY_PRODUCTION_PRESET_STORAGE_KEY,
  FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT,
  getFactoryProductionPresetSlot,
  loadFactoryProductionPresetSlots,
  setFactoryProductionPresetSlot,
} from '../game/input/factoryProductionPresets';

export type { FactorySelectionItem, SelectionInfo, SelectionActions } from '@/types/ui';
import type {
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
  '--selection-panel-vehicle-produce': BUTTON_COLORS.vehicleProduce,
  '--selection-panel-bot-produce': BUTTON_COLORS.botProduce,
} as const;

// Repeat-build: selected unit blueprint currently being looped. Used to
// light up the matching button.
const selectedBuildUnitBlueprintId = computed(() =>
  props.selection.factorySelectedUnit?.unitBlueprintId ?? null,
);
const hasFactoryProduction = computed(() =>
  selectedBuildUnitBlueprintId.value !== null || props.selection.factoryIsProducing === true,
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
  return props.selection.factoryIsProducing === true
    ? `${unitLabel} producing`
    : `${unitLabel} idle`;
});
const factoryStatusTitle = computed(() =>
  `Factory repeat-build: ${factoryStatusLabel.value} - ${factoryProgressPercent.value}%`,
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
          key: hotkey(commandId),
          commandId,
          gridRow: item.gridRow,
          gridColumn: item.gridColumn,
        };
    })
    .filter((option) => option !== null);
});
const buildingOptionGroups = computed(() => {
  const groups: { label: string; options: typeof buildingOptions.value }[] = [];
  for (const option of buildingOptions.value) {
    let group = groups.find((entry) => entry.label === option.category);
    if (group === undefined) {
      group = { label: option.category, options: [] };
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
});
const buildLineSpacingLabel = computed(() =>
  `${Math.round(props.selection.buildLineSpacingMultiplier * 100)}%`,
);
const buildFacingLabel = computed(() => `${props.selection.buildFacingDegrees}deg`);
const unitOptions = unitRosterDisplay;

const vehicleOptions = unitOptions.filter((unit) => unit.locomotion !== 'legs');
const botOptions = unitOptions.filter((unit) => unit.locomotion === 'legs');

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
});

onUnmounted(() => {
  if (typeof window === 'undefined') return;
  window.removeEventListener(FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT, refreshFactoryPresetSlots);
  window.removeEventListener('storage', onFactoryPresetStorageChanged);
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
  props.actions.queueUnit(factoryId, unitBlueprintId);
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
        <span v-if="group.auto" class="control-group-auto">A</span>
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
      <div class="buttons">
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
          <span class="btn-label">{{ option.label }} {{ option.count }}</span>
        </button>
      </div>
    </div>

    <!-- Movement mode buttons (for units) -->
    <div v-if="showUnitActions" class="button-group">
      <div class="group-label">Movement</div>
      <div class="buttons">
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
          :class="{ active: selection.isFormationMoveMode }"
          :style="{ '--btn-color': WAYPOINT_COLOR_CSS.move }"
          title="Move in formation - Ctrl+Right click"
          @click="actions.toggleFormationMove()"
        >
          <span class="btn-label">Form</span>
          <span class="btn-key">Ctrl+RMB</span>
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
          :title="actionTitle('Attack ground', 'combat.attackGround', 'Toggle ground targeting')"
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
          :title="actionTitle('Wait', 'command.wait')"
          @click="actions.toggleSelectedWait()"
        >
          <span class="btn-label">Wait</span>
          <span class="btn-key">{{ hotkey('command.wait') }}</span>
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
          :class="{ active: selection.isHoldPosition }"
          :style="{ '--btn-color': BUTTON_COLORS.wait }"
          :title="actionTitle(selection.isHoldPosition ? 'Maneuver' : 'Hold position', 'command.moveState')"
          @click="actions.toggleUnitMoveState()"
        >
          <span class="btn-label">{{ selection.isHoldPosition ? 'Hold' : 'Move' }}</span>
          <span class="btn-key">{{ hotkey('command.moveState') }}</span>
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

    <!-- Fire control (units + towers). Lives outside the Movement
         group because towers also expose fire-at-will / hold-fire.
         See budget_design_philosophy.html "Selection Menus Are Uniform Per
         Entity Type": both unit and tower selection panels list a
         fire-control toggle. -->
    <div v-if="showCombatActions" class="button-group">
      <div class="group-label">{{ isStaticOnlySelection ? 'Tower' : 'Combat' }}</div>
      <div class="buttons">
        <button
          type="button"
          class="action-btn"
          :class="{ active: selection.fireEnabled }"
          :style="{ '--btn-color': BUTTON_COLORS.fireControl }"
          :title="actionTitle(selection.fireEnabled ? 'Hold fire' : 'Fire at will', 'command.fireToggle')"
          @click="actions.toggleSelectedFire()"
        >
          <span class="btn-label">{{ selection.fireEnabled ? 'Fire' : 'Hold' }}</span>
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
    <div v-if="selection.hasBuilder && showUnitActions" class="button-group">
      <div class="group-label">Build</div>
      <div class="buttons">
        <div
          v-for="group in buildingOptionGroups"
          :key="group.label"
          class="build-category-group"
        >
          <span class="build-category-label">{{ group.label }}</span>
          <button
            v-for="bo in group.options"
            :key="bo.buildingBlueprintId"
            type="button"
            class="action-btn build-btn"
            :class="{ active: selection.isBuildMode && selection.selectedBuildingBlueprintId === bo.buildingBlueprintId }"
            :title="costTitle(`Build ${bo.label}`, bo.cost, bo.key)"
            @click="selection.isBuildMode && selection.selectedBuildingBlueprintId === bo.buildingBlueprintId ? actions.cancelBuild() : actions.startBuild(bo.buildingBlueprintId)"
          >
            <span class="btn-label">{{ compactBuildingLabel(bo.label) }}</span>
            <span class="btn-cost"><span class="cost-resource">{{ bo.cost }}</span></span>
            <span class="btn-key">{{ bo.key }}</span>
          </button>
        </div>
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

    <!-- Commander specials -->
    <div v-if="(selection.hasDGun || selection.hasCommander) && showUnitActions" class="button-group">
      <div class="group-label">Special</div>
      <div class="buttons">
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
          :disabled="!selection.hasReclaimableSelection"
          :style="{ '--btn-color': BUTTON_COLORS.reclaim }"
          title="Reclaim selected targets"
          @click="actions.reclaimSelected()"
        >
          <span class="btn-label">Reclaim Sel</span>
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
      </div>
      <div class="buttons">
        <button
          type="button"
          class="action-btn"
          :disabled="!hasFactoryProduction"
          :style="{ '--btn-color': BUTTON_COLORS.stop }"
          title="Stop production"
          @click="actions.stopFactoryProduction(selection.factoryId!)"
        >
          <span class="btn-label">Stop</span>
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

    <!-- Vehicle production (for factory) -->
    <div v-if="selection.hasFactory && selection.factoryId && showTowerActions" class="button-group">
      <div class="group-label">Vehicles</div>
      <div class="buttons">
        <button
          v-for="uo in vehicleOptions"
          :key="uo.unitBlueprintId"
          type="button"
          class="action-btn produce-btn vehicle-btn"
          :class="{ active: selectedBuildUnitBlueprintId === uo.unitBlueprintId }"
          :title="costTitle(`Queue ${uo.label}`, uo.cost)"
          @click="actions.queueUnit(selection.factoryId!, uo.unitBlueprintId)"
        >
          <span class="btn-label">{{ uo.shortName }}</span>
          <span class="btn-cost"><span class="cost-resource">{{ uo.cost }}</span></span>
        </button>
      </div>
    </div>

    <!-- Bot production (for factory) -->
    <div v-if="selection.hasFactory && selection.factoryId && showTowerActions" class="button-group">
      <div class="group-label">Bots</div>
      <div class="buttons">
        <button
          v-for="uo in botOptions"
          :key="uo.unitBlueprintId"
          type="button"
          class="action-btn produce-btn bot-btn"
          :class="{ active: selectedBuildUnitBlueprintId === uo.unitBlueprintId }"
          :title="costTitle(`Queue ${uo.label}`, uo.cost)"
          @click="actions.queueUnit(selection.factoryId!, uo.unitBlueprintId)"
        >
          <span class="btn-label">{{ uo.shortName }}</span>
          <span class="btn-cost"><span class="cost-resource">{{ uo.cost }}</span></span>
        </button>
      </div>
    </div>

    <!-- Combat lock-on. Set Target enters a no-ground click-pick mode
         (the next left-click on any entity with an ID sets the host-level
         priorityTargetId; ground clicks are ignored); Clear Target
         drops the lock and reverts to autonomous acquisition.
         Applies to selected combat units and towers with turrets. -->
    <div v-if="selection.hasTowerTargetControl && showCombatActions" class="button-group">
      <div class="group-label">Target</div>
      <div class="buttons">
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

    <!-- Building ON/OFF. Producer Buildings Are ON/OFF in
         budget_design_philosophy.html: solar/wind/extractor selections expose
         this toggle. ON = producing + normal damage; OFF = not
         producing + 10x damage resistance. -->
    <div v-if="selection.hasBuildingActiveControl && showBuildingActions" class="button-group">
      <div class="group-label">Power</div>
      <div class="buttons">
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
      <div class="buttons">
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
  position: absolute;
  bottom: 16px;
  left: 16px;
  background: var(--selection-panel-bg);
  border: 1px solid var(--selection-panel-border);
  border-radius: 6px;
  padding: 6px;
  max-width: min(520px, calc(100vw - 32px));
  font-family: monospace;
  color: var(--selection-panel-text);
  pointer-events: auto;
  z-index: 1000;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  font-weight: bold;
  margin-bottom: 5px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--selection-panel-header-border);
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
  display: grid;
  grid-template-columns: repeat(10, 30px);
  gap: 3px;
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
  top: -4px;
  right: -3px;
  display: grid;
  place-items: center;
  width: 9px;
  height: 9px;
  background: var(--selection-panel-bg);
  border: 1px solid var(--selection-panel-vehicle-produce);
  border-radius: 50%;
  color: var(--selection-panel-text);
  font-size: 7px;
  font-weight: bold;
}

.button-group {
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
  align-items: stretch;
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
