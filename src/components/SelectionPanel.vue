<script setup lang="ts">
import { computed } from 'vue';
import type { WaypointType } from '../game/sim/types';

// Factory queue item
export interface QueueItem {
  weaponId: string;
  label: string;
}

// Selection info passed from game
export interface SelectionInfo {
  unitCount: number;
  hasCommander: boolean;
  hasFactory: boolean;
  factoryId?: number;
  commanderId?: number;
  waypointMode: WaypointType;
  isBuildMode: boolean;
  selectedBuildingType: string | null;
  isDGunMode: boolean;
  // Factory production info
  factoryQueue?: QueueItem[];
  factoryProgress?: number;
  factoryIsProducing?: boolean;
}

// Action callbacks
export interface SelectionActions {
  setWaypointMode: (mode: WaypointType) => void;
  startBuild: (buildingType: 'solar' | 'factory') => void;
  cancelBuild: () => void;
  toggleDGun: () => void;
  queueUnit: (factoryId: number, weaponId: string) => void;
  cancelQueueItem: (factoryId: number, index: number) => void;
}

const props = defineProps<{
  selection: SelectionInfo;
  actions: SelectionActions;
}>();

const showPanel = computed(() => props.selection.unitCount > 0 || props.selection.hasFactory);

// Status panel shows when factory has a queue
const showStatusPanel = computed(() =>
  props.selection.hasFactory &&
  props.selection.factoryQueue &&
  props.selection.factoryQueue.length > 0
);

const waypointModes: { mode: WaypointType; label: string; key: string; color: string }[] = [
  { mode: 'move', label: 'Move', key: 'M', color: '#00ff00' },
  { mode: 'fight', label: 'Fight', key: 'F', color: '#ff4444' },
  { mode: 'patrol', label: 'Patrol', key: 'H', color: '#0088ff' },
];

const buildingOptions: { type: 'solar' | 'factory'; label: string; key: string; cost: number }[] = [
  { type: 'solar', label: 'Solar', key: '1', cost: 150 },
  { type: 'factory', label: 'Factory', key: '2', cost: 400 },
];

// Vehicles (treads/wheels)
const vehicleOptions: { weaponId: string; label: string; cost: number }[] = [
  { weaponId: 'scout', label: 'Scout', cost: 35 },
  { weaponId: 'burst', label: 'Burst', cost: 75 },
  { weaponId: 'brawl', label: 'Brawl', cost: 110 },
  { weaponId: 'snipe', label: 'Snipe', cost: 140 },
  { weaponId: 'shotgun', label: 'Shotgun', cost: 150 },
  { weaponId: 'tank', label: 'Tank', cost: 280 },
];

// Bots (legs)
const botOptions: { weaponId: string; label: string; cost: number }[] = [
  { weaponId: 'insect', label: 'Insect', cost: 90 },
  { weaponId: 'daddy', label: 'Daddy', cost: 100 },
  { weaponId: 'widow', label: 'Widow', cost: 1000 },
];

// Queue units with modifier key support (Shift=5, Ctrl=100)
function queueUnitsWithModifier(event: MouseEvent, factoryId: number, weaponId: string) {
  let count = 1;
  if (event.ctrlKey) {
    count = 100;
  } else if (event.shiftKey) {
    count = 5;
  }

  for (let i = 0; i < count; i++) {
    props.actions.queueUnit(factoryId, weaponId);
  }
}
</script>

<template>
  <!-- OPTIONS PANEL (left side) -->
  <div v-if="showPanel" class="options-panel">
    <!-- Unit count display -->
    <div class="panel-header">
      <span v-if="selection.hasCommander" class="unit-type commander">Commander</span>
      <span v-else-if="selection.hasFactory" class="unit-type factory">Factory</span>
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

    <!-- Build options (for commander) -->
    <div v-if="selection.hasCommander" class="button-group">
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
          <span class="btn-cost">{{ bo.cost }}E</span>
          <span class="btn-key">{{ bo.key }}</span>
        </button>
      </div>
    </div>

    <!-- D-Gun (for commander) -->
    <div v-if="selection.hasCommander" class="button-group">
      <div class="group-label">Special</div>
      <div class="buttons">
        <button
          class="action-btn dgun-btn"
          :class="{ active: selection.isDGunMode }"
          @click="actions.toggleDGun()"
        >
          <span class="btn-label">D-Gun</span>
          <span class="btn-cost">200E</span>
          <span class="btn-key">D</span>
        </button>
      </div>
    </div>

    <!-- Vehicle production (for factory) -->
    <div v-if="selection.hasFactory && selection.factoryId" class="button-group">
      <div class="group-label">Vehicles <span class="modifier-hint">(Shift=5, Ctrl=100)</span></div>
      <div class="buttons">
        <button
          v-for="uo in vehicleOptions"
          :key="uo.weaponId"
          class="action-btn produce-btn vehicle-btn"
          @click="queueUnitsWithModifier($event, selection.factoryId!, uo.weaponId)"
        >
          <span class="btn-label">{{ uo.label }}</span>
          <span class="btn-cost">{{ uo.cost }}E</span>
        </button>
      </div>
    </div>

    <!-- Bot production (for factory) -->
    <div v-if="selection.hasFactory && selection.factoryId" class="button-group">
      <div class="group-label">Bots</div>
      <div class="buttons">
        <button
          v-for="uo in botOptions"
          :key="uo.weaponId"
          class="action-btn produce-btn bot-btn"
          @click="queueUnitsWithModifier($event, selection.factoryId!, uo.weaponId)"
        >
          <span class="btn-label">{{ uo.label }}</span>
          <span class="btn-cost">{{ uo.cost }}E</span>
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

  <!-- STATUS PANEL (right side) - shows queue and production status -->
  <div v-if="showStatusPanel" class="status-panel">
    <div class="panel-header">
      <span class="status-title">Production Status</span>
    </div>

    <!-- Current production progress bar -->
    <div v-if="selection.factoryIsProducing" class="progress-section">
      <div class="group-label">Building</div>
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: (selection.factoryProgress ?? 0) * 100 + '%' }"></div>
        <span class="progress-label">{{ selection.factoryQueue?.[0]?.label }}</span>
      </div>
    </div>

    <!-- Queue items -->
    <div v-if="selection.factoryQueue && selection.factoryQueue.length > 0" class="queue-section">
      <div class="group-label">Queue ({{ selection.factoryQueue.length }})</div>
      <div class="queue-items">
        <div
          v-for="(item, index) in selection.factoryQueue"
          :key="index"
          class="queue-item"
          :class="{ 'building': index === 0 && selection.factoryIsProducing }"
          @click="actions.cancelQueueItem(selection.factoryId!, index)"
          :title="'Click to cancel ' + item.label"
        >
          <span class="queue-index">{{ index + 1 }}</span>
          <span class="queue-label">{{ item.label }}</span>
          <span class="queue-cancel">×</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Base panel styles */
.options-panel,
.status-panel {
  position: absolute;
  bottom: 20px;
  background: rgba(0, 0, 0, 0.85);
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  padding: 12px;
  min-width: 200px;
  font-family: monospace;
  color: white;
  pointer-events: auto;
  z-index: 1000;
}

/* Options panel on left */
.options-panel {
  left: 20px;
}

/* Status panel on right */
.status-panel {
  right: 20px;
  width: 220px;
  height: 280px;
  border-color: rgba(255, 204, 0, 0.4);
  display: flex;
  flex-direction: column;
}

.status-panel .panel-header {
  flex-shrink: 0;
}

.status-panel .progress-section {
  flex-shrink: 0;
}

.status-panel .queue-section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.status-panel .queue-items {
  flex: 1;
  min-height: 0;
  max-height: none;
}

.status-title {
  color: #ffcc00;
}

.progress-section {
  margin-bottom: 10px;
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
  color: #ffcc00;
  margin-top: 2px;
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

/* Queue section styles */
.queue-section {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.2);
}

.progress-bar {
  position: relative;
  height: 20px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 8px;
}

.progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: linear-gradient(90deg, #ffcc00, #ff9900);
  transition: width 0.1s ease;
}

.progress-label {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 11px;
  font-weight: bold;
  color: white;
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.8);
}

.queue-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 120px;
  overflow-y: auto;
  padding-right: 4px;
}

/* Custom scrollbar for queue */
.queue-items::-webkit-scrollbar {
  width: 6px;
}

.queue-items::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

.queue-items::-webkit-scrollbar-thumb {
  background: rgba(255, 204, 0, 0.5);
  border-radius: 3px;
}

.queue-items::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 204, 0, 0.7);
}

.queue-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}

.queue-item:hover {
  background: rgba(255, 100, 100, 0.3);
  border-color: #ff4444;
}

.queue-item.building {
  border-color: #ffcc00;
  background: rgba(255, 204, 0, 0.2);
}

.queue-index {
  font-weight: bold;
  color: rgba(255, 255, 255, 0.6);
  font-size: 10px;
}

.queue-label {
  color: white;
}

.queue-cancel {
  color: rgba(255, 255, 255, 0.4);
  font-weight: bold;
}

.queue-item:hover .queue-cancel {
  color: #ff4444;
}
</style>
