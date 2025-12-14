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

const waypointModes: { mode: WaypointType; label: string; key: string; color: string }[] = [
  { mode: 'move', label: 'Move', key: 'M', color: '#00ff00' },
  { mode: 'fight', label: 'Fight', key: 'F', color: '#ff4444' },
  { mode: 'patrol', label: 'Patrol', key: 'H', color: '#0088ff' },
];

const buildingOptions: { type: 'solar' | 'factory'; label: string; key: string; cost: number }[] = [
  { type: 'solar', label: 'Solar', key: '1', cost: 150 },
  { type: 'factory', label: 'Factory', key: '2', cost: 400 },
];

const unitOptions: { weaponId: string; label: string; cost: number }[] = [
  { weaponId: 'minigun', label: 'Minigun', cost: 100 },
  { weaponId: 'laser', label: 'Laser', cost: 150 },
  { weaponId: 'cannon', label: 'Cannon', cost: 200 },
  { weaponId: 'shotgun', label: 'Shotgun', cost: 120 },
];
</script>

<template>
  <div v-if="showPanel" class="selection-panel">
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
          <span class="btn-key">G</span>
        </button>
      </div>
    </div>

    <!-- Unit production (for factory) -->
    <div v-if="selection.hasFactory && selection.factoryId" class="button-group">
      <div class="group-label">Produce</div>
      <div class="buttons">
        <button
          v-for="uo in unitOptions"
          :key="uo.weaponId"
          class="action-btn produce-btn"
          @click="actions.queueUnit(selection.factoryId!, uo.weaponId)"
        >
          <span class="btn-label">{{ uo.label }}</span>
          <span class="btn-cost">{{ uo.cost }}E</span>
        </button>
      </div>
    </div>

    <!-- Production queue display (for factory) -->
    <div v-if="selection.hasFactory && selection.factoryQueue && selection.factoryQueue.length > 0" class="queue-section">
      <div class="group-label">Queue ({{ selection.factoryQueue.length }})</div>

      <!-- Current production progress bar -->
      <div v-if="selection.factoryIsProducing" class="progress-bar">
        <div class="progress-fill" :style="{ width: (selection.factoryProgress ?? 0) * 100 + '%' }"></div>
        <span class="progress-label">{{ selection.factoryQueue[0]?.label }}</span>
      </div>

      <!-- Queue items -->
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

    <!-- Cancel hint when in build/dgun mode -->
    <div v-if="selection.isBuildMode || selection.isDGunMode" class="cancel-hint">
      Press ESC or Right-click to cancel
    </div>
  </div>
</template>

<style scoped>
.selection-panel {
  position: absolute;
  bottom: 20px;
  left: 20px;
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

.produce-btn {
  --btn-color: #0088ff;
}

.cancel-hint {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.5);
  margin-top: 8px;
  text-align: center;
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
  flex-wrap: wrap;
  gap: 4px;
  max-height: 80px;
  overflow-y: auto;
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
