<script setup lang="ts">
import { computed, ref } from 'vue';
import type { NetworkServerSnapshotUnitTypeStats } from '../game/network/NetworkTypes';
import { UNIT_BLUEPRINTS, BUILDABLE_UNIT_IDS, getNormalizedUnitCost } from '../game/sim/blueprints';
import { type FriendlyFireMode, type StatsSnapshot, applyFriendlyFire } from './combatStatsUtils';

const props = defineProps<{
  history: StatsSnapshot[];
  viewMode: 'global' | 'player';
  selectedPlayer: number;
  teamDamageMode: FriendlyFireMode;
  teamKillsMode: FriendlyFireMode;
}>();

type MetricKey = 'damage' | 'kills' | 'damageCost' | 'killsCost' | 'normDamageCost' | 'normKillsCost' | 'avg' | 'avgNorm';

const METRICS: { key: MetricKey; label: string; tip: string }[] = [
  { key: 'damage', label: 'Damage', tip: 'Cumulative damage dealt (adjusted for friendly fire mode)' },
  { key: 'kills', label: 'Kills', tip: 'Cumulative kills (adjusted for friendly fire mode)' },
  { key: 'damageCost', label: 'D / Cost', tip: 'Damage dealt per selected cost basis (E/M/E+M)' },
  { key: 'killsCost', label: 'K / Cost', tip: 'Kills per selected cost basis (E/M/E+M)' },
  { key: 'normDamageCost', label: 'Norm D/C', tip: 'Damage/Cost normalized — top unit = 1 per snapshot' },
  { key: 'normKillsCost', label: 'Norm K/C', tip: 'Kills/Cost normalized — top unit = 1 per snapshot' },
  { key: 'avg', label: 'Avg', tip: 'Average of Norm(D/C) and Norm(K/C)' },
  { key: 'avgNorm', label: 'Avg Norm', tip: 'Avg normalized — top unit = 1 per snapshot' },
];

const selectedMetric = ref<MetricKey>('avgNorm');

const unitTypes = computed(() => BUILDABLE_UNIT_IDS);

function getCost(s: NetworkServerSnapshotUnitTypeStats): number {
  return getNormalizedUnitCost(s.units);
}

// Cost-based color scale using OKLab lightness for perceptual uniformity.
// Hues spread from red (0°) to blue (240°); odd indices are dark, even are light.
const unitCostColors = computed<Record<string, string>>(() => {
  const sorted = [...unitTypes.value].sort(
    (a, b) => (UNIT_BLUEPRINTS[a] ? getNormalizedUnitCost(UNIT_BLUEPRINTS[a]) : 0) - (UNIT_BLUEPRINTS[b] ? getNormalizedUnitCost(UNIT_BLUEPRINTS[b]) : 0),
  );
  const n = sorted.length;
  const colors: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const hue = 240 * (i / Math.max(n - 1, 1));
    const lightness = i % 2 === 0 ? 40 : 70;
    colors[sorted[i]] = oklch(lightness, hue);
  }
  return colors;
});

// Convert perceptual lightness (0-100) + hue (0-360) to an sRGB hex string via OKLab
function oklch(lightness: number, hueDeg: number): string {
  const L = lightness / 100;
  const C = 0.15;
  const hRad = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  // OKLab → linear sRGB
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;
  const rLin = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;
  const toSrgb = (c: number) => Math.round(255 * Math.max(0, Math.min(1,
    c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055,
  )));
  return `#${[rLin, gLin, bLin].map(c => toSrgb(c).toString(16).padStart(2, '0')).join('')}`;
}

// Chart dimensions
const W = 800;
const H = 400;
const PAD = { top: 20, right: 160, bottom: 40, left: 60 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

// The raw (non-normalized) metric that a norm metric is derived from
function rawMetricOf(m: MetricKey): MetricKey {
  switch (m) {
    case 'normDamageCost': return 'damageCost';
    case 'normKillsCost': return 'killsCost';
    default: return m;
  }
}

function computeMetric(s: NetworkServerSnapshotUnitTypeStats | undefined, metric: MetricKey): number {
  if (!s) return 0;
  const cost = getCost(s);
  switch (metric) {
    case 'damage': return applyFriendlyFire(s.damage.dealt.enemy ?? 0, s.damage.dealt.friendly ?? 0, props.teamDamageMode);
    case 'kills': return applyFriendlyFire(s.kills.enemy ?? 0, s.kills.friendly ?? 0, props.teamKillsMode);
    case 'damageCost': {
      const dmg = applyFriendlyFire(s.damage.dealt.enemy ?? 0, s.damage.dealt.friendly ?? 0, props.teamDamageMode);
      return cost > 0 ? dmg / cost : 0;
    }
    case 'killsCost': {
      const kills = applyFriendlyFire(s.kills.enemy ?? 0, s.kills.friendly ?? 0, props.teamKillsMode);
      return cost > 0 ? kills / cost : 0;
    }
    default: throw new Error(`Unknown metric: ${metric}`);
  }
}

/** Divide all values by the max so the top value becomes 1 */
function normalize(values: number[]): number[] {
  let max = 0;
  for (const v of values) {
    if (v > max) max = v;
  }
  if (max > 0) {
    for (let i = 0; i < values.length; i++) {
      values[i] = values[i] / max;
    }
  }
  return values;
}

const isSimpleMetric = (m: MetricKey): boolean =>
  m === 'damage' || m === 'kills' || m === 'damageCost' || m === 'killsCost';

const formulaDisplay = computed(() => {
  switch (selectedMetric.value) {
    case 'damage': return 'cumulative damage dealt (adjusted for FF mode)';
    case 'kills': return 'cumulative kills (adjusted for FF mode)';
    case 'damageCost': return 'damage / normalized cost — cost = avg(E/maxE, M/maxM)';
    case 'killsCost': return 'kills / normalized cost — cost = avg(E/maxE, M/maxM)';
    case 'normDamageCost': return '(damage / cost) / max — top unit = 1';
    case 'normKillsCost': return '(kills / cost) / max — top unit = 1';
    case 'avg': return 'avg(norm(damage/cost), norm(kills/cost))';
    case 'avgNorm': return 'avg / max — top unit = 1';
    default: throw new Error(`Unknown metric: ${selectedMetric.value}`);
  }
});

type SeriesPoint = { t: number; v: number };
type Series = { unitType: string; name: string; cost: number; color: string; points: SeriesPoint[] };

// Compute per-snapshot normalized slices for a raw metric
function computeNormSlices(uts: string[], raw: MetricKey): number[][] {
  const numSnaps = props.history.length;
  const numUnits = uts.length;
  const out: number[][] = Array.from({ length: numUnits }, () => new Array(numSnaps));
  for (let si = 0; si < numSnaps; si++) {
    const data = props.viewMode === 'global'
      ? props.history[si].stats.global
      : props.history[si].stats.players[props.selectedPlayer] ?? {};
    const slice: number[] = new Array(numUnits);
    for (let ui = 0; ui < numUnits; ui++) {
      slice[ui] = computeMetric(data[uts[ui]], raw);
    }
    normalize(slice);
    for (let ui = 0; ui < numUnits; ui++) {
      out[ui][si] = slice[ui];
    }
  }
  return out;
}

function buildSeries(uts: string[], values: number[][]): Series[] {
  return uts.map((ut, ui) => {
    const bp = UNIT_BLUEPRINTS[ut];
    const points: SeriesPoint[] = props.history.map((snap, si) => ({
      t: snap.timestamp,
      v: values[ui][si],
    }));
    return { unitType: ut, name: bp?.name ?? ut, cost: bp ? getNormalizedUnitCost(bp) : 0, color: unitCostColors.value[ut] ?? '#888', points };
  }).sort((a, b) => b.cost - a.cost);
}

const series = computed<Series[]>(() => {
  if (props.history.length === 0) return [];

  const metric = selectedMetric.value;
  const uts = unitTypes.value;

  // Simple metrics: no cross-unit normalization
  if (isSimpleMetric(metric)) {
    return uts.map(ut => {
      const bp = UNIT_BLUEPRINTS[ut];
      const points: SeriesPoint[] = props.history.map(snap => {
        const data = props.viewMode === 'global'
          ? snap.stats.global
          : snap.stats.players[props.selectedPlayer] ?? {};
        return { t: snap.timestamp, v: computeMetric(data[ut], metric) };
      });
      return { unitType: ut, name: bp?.name ?? ut, cost: bp ? getNormalizedUnitCost(bp) : 0, color: unitCostColors.value[ut] ?? '#888', points };
    }).sort((a, b) => b.cost - a.cost);
  }

  // Single norm metrics
  if (metric === 'normDamageCost' || metric === 'normKillsCost') {
    return buildSeries(uts, computeNormSlices(uts, rawMetricOf(metric)));
  }

  // Avg and AvgNorm both need the two norm slices averaged
  const normDmg = computeNormSlices(uts, 'damageCost');
  const normKills = computeNormSlices(uts, 'killsCost');
  const numSnaps = props.history.length;
  const numUnits = uts.length;
  const avgValues: number[][] = Array.from({ length: numUnits }, () => new Array(numSnaps));
  for (let ui = 0; ui < numUnits; ui++) {
    for (let si = 0; si < numSnaps; si++) {
      avgValues[ui][si] = (normDmg[ui][si] + normKills[ui][si]) / 2;
    }
  }

  if (metric === 'avg') {
    return buildSeries(uts, avgValues);
  }

  // avgNorm: normalize the averaged values per snapshot
  for (let si = 0; si < numSnaps; si++) {
    const slice: number[] = new Array(numUnits);
    for (let ui = 0; ui < numUnits; ui++) slice[ui] = avgValues[ui][si];
    normalize(slice);
    for (let ui = 0; ui < numUnits; ui++) avgValues[ui][si] = slice[ui];
  }
  return buildSeries(uts, avgValues);
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
  let min = 0;
  let max = 0;
  for (const s of series.value) {
    for (const p of s.points) {
      if (p.v > max) max = p.v;
      if (p.v < min) min = p.v;
    }
  }
  if (max === 0 && min === 0) max = 1;
  const range = max - min;
  const step = niceStep(range, 5);
  return {
    min: min < 0 ? Math.floor(min / step) * step : 0,
    max: Math.ceil(max / step) * step,
  };
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
  const si = hoverSnapIndex.value;
  if (si < 0 || si >= props.history.length) return [];

  // Read from precomputed series data (already normalized for norm metrics)
  return series.value.map(s => ({
    unitType: s.unitType,
    name: s.name,
    color: s.color,
    value: si < s.points.length ? s.points[si].v : 0,
  })).filter(r => r.value !== 0).sort((a, b) => b.value - a.value);
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

    <!-- Formula display -->
    <div class="formula-display">{{ formulaDisplay }}</div>

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
        :class="tick === 0 && yRange.min < 0 ? 'zero-line' : 'grid-line'"
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

      <!-- Legend (right side, table layout) -->
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
        <text
          :x="PAD.left + plotW + PAD.right - 6"
          :y="PAD.top + 14 + i * 18"
          class="legend-cost"
          text-anchor="end"
          :fill="s.color"
        >{{ Math.round(s.cost * 100) }}%</text>
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

.formula-display {
  color: #7888a0;
  font-size: 13px;
  font-family: 'Courier New', monospace;
  margin-bottom: 8px;
  padding: 3px 8px;
  background: rgba(40, 48, 68, 0.4);
  border-radius: 4px;
  width: fit-content;
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

.zero-line {
  stroke: rgba(180, 190, 210, 0.4);
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

.legend-cost {
  font-size: 11px;
  font-family: 'Courier New', monospace;
  font-variant-numeric: tabular-nums;
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
  right: 160px;
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
