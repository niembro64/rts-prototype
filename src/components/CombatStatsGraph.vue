<script setup lang="ts">
import { computed, ref } from 'vue';
import type { NetworkUnitTypeStats } from '../game/network/NetworkTypes';
import { UNIT_DEFINITIONS } from '../game/sim/unitDefinitions';
import { type FriendlyFireMode, type StatsSnapshot, applyFriendlyFire } from './combatStatsUtils';

const props = defineProps<{
  history: StatsSnapshot[];
  viewMode: 'global' | 'player';
  selectedPlayer: number;
  costExponent: number;
  teamDamageMode: FriendlyFireMode;
  teamKillsMode: FriendlyFireMode;
}>();

type MetricKey = 'normDmg' | 'normKills' | 'damageDealt' | 'kills' | 'survivalPct' | 'produced' | 'lost' | 'costSpent';

const METRICS: { key: MetricKey; label: string; tip: string }[] = [
  { key: 'normDmg', label: 'Norm Dmg', tip: 'Damage efficiency: damage / (produced x cost^alpha), scaled by 100^alpha' },
  { key: 'normKills', label: 'Norm Kills', tip: 'Kill efficiency: kills / (produced x cost^alpha), scaled by 100^alpha' },
  { key: 'damageDealt', label: 'Total Dmg', tip: 'Total HP damage dealt (adjusted by Team Dmg mode)' },
  { key: 'kills', label: 'Total Kills', tip: 'Total enemy units killed (adjusted by Team Kills mode)' },
  { key: 'survivalPct', label: 'Survival %', tip: 'Percentage of produced units still alive: (produced - lost) / produced' },
  { key: 'produced', label: 'Produced', tip: 'Total units of this type built' },
  { key: 'lost', label: 'Lost', tip: 'Total units of this type destroyed' },
  { key: 'costSpent', label: 'Cost Spent', tip: 'Total energy spent building this unit type' },
];

const selectedMetric = ref<MetricKey>('normDmg');

// 9 distinct colors for unit types
const UNIT_COLORS: Record<string, string> = {
  jackal: '#e6194b',
  lynx: '#3cb44b',
  daddy: '#4363d8',
  badger: '#f58231',
  scorpion: '#911eb4',
  recluse: '#42d4f4',
  mammoth: '#f032e6',
  widow: '#bfef45',
  tarantula: '#fabed4',
};

const unitTypes = computed(() =>
  Object.keys(UNIT_DEFINITIONS).filter(id => id !== 'commander')
);

// Chart dimensions
const W = 800;
const H = 400;
const PAD = { top: 20, right: 120, bottom: 40, left: 60 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

function computeMetric(s: NetworkUnitTypeStats | undefined, unitType: string, metric: MetricKey): number {
  if (!s) return 0;
  const def = UNIT_DEFINITIONS[unitType];
  if (!def) return 0;
  const cost = def.energyCost;
  const produced = s.unitsProduced ?? 0;
  const lost = s.unitsLost ?? 0;
  const dmg = applyFriendlyFire(s.enemyDamageDealt ?? 0, s.friendlyDamageDealt ?? 0, props.teamDamageMode);
  const kills = applyFriendlyFire(s.enemyKills ?? 0, s.friendlyKills ?? 0, props.teamKillsMode);

  switch (metric) {
    case 'damageDealt': return dmg;
    case 'kills': return kills;
    case 'produced': return produced;
    case 'lost': return lost;
    case 'costSpent': return s.totalCostSpent ?? 0;
    case 'survivalPct': return produced > 0 ? ((produced - lost) / produced) * 100 : 0;
    case 'normDmg':
    case 'normKills': {
      const alpha = props.costExponent;
      const costPow = Math.pow(cost, alpha);
      const divisor = produced * costPow;
      const scale = Math.pow(100, alpha);
      const raw = metric === 'normDmg' ? dmg : kills;
      return divisor > 0 ? (raw / divisor) * scale : 0;
    }
  }
}

interface SeriesPoint { t: number; v: number }
interface Series { unitType: string; name: string; color: string; points: SeriesPoint[] }

const series = computed<Series[]>(() => {
  if (props.history.length === 0) return [];

  return unitTypes.value.map(ut => {
    const def = UNIT_DEFINITIONS[ut];
    const points: SeriesPoint[] = props.history.map(snap => {
      const data = props.viewMode === 'global'
        ? snap.stats.global
        : snap.stats.players[props.selectedPlayer] ?? {};
      return { t: snap.timestamp, v: computeMetric(data[ut], ut, selectedMetric.value) };
    });
    return {
      unitType: ut,
      name: def?.name ?? ut,
      color: UNIT_COLORS[ut] ?? '#888',
      points,
    };
  });
});

// Axis ranges
const xRange = computed(() => {
  if (props.history.length === 0) return { min: 0, max: 60000 };
  const times = props.history.map(s => s.timestamp);
  return { min: Math.min(...times), max: Math.max(...times) };
});

function niceStep(range: number, targetTicks: number): number {
  if (range <= 0) return 1;
  const rough = range / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  let nice: number;
  if (norm <= 1.5) nice = 1;
  else if (norm <= 3.5) nice = 2;
  else if (norm <= 7.5) nice = 5;
  else nice = 10;
  return nice * pow;
}

const yRange = computed(() => {
  let max = 0;
  for (const s of series.value) {
    for (const p of s.points) {
      if (p.v > max) max = p.v;
    }
  }
  if (max === 0) max = 1;
  // Round up to next nice step
  const step = niceStep(max, 5);
  return { min: 0, max: Math.ceil(max / step) * step };
});

const yTicks = computed(() => {
  const { min, max } = yRange.value;
  const step = niceStep(max - min, 5);
  const ticks: number[] = [];
  for (let v = min; v <= max + step * 0.01; v += step) {
    ticks.push(v);
  }
  return ticks;
});

const xTicks = computed(() => {
  const { min, max } = xRange.value;
  const range = max - min;
  if (range <= 0) return [0];
  const step = niceStep(range, 6);
  const ticks: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let v = start; v <= max + step * 0.01; v += step) {
    ticks.push(v);
  }
  return ticks;
});

function xToPixel(t: number): number {
  const { min, max } = xRange.value;
  const range = max - min;
  if (range <= 0) return PAD.left;
  return PAD.left + ((t - min) / range) * plotW;
}

function yToPixel(v: number): number {
  const { min, max } = yRange.value;
  const range = max - min;
  if (range <= 0) return PAD.top + plotH;
  return PAD.top + plotH - ((v - min) / range) * plotH;
}

function toPath(points: SeriesPoint[]): string {
  if (points.length === 0) return '';
  return points.map((p, i) => {
    const x = xToPixel(p.t);
    const y = yToPixel(p.v);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function fmtTime(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtVal(v: number): string {
  if (v === 0) return '0';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function fmtYTick(v: number): string {
  if (v >= 10000) return (v / 1000).toFixed(0) + 'k';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(1);
}

// Hover state
const hoverX = ref<number | null>(null);
const hoverSnapIndex = ref<number>(-1);

function onMouseMove(e: MouseEvent): void {
  const svg = (e.currentTarget as SVGSVGElement);
  const rect = svg.getBoundingClientRect();
  const svgX = ((e.clientX - rect.left) / rect.width) * W;

  if (svgX < PAD.left || svgX > PAD.left + plotW) {
    hoverX.value = null;
    hoverSnapIndex.value = -1;
    return;
  }

  hoverX.value = svgX;

  // Find closest snapshot by time
  const { min, max } = xRange.value;
  const range = max - min;
  if (range <= 0 || props.history.length === 0) {
    hoverSnapIndex.value = -1;
    return;
  }
  const t = min + ((svgX - PAD.left) / plotW) * range;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < props.history.length; i++) {
    const d = Math.abs(props.history[i].timestamp - t);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  hoverSnapIndex.value = bestIdx;
}

function onMouseLeave(): void {
  hoverX.value = null;
  hoverSnapIndex.value = -1;
}

const hoverValues = computed(() => {
  if (hoverSnapIndex.value < 0 || hoverSnapIndex.value >= props.history.length) return [];
  const snap = props.history[hoverSnapIndex.value];
  const data = props.viewMode === 'global'
    ? snap.stats.global
    : snap.stats.players[props.selectedPlayer] ?? {};
  return unitTypes.value.map(ut => {
    const def = UNIT_DEFINITIONS[ut];
    return {
      unitType: ut,
      name: def?.name ?? ut,
      color: UNIT_COLORS[ut] ?? '#888',
      value: computeMetric(data[ut], ut, selectedMetric.value),
    };
  }).filter(r => r.value !== 0).sort((a, b) => b.value - a.value);
});

const hoverTime = computed(() => {
  if (hoverSnapIndex.value < 0 || hoverSnapIndex.value >= props.history.length) return '';
  return fmtTime(props.history[hoverSnapIndex.value].timestamp);
});
</script>

<template>
  <div class="graph-container">
    <!-- Metric selector -->
    <div class="metric-selector">
      <span class="metric-label">Metric:</span>
      <div class="btn-group">
        <button
          v-for="m in METRICS"
          :key="m.key"
          :class="{ active: selectedMetric === m.key }"
          :data-tip="m.tip"
          @click="selectedMetric = m.key"
        >{{ m.label }}</button>
      </div>
    </div>

    <!-- SVG chart -->
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      preserveAspectRatio="xMidYMid meet"
      class="chart-svg"
      @mousemove="onMouseMove"
      @mouseleave="onMouseLeave"
    >
      <!-- Grid lines -->
      <line
        v-for="tick in yTicks"
        :key="'yg' + tick"
        :x1="PAD.left"
        :y1="yToPixel(tick)"
        :x2="PAD.left + plotW"
        :y2="yToPixel(tick)"
        class="grid-line"
      />
      <line
        v-for="tick in xTicks"
        :key="'xg' + tick"
        :x1="xToPixel(tick)"
        :y1="PAD.top"
        :x2="xToPixel(tick)"
        :y2="PAD.top + plotH"
        class="grid-line"
      />

      <!-- Axes -->
      <line :x1="PAD.left" :y1="PAD.top" :x2="PAD.left" :y2="PAD.top + plotH" class="axis-line" />
      <line :x1="PAD.left" :y1="PAD.top + plotH" :x2="PAD.left + plotW" :y2="PAD.top + plotH" class="axis-line" />

      <!-- Y-axis ticks -->
      <g v-for="tick in yTicks" :key="'yt' + tick">
        <text
          :x="PAD.left - 8"
          :y="yToPixel(tick) + 4"
          class="tick-label"
          text-anchor="end"
        >{{ fmtYTick(tick) }}</text>
      </g>

      <!-- X-axis ticks -->
      <g v-for="tick in xTicks" :key="'xt' + tick">
        <text
          :x="xToPixel(tick)"
          :y="PAD.top + plotH + 18"
          class="tick-label"
          text-anchor="middle"
        >{{ fmtTime(tick) }}</text>
      </g>

      <!-- Data lines -->
      <path
        v-for="s in series"
        :key="s.unitType"
        :d="toPath(s.points)"
        :stroke="s.color"
        stroke-width="2"
        fill="none"
        stroke-linejoin="round"
      />

      <!-- Hover crosshair -->
      <line
        v-if="hoverX !== null"
        :x1="hoverX"
        :y1="PAD.top"
        :x2="hoverX"
        :y2="PAD.top + plotH"
        class="crosshair"
      />

      <!-- Legend (right side) -->
      <g v-for="(s, i) in series" :key="'lg' + s.unitType">
        <line
          :x1="PAD.left + plotW + 10"
          :y1="PAD.top + 10 + i * 18"
          :x2="PAD.left + plotW + 22"
          :y2="PAD.top + 10 + i * 18"
          :stroke="s.color"
          stroke-width="2"
        />
        <text
          :x="PAD.left + plotW + 26"
          :y="PAD.top + 14 + i * 18"
          class="legend-label"
          :fill="s.color"
        >{{ s.name }}</text>
      </g>
    </svg>

    <!-- Hover tooltip -->
    <div v-if="hoverX !== null && hoverValues.length > 0" class="hover-tooltip">
      <span class="tooltip-time">{{ hoverTime }}</span>
      <div v-for="hv in hoverValues" :key="hv.unitType" class="tooltip-row">
        <span class="tooltip-swatch" :style="{ backgroundColor: hv.color }"></span>
        <span class="tooltip-name">{{ hv.name }}</span>
        <span class="tooltip-value">{{ fmtVal(hv.value) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.graph-container {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.metric-selector {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.metric-label {
  color: #7888a0;
  font-size: 14px;
  white-space: nowrap;
}

.btn-group {
  display: flex;
}

.btn-group button {
  padding: 5px 12px;
  background: rgba(50, 58, 78, 0.7);
  border: 1px solid rgba(90, 105, 140, 0.45);
  color: #8898b4;
  cursor: pointer;
  font-size: 13px;
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

.chart-svg {
  flex: 1;
  width: 100%;
  min-height: 300px;
}

.grid-line {
  stroke: rgba(80, 100, 140, 0.15);
  stroke-width: 1;
}

.axis-line {
  stroke: rgba(100, 120, 160, 0.5);
  stroke-width: 1;
}

.tick-label {
  fill: #7888a0;
  font-size: 11px;
  font-family: 'Courier New', monospace;
}

.legend-label {
  font-size: 11px;
  font-family: 'Courier New', monospace;
}

.crosshair {
  stroke: rgba(200, 210, 230, 0.4);
  stroke-width: 1;
  stroke-dasharray: 4 3;
}

.hover-tooltip {
  position: absolute;
  bottom: 0;
  left: 60px;
  right: 120px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding: 6px 12px;
  background: rgba(15, 18, 28, 0.92);
  border: 1px solid rgba(80, 100, 140, 0.3);
  border-radius: 6px;
  font-size: 12px;
  pointer-events: none;
}

.tooltip-time {
  color: #a0b0c8;
  font-weight: bold;
  margin-right: 8px;
}

.tooltip-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tooltip-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.tooltip-name {
  color: #8898b4;
}

.tooltip-value {
  color: #e0e8f0;
  font-weight: bold;
  font-variant-numeric: tabular-nums;
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
