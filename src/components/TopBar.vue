<script setup lang="ts">
import { computed } from 'vue';
import WorldDirectionHud from './WorldDirectionHud.vue';

export type { EconomyInfo } from '@/types/ui';
import type { EconomyInfo, MinimapData } from '@/types/ui';

const isTauri = typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

async function exitApp(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  getCurrentWindow().close();
}

const props = defineProps<{
  economy: EconomyInfo;
  playerName: string;
  playerColor: string;
  canTogglePlayer: boolean;
  directionData: Pick<MinimapData, 'cameraYaw' | 'wind'>;
  networkStatus?: string;
  networkWarning?: string | null;
}>();

const emit = defineEmits<{
  togglePlayer: [];
}>();

// Unsigned magnitude format. Used for the +income/-expenditure
// columns where the sign is rendered as a separate prefix.
function fmtMag(n: number): string {
  const abs = Math.abs(n);
  if (abs < 10) return abs.toFixed(1).padStart(4, ' ');
  return abs.toFixed(0).padStart(4, ' ');
}

// Signed format with explicit + or − prefix. Used for the net-flow
// column so positive/negative is always unambiguous.
function fmtSigned(n: number): string {
  const sign = n < 0 ? '−' : '+';
  return sign + fmtMag(n);
}

function fmtStock(n: number): string {
  return Math.floor(n).toString().padStart(4, ' ');
}

const energyPct = computed(() =>
  Math.min(100, Math.round((props.economy.stockpile.curr / props.economy.stockpile.max) * 100))
);
const manaPct = computed(() =>
  Math.min(100, Math.round((props.economy.mana.stockpile.curr / props.economy.mana.stockpile.max) * 100))
);
const metalPct = computed(() =>
  Math.min(100, Math.round((props.economy.metal.stockpile.curr / props.economy.metal.stockpile.max) * 100))
);

const unitCapColor = computed(() => {
  const pct = (props.economy.units.count / props.economy.units.cap) * 100;
  if (pct >= 100) return '#ff4444';
  if (pct >= 80) return '#ffcc00';
  return 'rgba(255,255,255,0.7)';
});

const isAtUnitCap = computed(() => props.economy.units.count >= props.economy.units.cap);

function flowColor(n: number): string {
  if (Math.abs(n) < 1) return 'rgba(255,255,255,0.4)';
  return n > 0 ? '#88ffaa' : '#ff6666';
}
</script>

<template>
  <div class="top-bar" :style="{ '--player-color': playerColor }">
    <!-- Exit (desktop app only) -->
    <button
      v-if="isTauri"
      class="exit-btn"
      title="Exit game"
      @click="exitApp"
    >EXIT</button>

    <!-- Player -->
    <button
      class="player-section"
      :class="{ clickable: canTogglePlayer }"
      :title="canTogglePlayer ? 'Click to switch player' : ''"
      @click="canTogglePlayer && emit('togglePlayer')"
    >
      <span class="player-dot" :style="{ backgroundColor: playerColor }"></span>
      <span class="player-name">{{ playerName }}</span>
    </button>

    <div
      v-if="networkStatus || networkWarning"
      class="network-section"
      :class="{ warning: !!networkWarning }"
      :title="networkWarning || networkStatus"
    >
      <span class="network-label">NET</span>
      <span class="network-value">{{ networkWarning || networkStatus }}</span>
    </div>

    <!-- Units + Buildings -->
    <div class="counts-section">
      <div class="count-row">
        <span class="count-label">UNITS</span>
        <span class="count-value" :style="{ color: unitCapColor }">
          {{ economy.units.count }}/{{ economy.units.cap }}
          <span v-if="isAtUnitCap" class="cap-warning">MAX</span>
        </span>
      </div>
      <div class="count-row">
        <span class="count-label">BLDG</span>
        <span class="count-value">
          <span class="building-solar" title="Solar">☀{{ economy.buildings.solar }}</span>
          <span class="building-wind" title="Wind">◌{{ economy.buildings.wind }}</span>
          <span class="building-factory" title="Fabricators">🏭{{ economy.buildings.factory }}</span>
        </span>
      </div>
    </div>

    <WorldDirectionHud
      class="top-direction-widget"
      :data="directionData"
      compact
    />

    <!-- Energy block -->
    <div class="resource-block energy-block">
      <div class="resource-header">
        <span class="resource-icon">⚡</span>
        <span class="resource-label">ENERGY</span>
      </div>
      <div class="resource-row">
        <span class="resource-stock">{{ fmtStock(economy.stockpile.curr) }}</span>
        <span class="resource-sep">/</span>
        <span class="resource-max">{{ economy.stockpile.max }}</span>
      </div>
      <div class="resource-bar">
        <div class="resource-bar-fill energy-fill" :style="{ width: energyPct + '%' }"></div>
      </div>
      <div class="resource-flows">
        <span class="flow-pos">+{{ fmtMag(economy.income.total) }}</span>
        <span class="flow-neg" :class="{ inactive: economy.expenditure < 0.05 }">−{{ fmtMag(economy.expenditure) }}</span>
        <span class="flow-net" :style="{ color: flowColor(economy.netFlow) }">={{ fmtSigned(economy.netFlow) }}</span>
      </div>
    </div>

    <!-- Mana block -->
    <div class="resource-block mana-block">
      <div class="resource-header">
        <span class="resource-icon">💎</span>
        <span class="resource-label">MANA</span>
      </div>
      <div class="resource-row">
        <span class="resource-stock">{{ fmtStock(economy.mana.stockpile.curr) }}</span>
        <span class="resource-sep">/</span>
        <span class="resource-max">{{ economy.mana.stockpile.max }}</span>
      </div>
      <div class="resource-bar">
        <div class="resource-bar-fill mana-fill" :style="{ width: manaPct + '%' }"></div>
      </div>
      <div class="resource-flows">
        <span class="flow-pos">+{{ fmtMag(economy.mana.income.total) }}</span>
        <span class="flow-neg" :class="{ inactive: economy.mana.expenditure < 0.05 }">−{{ fmtMag(economy.mana.expenditure) }}</span>
        <span class="flow-net" :style="{ color: flowColor(economy.mana.netFlow) }">={{ fmtSigned(economy.mana.netFlow) }}</span>
      </div>
    </div>

    <!-- Metal block -->
    <div class="resource-block metal-block">
      <div class="resource-header">
        <span class="resource-icon">⛏</span>
        <span class="resource-label">METAL</span>
      </div>
      <div class="resource-row">
        <span class="resource-stock">{{ fmtStock(economy.metal.stockpile.curr) }}</span>
        <span class="resource-sep">/</span>
        <span class="resource-max">{{ economy.metal.stockpile.max }}</span>
      </div>
      <div class="resource-bar">
        <div class="resource-bar-fill metal-fill" :style="{ width: metalPct + '%' }"></div>
      </div>
      <div class="resource-flows">
        <span class="flow-pos">+{{ fmtMag(economy.metal.income.total) }}</span>
        <span class="flow-neg" :class="{ inactive: economy.metal.expenditure < 0.05 }">−{{ fmtMag(economy.metal.expenditure) }}</span>
        <span class="flow-net" :style="{ color: flowColor(economy.metal.netFlow) }">={{ fmtSigned(economy.metal.netFlow) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.top-bar {
  position: relative;
  width: 100%;
  box-sizing: border-box;
  min-height: 58px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--player-color) 15%, transparent) 0%, transparent 100%),
    linear-gradient(180deg, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.7) 100%);
  border-bottom: 2px solid var(--player-color);
  display: flex;
  align-items: center;
  padding: 6px 12px 7px;
  gap: 16px;
  font-family: monospace;
  color: white;
  pointer-events: auto;
}

.top-direction-widget {
  flex: 0 0 auto;
}

.exit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  height: 32px;
  border: 1px solid rgba(255, 80, 80, 0.4);
  border-radius: 4px;
  background: rgba(255, 40, 40, 0.15);
  color: #ff6666;
  font-family: monospace;
  font-size: 14px;
  font-weight: bold;
  cursor: pointer;
  flex-shrink: 0;
}

.exit-btn:hover {
  background: rgba(255, 40, 40, 0.4);
  color: #ff9999;
  border-color: rgba(255, 80, 80, 0.7);
}

.exit-btn:active {
  background: rgba(255, 40, 40, 0.6);
}

.player-section {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 8px;
  border: none;
  border-right: 1px solid color-mix(in srgb, var(--player-color) 40%, transparent);
  background: none;
  color: white;
  font-family: monospace;
  min-width: 80px;
  cursor: default;
}

.player-section.clickable {
  cursor: pointer;
  border-radius: 4px;
}

.player-section.clickable:hover {
  background: rgba(255, 255, 255, 0.1);
}

.player-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.5);
  flex-shrink: 0;
}

.player-name {
  font-weight: bold;
  font-size: 13px;
  text-transform: uppercase;
  width: 50px;
  text-align: left;
}

.network-section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 92px;
  max-width: 170px;
  padding-right: 12px;
  border-right: 1px solid color-mix(in srgb, var(--player-color) 28%, transparent);
  overflow: hidden;
}

.network-label {
  font-size: 9px;
  font-weight: bold;
  color: rgba(255, 255, 255, 0.45);
}

.network-value {
  font-size: 11px;
  font-weight: bold;
  color: rgba(220, 245, 255, 0.9);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.network-section.warning .network-label,
.network-section.warning .network-value {
  color: #ff7777;
}

/* ── Resource blocks (Energy / Mana) ── */
.resource-block {
  display: flex;
  flex-direction: column;
  min-width: 145px;
  gap: 1px;
}

.resource-header {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.energy-block .resource-header { color: #ffcc00; }
.mana-block .resource-header { color: #44aaff; }
.metal-block .resource-header { color: #d8a878; }

.resource-icon {
  font-size: 11px;
}

.resource-row {
  display: flex;
  align-items: baseline;
  font-size: 15px;
  font-weight: bold;
  white-space: pre;
}

.energy-block .resource-stock { color: #ffcc00; }
.mana-block .resource-stock { color: #44aaff; }
.metal-block .resource-stock { color: #d8a878; }

.resource-sep {
  color: rgba(255, 255, 255, 0.3);
  font-size: 11px;
  margin: 0 2px;
}

.resource-max {
  color: rgba(255, 255, 255, 0.3);
  font-size: 11px;
  font-weight: normal;
}

.resource-bar {
  width: 100%;
  height: 3px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 1px;
  overflow: hidden;
}

.resource-bar-fill {
  height: 100%;
  transition: width 0.2s ease;
}

.energy-fill { background: #ffcc00; }
.mana-fill { background: #44aaff; }
.metal-fill { background: #d8a878; }

.resource-flows {
  display: flex;
  gap: 6px;
  font-size: 11px;
  white-space: pre;
  font-weight: bold;
}

.flow-pos { color: #88ffaa; }
.flow-neg { color: #ff8080; }
.flow-neg.inactive { color: rgba(255, 255, 255, 0.25); }
.flow-net { /* color set inline by flowColor() */ }

/* ── Counts ── */
.counts-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 110px;
}

.count-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.count-label {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.5);
  text-transform: uppercase;
  width: 32px;
}

.count-value {
  font-size: 13px;
  font-weight: bold;
  display: flex;
  align-items: center;
  gap: 6px;
}

.building-solar { color: #ffcc00; }
.building-wind { color: #bde7ff; }
.building-factory { color: #88ccff; }

.cap-warning {
  font-size: 9px;
  color: #ff4444;
  animation: blink 1s infinite;
}

@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0.3; }
}
</style>
