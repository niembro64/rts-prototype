<script setup lang="ts">
import { computed } from 'vue';
import type { WaypointType } from '../game/sim/types';
import {
  buildingRosterDisplay,
  unitRosterDisplay,
} from '../game/sim/blueprints/displayRosters';

export type { QueueItem, SelectionInfo, SelectionActions } from '@/types/ui';
import type { ControlGroupInfo, SelectionInfo, SelectionActions } from '@/types/ui';

const props = defineProps<{
  selection: SelectionInfo;
  actions: SelectionActions;
}>();

const controlGroupSlots = computed<ControlGroupInfo[]>(() => {
  const groups = props.selection.controlGroups ?? [];
  return Array.from({ length: 9 }, (_, index) => (
    groups.find((group) => group.index === index) ?? { index, count: 0, active: false }
  ));
});
const hasStoredControlGroups = computed(() =>
  controlGroupSlots.value.some((group) => group.count > 0),
);
const canStoreControlGroup = computed(() =>
  props.selection.unitCount > 0 || props.selection.hasFactory,
);
const showPanel = computed(() =>
  props.selection.unitCount > 0 || props.selection.hasFactory || hasStoredControlGroups.value,
);

// Repeat-build: queue holds 0-or-1 entries; queue[0] is the unit type
// currently being looped. Used to light up the matching button.
const selectedBuildUnitId = computed(() =>
  props.selection.factoryQueue?.[0]?.unitId ?? null,
);

const waypointModes: { mode: WaypointType; label: string; key: string; color: string }[] = [
  { mode: 'move', label: 'Move', key: 'M', color: '#00ff00' },
  { mode: 'fight', label: 'Fight', key: 'F', color: '#ff4444' },
  { mode: 'patrol', label: 'Patrol', key: 'H', color: '#0088ff' },
];

const buildingOptions = buildingRosterDisplay;
const unitOptions = unitRosterDisplay;

const vehicleOptions = unitOptions.filter((unit) => unit.locomotion !== 'legs');
const botOptions = unitOptions.filter((unit) => unit.locomotion === 'legs');

</script>

<template>
  <!-- OPTIONS PANEL (left side) -->
  <div v-if="showPanel" class="options-panel">
    <!-- Unit count display -->
    <div class="panel-header">
      <span v-if="selection.hasCommander" class="unit-type commander">Commander</span>
      <span v-else-if="selection.hasFactory" class="unit-type factory">Fabricator</span>
      <span v-else class="unit-type">{{ selection.unitCount }} Unit{{ selection.unitCount > 1 ? 's' : '' }}</span>
    </div>

    <!-- Movement mode buttons (for units) -->
    <div v-if="selection.unitCount > 0" class="button-group">
      <div class="group-label">Movement</div>
      <div class="buttons">
        <button
          v-for="wm in waypointModes"
          :key="wm.mode"
          class="action-btn"
          :class="{ active: selection.waypointMode === wm.mode }"
          :style="{ '--btn-color': wm.color }"
          @click="actions.setWaypointMode(wm.mode)"
        >
          <span class="btn-label">{{ wm.label }}</span>
          <span class="btn-key">{{ wm.key }}</span>
        </button>
        <button
          class="action-btn"
          :class="{ active: selection.isAttackAreaMode }"
          :style="{ '--btn-color': '#ff5a5a' }"
          title="Toggle area attack targeting for selected units"
          @click="actions.toggleAttackArea()"
        >
          <span class="btn-label">Attack</span>
          <span class="btn-key">A</span>
        </button>
        <button
          class="action-btn"
          :class="{ active: selection.isAttackGroundMode }"
          :style="{ '--btn-color': '#ff7a18' }"
          title="Toggle attack-ground targeting for selected units"
          @click="actions.toggleAttackGround()"
        >
          <span class="btn-label">Ground</span>
          <span class="btn-key">T</span>
        </button>
        <button
          class="action-btn"
          :class="{ active: selection.isGuardMode }"
          :style="{ '--btn-color': '#9ef28d' }"
          title="Toggle guard targeting for selected units"
          @click="actions.toggleGuard()"
        >
          <span class="btn-label">Guard</span>
          <span class="btn-key">G</span>
        </button>
        <button
          class="action-btn"
          :style="{ '--btn-color': '#d6d6d6' }"
          @click="actions.stopSelectedUnits()"
        >
          <span class="btn-label">Stop</span>
          <span class="btn-key">S</span>
        </button>
        <button
          class="action-btn"
          :class="{ active: selection.isWaiting }"
          :style="{ '--btn-color': '#e8e8e8' }"
          title="Toggle wait for selected units"
          @click="actions.toggleSelectedWait()"
        >
          <span class="btn-label">Wait</span>
          <span class="btn-key">W</span>
        </button>
        <button
          v-if="selection.hasJump"
          class="action-btn"
          :class="{ active: selection.jumpEnabled }"
          :style="{ '--btn-color': '#ffe08a' }"
          title="Toggle whether selected units are allowed to jump"
          @click="actions.toggleSelectedJump()"
        >
          <span class="btn-label">Jump</span>
          <span class="btn-key">J</span>
        </button>
        <button
          v-if="selection.hasFireControl"
          class="action-btn"
          :class="{ active: selection.fireEnabled }"
          :style="{ '--btn-color': '#ff9f5a' }"
          title="Toggle whether selected units are allowed to fire automatically"
          @click="actions.toggleSelectedFire()"
        >
          <span class="btn-label">{{ selection.fireEnabled ? 'Fire' : 'Hold' }}</span>
          <span class="btn-key">E</span>
        </button>
      </div>
    </div>

    <!-- Control group buttons -->
    <div v-if="canStoreControlGroup || hasStoredControlGroups" class="button-group">
      <div class="group-label">Groups</div>
      <div class="control-group-grid">
        <div
          v-for="slot in controlGroupSlots"
          :key="slot.index"
          class="control-group-slot"
        >
          <button
            class="group-store-btn"
            :disabled="!canStoreControlGroup"
            :title="`Store group ${slot.index + 1}`"
            @click="actions.storeControlGroup(slot.index)"
          >
            Set
          </button>
          <button
            class="group-recall-btn"
            :class="{ active: slot.active }"
            :disabled="slot.count === 0"
            :title="`Recall group ${slot.index + 1}`"
            @click="actions.recallControlGroup(slot.index, false)"
          >
            <span class="group-number">{{ slot.index + 1 }}</span>
            <span class="group-count">{{ slot.count > 0 ? slot.count : '-' }}</span>
          </button>
          <button
            class="group-add-btn"
            :disabled="slot.count === 0"
            :title="`Add group ${slot.index + 1} to selection`"
            @click="actions.recallControlGroup(slot.index, true)"
          >
            +
          </button>
        </div>
      </div>
    </div>

    <!-- Build options (for units with builder capability) -->
    <div v-if="selection.hasBuilder" class="button-group">
      <div class="group-label">Build</div>
      <div class="buttons">
        <button
          v-for="bo in buildingOptions"
          :key="bo.type"
          class="action-btn build-btn"
          :class="{ active: selection.isBuildMode && selection.selectedBuildingType === bo.type }"
          @click="selection.isBuildMode && selection.selectedBuildingType === bo.type ? actions.cancelBuild() : actions.startBuild(bo.type)"
        >
          <span class="btn-label">{{ bo.label }}</span>
          <span class="btn-cost"><span class="cost-resource">{{ bo.cost }}</span></span>
          <span class="btn-key">{{ bo.key }}</span>
        </button>
      </div>
    </div>

    <!-- Commander specials -->
    <div v-if="selection.hasDGun || selection.hasCommander" class="button-group">
      <div class="group-label">Special</div>
      <div class="buttons">
        <button
          v-if="selection.hasDGun"
          class="action-btn dgun-btn"
          :class="{ active: selection.isDGunMode }"
          @click="actions.toggleDGun()"
        >
          <span class="btn-label">D-Gun</span>
          <span class="btn-cost"><span class="cost-energy">200E</span></span>
          <span class="btn-key">D</span>
        </button>
        <button
          v-if="selection.hasCommander"
          class="action-btn"
          :class="{ active: selection.isRepairAreaMode }"
          :style="{ '--btn-color': '#63e7ff' }"
          title="Toggle area repair targeting for the selected commander"
          @click="actions.toggleRepairArea()"
        >
          <span class="btn-label">Repair</span>
          <span class="btn-key">R</span>
        </button>
        <button
          v-if="selection.hasCommander"
          class="action-btn"
          :class="{ active: selection.isReclaimMode }"
          :style="{ '--btn-color': '#d6b45f' }"
          title="Toggle reclaim targeting for the selected commander"
          @click="actions.toggleReclaim()"
        >
          <span class="btn-label">Reclaim</span>
          <span class="btn-key">C</span>
        </button>
      </div>
    </div>

    <!-- Vehicle production (for factory) -->
    <div v-if="selection.hasFactory && selection.factoryId" class="button-group">
      <div class="group-label">Vehicles</div>
      <div class="buttons">
        <button
          v-for="uo in vehicleOptions"
          :key="uo.unitId"
          class="action-btn produce-btn vehicle-btn"
          :class="{ active: selectedBuildUnitId === uo.unitId }"
          @click="actions.queueUnit(selection.factoryId!, uo.unitId)"
        >
          <span class="btn-label">{{ uo.label }}</span>
          <span class="btn-cost"><span class="cost-resource">{{ uo.cost }}</span></span>
        </button>
      </div>
    </div>

    <!-- Bot production (for factory) -->
    <div v-if="selection.hasFactory && selection.factoryId" class="button-group">
      <div class="group-label">Bots</div>
      <div class="buttons">
        <button
          v-for="uo in botOptions"
          :key="uo.unitId"
          class="action-btn produce-btn bot-btn"
          :class="{ active: selectedBuildUnitId === uo.unitId }"
          @click="actions.queueUnit(selection.factoryId!, uo.unitId)"
        >
          <span class="btn-label">{{ uo.label }}</span>
          <span class="btn-cost"><span class="cost-resource">{{ uo.cost }}</span></span>
        </button>
      </div>
    </div>

    <!-- Message area (always present to prevent modal resize) -->
    <div class="message-area">
      <span v-if="selection.isBuildMode || selection.isDGunMode || selection.isRepairAreaMode || selection.isAttackAreaMode || selection.isAttackGroundMode || selection.isGuardMode || selection.isReclaimMode">
        Press ESC or Right-click to cancel
      </span>
      <span v-else>&nbsp;</span>
    </div>
  </div>
</template>

<style scoped>
/* Base panel styles — aligned with the bottom-bar aesthetic
 * (dark semi-transparent base + muted gray border). Rounded
 * corners stay so the panel still reads as a discrete card. */
.options-panel {
  position: absolute;
  bottom: 20px;
  left: 20px;
  background: rgba(15, 18, 24, 0.92);
  border: 1px solid #444;
  border-radius: 8px;
  padding: 12px;
  min-width: 200px;
  font-family: monospace;
  color: white;
  pointer-events: auto;
  z-index: 1000;
}

.panel-header {
  font-size: 14px;
  font-weight: bold;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
}

.unit-type.commander {
  color: #ffd700;
}

.unit-type.factory {
  color: #88ff88;
}

.button-group {
  margin-bottom: 10px;
}

.group-label {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 4px;
  text-transform: uppercase;
}

.modifier-hint {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.4);
  text-transform: none;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.control-group-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(108px, 1fr));
  gap: 6px;
}

.control-group-slot {
  display: grid;
  grid-template-columns: 34px minmax(36px, 1fr) 28px;
  gap: 3px;
  align-items: stretch;
}

.group-store-btn,
.group-recall-btn,
.group-add-btn {
  height: 36px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  color: white;
  font-family: monospace;
  cursor: pointer;
  transition: all 0.15s ease;
}

.group-store-btn {
  font-size: 10px;
  padding: 0;
}

.group-recall-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0;
  --btn-color: #8fd2ff;
}

.group-add-btn {
  font-size: 16px;
  line-height: 1;
  padding: 0;
}

.group-store-btn:hover:not(:disabled),
.group-recall-btn:hover:not(:disabled),
.group-add-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.2);
  border-color: #8fd2ff;
}

.group-recall-btn.active {
  background: rgba(143, 210, 255, 0.24);
  border-color: #8fd2ff;
  box-shadow: 0 0 8px rgba(143, 210, 255, 0.7);
}

.group-store-btn:disabled,
.group-recall-btn:disabled,
.group-add-btn:disabled {
  opacity: 0.38;
  cursor: default;
}

.group-number {
  font-size: 13px;
  font-weight: bold;
}

.group-count {
  margin-top: 1px;
  font-size: 9px;
  color: rgba(255, 255, 255, 0.65);
}

.action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  color: white;
  font-family: monospace;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  min-width: 60px;
  --btn-color: #888888;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  border-color: var(--btn-color);
}

.action-btn.active {
  background: rgba(255, 255, 255, 0.25);
  border-color: var(--btn-color);
  box-shadow: 0 0 8px var(--btn-color);
}

.btn-label {
  font-weight: bold;
}

.btn-cost {
  font-size: 10px;
  margin-top: 2px;
}

.cost-energy {
  color: #ffcc00;
}

.cost-mana {
  color: #44aaff;
}

/* Unified resource cost (energy + mana + metal — same number from each pool). */
.cost-resource {
  color: #c8c8d8;
}

.btn-key {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.5);
  margin-top: 2px;
}

.build-btn {
  --btn-color: #00cc00;
}

.dgun-btn {
  --btn-color: #ff6600;
}

.produce-btn.vehicle-btn {
  --btn-color: #0088ff;
}

.produce-btn.bot-btn {
  --btn-color: #88ff00;
}

.message-area {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.5);
  margin-top: 8px;
  text-align: center;
  min-height: 14px;
}

</style>
