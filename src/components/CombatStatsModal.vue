<script setup lang="ts">
import { computed, ref } from 'vue';
import type { NetworkCombatStats, NetworkUnitTypeStats } from '../game/network/NetworkTypes';
import { UNIT_DEFINITIONS } from '../game/sim/unitDefinitions';
import { UNIT_STATS } from '../config';
import { getUnitValue, type UnitValuation } from '../game/sim/unitValuation';
import { type FriendlyFireMode, type StatsSnapshot, applyFriendlyFire } from './combatStatsUtils';
import CombatStatsGraph from './CombatStatsGraph.vue';

const props = defineProps<{
  visible: boolean;
  stats: NetworkCombatStats | null;
  viewMode: 'global' | 'player';
  statsHistory: StatsSnapshot[];
}>();

const emit = defineEmits<{
  (e: 'update:viewMode', mode: 'global' | 'player'): void;
}>();

const selectedPlayer = ref(1);
const displayMode = ref<'table' | 'graph'>('graph');

// Continuous cost exponent for normalization.
// Formula: metric / (produced × cost^α)
//   α = 0  → Per Unit (raw per-capita)
//   α = 1  → Per Cost (linear efficiency, 1v1 duels)
//   α = 2  → Lanchester (square law, pure deathball)
const costExponent = ref(1.5);

// Friendly fire handling: include, ignore, or subtract team damage/kills
const teamDamageMode = ref<FriendlyFireMode>('subtract');
const teamKillsMode = ref<FriendlyFireMode>('subtract');

// Build unit type list from definitions (excluding commander)
const unitTypes = computed(() => {
  return Object.keys(UNIT_DEFINITIONS).filter(id => id !== 'commander');
});

interface RowData {
  unitType: string;
  name: string;
  cost: number;
  produced: number;
  lost: number;
  survivalPct: number;
  costSpent: number;
  damageDealt: number;
  kills: number;
  normDmg: number;
  normKills: number;
  weaponVal: number;
  defVal: number;
  mobVal: number;
  suggestedCost: number;
  costDeltaPct: number;
}

function buildRow(unitType: string, s: NetworkUnitTypeStats | undefined, val: UnitValuation, cost: number, alpha: number, dmgMode: FriendlyFireMode, killMode: FriendlyFireMode): RowData {
  const produced = s?.unitsProduced ?? 0;
  const lost = s?.unitsLost ?? 0;
  const costSpent = s?.totalCostSpent ?? 0;
  const damageDealt = applyFriendlyFire(s?.enemyDamageDealt ?? 0, s?.friendlyDamageDealt ?? 0, dmgMode);
  const kills = applyFriendlyFire(s?.enemyKills ?? 0, s?.friendlyKills ?? 0, killMode);

  // Normalize: ÷ (produced × cost^α)
  // Scale factor keeps numbers readable across the exponent range
  const costPow = Math.pow(cost, alpha);
  const divisor = produced * costPow;
  const scale = Math.pow(100, alpha);
  const normDmg = divisor > 0 ? (damageDealt / divisor) * scale : 0;
  const normKills = divisor > 0 ? (kills / divisor) * scale : 0;

  return {
    unitType,
    name: UNIT_DEFINITIONS[unitType]?.name ?? unitType,
    cost,
    produced,
    lost,
    survivalPct: produced > 0 ? ((produced - lost) / produced) * 100 : 0,
    costSpent,
    damageDealt: Math.round(damageDealt),
    kills,
    normDmg,
    normKills,
    weaponVal: Math.round(val.weaponValue * 10) / 10,
    defVal: Math.round(val.defensiveValue * 10) / 10,
    mobVal: Math.round(val.mobilityValue * 100) / 100,
    suggestedCost: val.suggestedCost,
    costDeltaPct: cost > 0 ? ((val.suggestedCost - cost) / cost) * 100 : 0,
  };
}

const rows = computed<RowData[]>(() => {
  if (!props.stats) return [];

  const data = props.viewMode === 'global'
    ? props.stats.global
    : props.stats.players[selectedPlayer.value] ?? {};

  return unitTypes.value.map(ut => {
    const def = UNIT_DEFINITIONS[ut];
    if (!def) return null;
    const cost = def.energyCost;
    let val: UnitValuation;
    try { val = getUnitValue(ut); } catch { return null; }
    return buildRow(ut, data[ut], val, cost, costExponent.value, teamDamageMode.value, teamKillsMode.value);
  }).filter((r): r is RowData => r !== null)
    .sort((a, b) => a.cost - b.cost);
});

// Compute column min/max for color scaling
function getColumnRange(key: keyof RowData): { min: number; max: number } {
  const vals = rows.value.map(r => r[key] as number).filter(v => v > 0);
  if (vals.length === 0) return { min: 0, max: 1 };
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

// Continuous gradient: red (0) -> yellow (0.5) -> green (1)
function gradientColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const r = clamped < 0.5 ? 255 : Math.round(255 * (1 - (clamped - 0.5) * 2));
  const g = clamped < 0.5 ? Math.round(255 * clamped * 2) : 255;
  return `rgb(${r}, ${g}, 60)`;
}

function cellColor(value: number, key: keyof RowData, invert = false): string {
  if (value === 0) return 'transparent';
  const range = getColumnRange(key);
  if (range.max === range.min) return gradientColor(0.5);
  let t = (value - range.min) / (range.max - range.min);
  if (invert) t = 1 - t;
  return gradientColor(t);
}

function costDeltaColor(pct: number): string {
  const t = Math.max(0, Math.min(1, (pct + 50) / 100));
  return gradientColor(t);
}

const playerIds = computed(() => {
  if (!props.stats) return [];
  return Object.keys(props.stats.players).map(Number).sort();
});

// Column header label based on exponent
const normDmgLabel = computed(() => `Dmg / Cost^${costExponent.value.toFixed(3)}`);
const normKillsLabel = computed(() => `Kills / Cost^${costExponent.value.toFixed(3)}`);

function fmt(n: number, decimals = 0): string {
  if (n === 0) return '-';
  return decimals > 0 ? n.toFixed(decimals) : Math.round(n).toString();
}
</script>

<template>
  <div v-if="visible && stats" class="combat-stats-overlay" @click.self="$emit('close')">
    <div class="combat-stats-modal">
      <div class="modal-header">
        <h2>Combat Statistics</h2>
        <div class="header-controls">
          <div class="btn-group">
            <button
              :class="{ active: displayMode === 'table' }"
              @click="displayMode = 'table'"
              data-tip="Show stats as a sortable table"
            >Table</button>
            <button
              :class="{ active: displayMode === 'graph' }"
              @click="displayMode = 'graph'"
              data-tip="Show stats as a time-series graph"
            >Graph</button>
          </div>
          <div class="btn-group">
            <button
              :class="{ active: viewMode === 'global' }"
              @click="emit('update:viewMode', 'global')"
              data-tip="Aggregate stats across all players"
            >Global</button>
            <button
              :class="{ active: viewMode === 'player' }"
              @click="emit('update:viewMode', 'player')"
              data-tip="Show stats for a single player"
            >Per Player</button>
          </div>
          <select
            v-if="viewMode === 'player'"
            v-model="selectedPlayer"
            class="player-select"
          >
            <option v-for="pid in playerIds" :key="pid" :value="pid">Player {{ pid }}</option>
          </select>

          <div class="norm-control">
            <span class="control-label">Normalize:</span>
            <div class="btn-group">
              <button
                :class="{ active: costExponent === 0 }"
                @click="costExponent = 0"
                data-tip="alpha=0: raw per-capita (divide by unit count only, ignore cost)"
              >Per Unit</button>
              <button
                :class="{ active: costExponent === 1 }"
                @click="costExponent = 1"
                data-tip="alpha=1: linear cost efficiency (fair for 1v1 duels)"
              >Linear</button>
              <button
                :class="{ active: costExponent === 2 }"
                @click="costExponent = 2"
                data-tip="alpha=2: Lanchester square law (rewards cheap units in large battles)"
              >Lanchester</button>
            </div>
            <div class="slider-row">
              <input
                type="range"
                min="0"
                max="2"
                step="0.025"
                :value="costExponent"
                @input="costExponent = parseFloat(($event.target as HTMLInputElement).value)"
                class="exponent-slider"
              />
              <span class="slider-label">cost^{{ costExponent.toFixed(3) }}</span>
            </div>
          </div>

          <div class="norm-control">
            <span class="control-label" data-tip="How to handle damage dealt to friendly units">Team Dmg:</span>
            <div class="btn-group">
              <button
                :class="{ active: teamDamageMode === 'ignore' }"
                @click="teamDamageMode = 'ignore'"
                data-tip="Only count damage dealt to enemies"
              >Ignore</button>
              <button
                :class="{ active: teamDamageMode === 'include' }"
                @click="teamDamageMode = 'include'"
                data-tip="Count enemy + friendly damage together"
              >Include</button>
              <button
                :class="{ active: teamDamageMode === 'subtract' }"
                @click="teamDamageMode = 'subtract'"
                data-tip="Enemy damage minus friendly fire damage (penalizes splash)"
              >Subtract</button>
            </div>
          </div>

          <div class="norm-control">
            <span class="control-label" data-tip="How to handle kills of friendly units">Team Kills:</span>
            <div class="btn-group">
              <button
                :class="{ active: teamKillsMode === 'ignore' }"
                @click="teamKillsMode = 'ignore'"
                data-tip="Only count enemy kills"
              >Ignore</button>
              <button
                :class="{ active: teamKillsMode === 'include' }"
                @click="teamKillsMode = 'include'"
                data-tip="Count enemy + friendly kills together"
              >Include</button>
              <button
                :class="{ active: teamKillsMode === 'subtract' }"
                @click="teamKillsMode = 'subtract'"
                data-tip="Enemy kills minus friendly kills (penalizes splash)"
              >Subtract</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Graph view -->
      <CombatStatsGraph
        v-if="displayMode === 'graph'"
        :history="statsHistory"
        :view-mode="viewMode"
        :selected-player="selectedPlayer"
        :cost-exponent="costExponent"
        :team-damage-mode="teamDamageMode"
        :team-kills-mode="teamKillsMode"
      />

      <div v-else class="table-scroll">
        <table>
          <thead>
            <tr>
              <th data-tip="Unit type name">Unit</th>
              <th data-tip="Energy cost to build one unit">Cost</th>
              <th data-tip="Total units of this type built">Produced</th>
              <th data-tip="Total units of this type destroyed">Lost</th>
              <th data-tip="Percentage of produced units still alive: (produced - lost) / produced">Survival %</th>
              <th data-tip="Total energy spent building this unit type: produced x cost">Total $ Spent</th>
              <th data-tip="Total HP damage dealt to enemies (adjusted by Team Dmg mode)">Total Dmg</th>
              <th data-tip="Total enemy units killed (adjusted by Team Kills mode)">Total Kills</th>
              <th :data-tip="`Damage efficiency: damage / (produced x cost^${costExponent.toFixed(3)}), scaled by 100^alpha`">{{ normDmgLabel }}</th>
              <th :data-tip="`Kill efficiency: kills / (produced x cost^${costExponent.toFixed(3)}), scaled by 100^alpha`">{{ normKillsLabel }}</th>
              <th data-tip="Weapon valuation score based on DPS, range, and projectile stats">Wpn Val</th>
              <th data-tip="Defensive valuation score based on HP, armor, and evasion">Def Val</th>
              <th data-tip="Mobility valuation score based on speed and turn rate">Mob Val</th>
              <th data-tip="Cost suggested by the valuation model (wpn x def x mob)">Suggested $</th>
              <th data-tip="Difference between suggested cost and actual cost, as a percentage">Cost Delta %</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.unitType">
              <td class="unit-name">{{ row.name }}</td>
              <td>{{ row.cost }}</td>
              <td>{{ fmt(row.produced) }}</td>
              <td>{{ fmt(row.lost) }}</td>
              <td :style="{ backgroundColor: cellColor(row.survivalPct, 'survivalPct') }">
                {{ fmt(row.survivalPct, 0) }}{{ row.produced > 0 ? '%' : '' }}
              </td>
              <td>{{ fmt(row.costSpent) }}</td>
              <td :style="{ backgroundColor: cellColor(row.damageDealt, 'damageDealt') }">
                {{ fmt(row.damageDealt) }}
              </td>
              <td :style="{ backgroundColor: cellColor(row.kills, 'kills') }">
                {{ fmt(row.kills) }}
              </td>
              <td :style="{ backgroundColor: cellColor(row.normDmg, 'normDmg') }">
                {{ fmt(row.normDmg, 3) }}
              </td>
              <td :style="{ backgroundColor: cellColor(row.normKills, 'normKills') }">
                {{ fmt(row.normKills, 3) }}
              </td>
              <td>{{ row.weaponVal }}</td>
              <td>{{ row.defVal }}</td>
              <td>{{ row.mobVal }}</td>
              <td>{{ row.suggestedCost }}</td>
              <td :style="{ backgroundColor: costDeltaColor(row.costDeltaPct) }">
                {{ row.costDeltaPct >= 0 ? '+' : '' }}{{ fmt(row.costDeltaPct, 0) }}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>

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
  /* Remove rounding between siblings */
  border-radius: 0;
  margin-left: -1px; /* collapse shared borders */
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
  z-index: 1; /* active border on top of neighbors */
  position: relative;
}

/* ---- Normalization control row ---- */
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

.slider-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
}

.slider-label {
  color: #90a0b8;
  font-size: 13px;
  min-width: 68px;
  text-align: left;
  font-variant-numeric: tabular-nums;
}

.exponent-slider {
  width: 100px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(80, 100, 140, 0.35);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.exponent-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #90b0e0;
  border: 2px solid rgba(140, 170, 220, 0.6);
  cursor: pointer;
}

.exponent-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #90b0e0;
  border: 2px solid rgba(140, 170, 220, 0.6);
  cursor: pointer;
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

.table-scroll {
  overflow: auto;
  flex: 1;
}

table {
  border-collapse: collapse;
  width: 100%;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

th, td {
  padding: 10px 14px;
  text-align: right;
  border-bottom: 1px solid rgba(60, 70, 90, 0.4);
}

th {
  position: sticky;
  top: 0;
  background: rgba(20, 25, 35, 0.98);
  color: #8090a8;
  font-weight: normal;
  font-size: 14px;
  border-bottom: 2px solid rgba(80, 100, 140, 0.4);
}

td.unit-name {
  text-align: left;
  color: #e0e8f0;
  font-weight: bold;
  font-size: 17px;
}

tr:hover td {
  background-color: rgba(60, 80, 120, 0.2) !important;
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
