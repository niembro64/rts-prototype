<script setup lang="ts">
import { computed } from 'vue';
import type { WaypointType } from '../game/sim/types';
import {
  buildingRosterDisplay,
  unitRosterDisplay,
} from '../game/sim/blueprints/displayRosters';

export type { QueueItem, SelectionInfo, SelectionActions } from '@/types/ui';
import type { SelectionInfo, SelectionActions } from '@/types/ui';

const props = defineProps<{
  selection: SelectionInfo;
  actions: SelectionActions;
}>();

const showPanel = computed(() => props.selection.unitCount > 0 || props.selection.hasFactory);

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

    <!-- D-Gun (for units with d-gun capability) -->
    <div v-if="selection.hasDGun" class="button-group">
      <div class="group-label">Special</div>
      <div class="buttons">
        <button
          class="action-btn dgun-btn"
          :class="{ active: selection.isDGunMode }"
          @click="actions.toggleDGun()"
        >
          <span class="btn-label">D-Gun</span>
          <span class="btn-cost"><span class="cost-energy">200E</span></span>
          <span class="btn-key">D</span>
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
      <span v-if="selection.isBuildMode || selection.isDGunMode">
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
