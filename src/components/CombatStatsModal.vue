<script setup lang="ts">
import { computed, ref } from 'vue';
import type { NetworkServerSnapshotCombatStats } from '../game/network/NetworkTypes';
import type { FriendlyFireMode, StatsSnapshot } from './combatStatsUtils';
import CombatStatsGraph from './CombatStatsGraph.vue';

const props = defineProps<{
  visible: boolean;
  stats: NetworkServerSnapshotCombatStats | null;
  viewMode: 'global' | 'player';
  statsHistory: StatsSnapshot[];
}>();

const emit = defineEmits<{
  (e: 'update:viewMode', mode: 'global' | 'player'): void;
  (e: 'close'): void;
}>();

const selectedPlayer = ref(1);

// Friendly fire handling: include, ignore, or subtract team damage/kills
const teamDamageMode = ref<FriendlyFireMode>('subHalf');
const teamKillsMode = ref<FriendlyFireMode>('subHalf');

const playerIds = computed(() => {
  if (!props.stats) return [];
  return Object.keys(props.stats.players).map(Number).sort();
});
</script>

<template>
  <div v-if="visible && stats" class="combat-stats-overlay" @click.self="$emit('close')">
    <div class="combat-stats-modal">
      <div class="modal-header">
        <h2>Combat Statistics</h2>
        <div class="header-controls">
          <div class="btn-group">
            <button
              :class="{ active: viewMode === 'global' }"
              @click="emit('update:viewMode', 'global')"
              data-tip="Aggregate across all players"
            >All</button>
            <button
              :class="{ active: viewMode === 'player' }"
              @click="emit('update:viewMode', 'player')"
              data-tip="Single player stats"
            >P{{ selectedPlayer }}</button>
          </div>
          <select
            v-if="viewMode === 'player'"
            v-model="selectedPlayer"
            class="player-select"
          >
            <option v-for="pid in playerIds" :key="pid" :value="pid">P{{ pid }}</option>
          </select>

          <div class="norm-control">
            <span class="control-label" data-tip="Friendly fire damage handling">FF Dmg:</span>
            <div class="btn-group">
              <button
                :class="{ active: teamDamageMode === 'include' }"
                @click="teamDamageMode = 'include'"
                data-tip="Enemy + friendly damage"
              >+</button>
              <button
                :class="{ active: teamDamageMode === 'ignore' }"
                @click="teamDamageMode = 'ignore'"
                data-tip="Enemy damage only"
              >0</button>
              <button
                :class="{ active: teamDamageMode === 'subHalf' }"
                @click="teamDamageMode = 'subHalf'"
                data-tip="Enemy − ½ friendly damage"
              >−½</button>
              <button
                :class="{ active: teamDamageMode === 'subtract' }"
                @click="teamDamageMode = 'subtract'"
                data-tip="Enemy − friendly damage"
              >−1</button>
            </div>
          </div>

          <div class="norm-control">
            <span class="control-label" data-tip="Friendly fire kills handling">FF Kills:</span>
            <div class="btn-group">
              <button
                :class="{ active: teamKillsMode === 'include' }"
                @click="teamKillsMode = 'include'"
                data-tip="Enemy + friendly kills"
              >+</button>
              <button
                :class="{ active: teamKillsMode === 'ignore' }"
                @click="teamKillsMode = 'ignore'"
                data-tip="Enemy kills only"
              >0</button>
              <button
                :class="{ active: teamKillsMode === 'subHalf' }"
                @click="teamKillsMode = 'subHalf'"
                data-tip="Enemy − ½ friendly kills"
              >−½</button>
              <button
                :class="{ active: teamKillsMode === 'subtract' }"
                @click="teamKillsMode = 'subtract'"
                data-tip="Enemy − friendly kills"
              >−1</button>
            </div>
          </div>
        </div>
      </div>

      <CombatStatsGraph
        :history="statsHistory"
        :view-mode="viewMode"
        :selected-player="selectedPlayer"
        :team-damage-mode="teamDamageMode"
        :team-kills-mode="teamKillsMode"
      />

      <div class="modal-footer">
        Press <kbd>`</kbd> to toggle
      </div>
    </div>
  </div>
</template>

<style scoped>
.combat-stats-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2500;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}

.combat-stats-modal {
  background: rgba(10, 12, 18, 0.95);
  border: 1px solid rgba(100, 120, 160, 0.4);
  border-radius: 10px;
  padding: 28px 32px;
  min-width: 900px;
  max-width: 96vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  font-family: 'Courier New', monospace;
  font-size: 16px;
  color: #c8d0e0;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  flex-wrap: wrap;
  gap: 12px;
}

.modal-header h2 {
  margin: 0;
  font-size: 24px;
  color: #e0e8f0;
}

.header-controls {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}

/* ---- Connected button group ---- */
.btn-group {
  display: flex;
}

.btn-group button {
  padding: 6px 16px;
  background: rgba(50, 58, 78, 0.7);
  border: 1px solid rgba(90, 105, 140, 0.45);
  color: #8898b4;
  cursor: pointer;
  font-size: 14px;
  font-family: 'Courier New', monospace;
  transition: background 0.1s, color 0.1s;
  border-radius: 0;
  margin-left: -1px;
}

.btn-group button:first-child {
  border-radius: 5px 0 0 5px;
  margin-left: 0;
}

.btn-group button:last-child {
  border-radius: 0 5px 5px 0;
}

.btn-group button:hover {
  background: rgba(65, 78, 105, 0.7);
  color: #b0bcd0;
}

.btn-group button.active {
  background: rgba(70, 95, 150, 0.65);
  color: #e0e8f0;
  border-color: rgba(100, 140, 210, 0.6);
  z-index: 1;
  position: relative;
}

.norm-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.control-label {
  color: #7888a0;
  font-size: 14px;
  white-space: nowrap;
}

.player-select {
  padding: 5px 10px;
  background: rgba(40, 50, 70, 0.8);
  border: 1px solid rgba(90, 105, 140, 0.45);
  border-radius: 5px;
  color: #c8d0e0;
  font-size: 14px;
  font-family: 'Courier New', monospace;
}

.modal-footer {
  margin-top: 14px;
  text-align: center;
  color: #606878;
  font-size: 14px;
}

kbd {
  padding: 2px 7px;
  background: rgba(60, 70, 90, 0.5);
  border: 1px solid rgba(80, 90, 110, 0.5);
  border-radius: 3px;
  font-size: 14px;
}

/* ---- Custom tooltips via data-tip ---- */
[data-tip] {
  position: relative;
}

[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 12px;
  background: rgba(20, 24, 36, 0.97);
  border: 1px solid rgba(100, 120, 160, 0.5);
  border-radius: 6px;
  color: #c8d0e0;
  font-size: 14px;
  font-weight: normal;
  line-height: 1.4;
  white-space: normal;
  max-width: 320px;
  width: max-content;
  text-align: left;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 100;
  margin-bottom: 6px;
}

[data-tip]:hover::after {
  opacity: 1;
}
</style>
