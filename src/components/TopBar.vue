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

// Unsigned magnitude format. Used for the produce/consume columns.
function fmtMag(n: number): string {
  const abs = Math.abs(n);
  if (abs < 10) return abs.toFixed(1).padStart(4, ' ');
  return abs.toFixed(0).padStart(4, ' ');
}

function fmtStock(n: number): string {
  return Math.floor(n).toString().padStart(4, ' ');
}

function isStockEmpty(n: number): boolean {
  return Math.floor(n) <= 0;
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
</script>

<template>
  <div class="top-bar">
    <!-- Exit (desktop app only) -->
    <button
      v-if="isTauri"
      class="exit-btn"
      title="Exit game"
      @click="exitApp"
    >EXIT</button>

    <!-- Player. The dot toggles the active player in demo mode; the
         name is read-only here. Username edits live in the lobby
         player slot so each client can only edit their own roster row. -->
    <div class="player-section">
      <button
        class="player-dot-btn"
        :class="{ clickable: canTogglePlayer }"
        :title="canTogglePlayer ? 'Click to switch player' : ''"
        :disabled="!canTogglePlayer"
        @click="emit('togglePlayer')"
      >
        <span class="player-dot" :style="{ backgroundColor: playerColor }"></span>
      </button>
      <span class="player-name" title="Username">{{ playerName }}</span>
    </div>

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
          <span
            class="cap-warning"
            :class="{ visible: isAtUnitCap }"
            :aria-hidden="!isAtUnitCap"
          >MAX</span>
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

    <div class="direction-slot">
      <WorldDirectionHud
        class="top-direction-widget"
        :data="directionData"
        compact
      />
    </div>

    <!-- Energy block -->
    <div
      class="resource-block energy-block"
      :class="{ 'resource-empty': isStockEmpty(economy.stockpile.curr) }"
    >
      <div class="resource-summary">
        <div class="resource-header">
          <span class="resource-icon">⚡</span>
          <span class="resource-label">ENERGY</span>
        </div>
        <div class="resource-row">
          <span class="resource-stock">{{ fmtStock(economy.stockpile.curr) }}</span>
          <span class="resource-sep">/</span>
          <span class="resource-max">{{ economy.stockpile.max }}</span>
        </div>
      </div>
      <div class="resource-bar">
        <div class="resource-bar-fill energy-fill" :style="{ width: energyPct + '%' }"></div>
      </div>
      <div class="resource-flows">
        <span class="resource-flow">
          <span class="flow-label">produce</span>
          <span class="flow-value">{{ fmtMag(economy.income.total) }}</span>
        </span>
        <span class="resource-flow">
          <span class="flow-label">consume</span>
          <span class="flow-value">{{ fmtMag(economy.expenditure) }}</span>
        </span>
      </div>
    </div>

    <!-- Mana block -->
    <div
      class="resource-block mana-block"
      :class="{ 'resource-empty': isStockEmpty(economy.mana.stockpile.curr) }"
    >
      <div class="resource-summary">
        <div class="resource-header">
          <span class="resource-icon">💎</span>
          <span class="resource-label">MANA</span>
        </div>
        <div class="resource-row">
          <span class="resource-stock">{{ fmtStock(economy.mana.stockpile.curr) }}</span>
          <span class="resource-sep">/</span>
          <span class="resource-max">{{ economy.mana.stockpile.max }}</span>
        </div>
      </div>
      <div class="resource-bar">
        <div class="resource-bar-fill mana-fill" :style="{ width: manaPct + '%' }"></div>
      </div>
      <div class="resource-flows">
        <span class="resource-flow">
          <span class="flow-label">produce</span>
          <span class="flow-value">{{ fmtMag(economy.mana.income.total) }}</span>
        </span>
        <span class="resource-flow">
          <span class="flow-label">consume</span>
          <span class="flow-value">{{ fmtMag(economy.mana.expenditure) }}</span>
        </span>
      </div>
    </div>

    <!-- Metal block -->
    <div
      class="resource-block metal-block"
      :class="{ 'resource-empty': isStockEmpty(economy.metal.stockpile.curr) }"
    >
      <div class="resource-summary">
        <div class="resource-header">
          <span class="resource-icon">⛏</span>
          <span class="resource-label">METAL</span>
        </div>
        <div class="resource-row">
          <span class="resource-stock">{{ fmtStock(economy.metal.stockpile.curr) }}</span>
          <span class="resource-sep">/</span>
          <span class="resource-max">{{ economy.metal.stockpile.max }}</span>
        </div>
      </div>
      <div class="resource-bar">
        <div class="resource-bar-fill metal-fill" :style="{ width: metalPct + '%' }"></div>
      </div>
      <div class="resource-flows">
        <span class="resource-flow">
          <span class="flow-label">produce</span>
          <span class="flow-value">{{ fmtMag(economy.metal.income.total) }}</span>
        </span>
        <span class="resource-flow">
          <span class="flow-label">consume</span>
          <span class="flow-value">{{ fmtMag(economy.metal.expenditure) }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.top-bar {
  position: relative;
  width: 100%;
  box-sizing: border-box;
  height: 58px;
  background: rgba(15, 15, 15, 0.7);
  border-bottom: 1px solid #444;
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 12px;
  font-family: monospace;
  color: white;
  pointer-events: auto;
}

.direction-slot {
  align-self: stretch;
  display: flex;
  align-items: stretch;
  flex: 0 0 auto;
  min-height: 0;
}

.top-direction-widget {
  height: 100%;
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
  border-right: 1px solid rgba(255, 255, 255, 0.18);
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
  display: block;
  font-weight: bold;
  font-size: 13px;
  width: 130px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.player-dot-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  cursor: default;
}
.player-dot-btn.clickable {
  cursor: pointer;
}
.player-dot-btn.clickable:hover .player-dot {
  border-color: white;
}

.network-section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 92px;
  max-width: 170px;
  padding-right: 12px;
  border-right: 1px solid rgba(255, 255, 255, 0.18);
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
  --resource-accent: #ddd;
  display: flex;
  flex-direction: column;
  min-width: 160px;
  gap: 1px;
  box-sizing: border-box;
  padding: 3px 5px;
  border: 1px solid transparent;
  border-radius: 3px;
}

.resource-summary {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.resource-header {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--resource-accent);
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.energy-block { --resource-accent: #ffcc00; }
.mana-block { --resource-accent: #44aaff; }
.metal-block { --resource-accent: #d8a878; }

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

.resource-stock {
  color: var(--resource-accent);
}

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

.resource-bar-fill {
  background: var(--resource-accent);
}

.resource-flows {
  display: flex;
  gap: 6px;
  font-size: 11px;
  white-space: pre;
  font-weight: bold;
  color: rgba(190, 190, 200, 0.78);
}

.resource-flow {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
}

.flow-label {
  color: rgba(160, 160, 170, 0.72);
  font-size: 9px;
  font-weight: bold;
  text-transform: uppercase;
}

.flow-value {
  color: rgba(205, 205, 215, 0.82);
}

.resource-empty {
  animation: resource-empty-shell 0.9s steps(1, end) infinite;
}

.resource-empty .resource-header,
.resource-empty .resource-stock {
  animation: resource-empty-accent-text 0.9s steps(1, end) infinite;
}

.resource-empty .resource-sep,
.resource-empty .resource-max {
  animation: resource-empty-subtle-text 0.9s steps(1, end) infinite;
}

.resource-empty .flow-label {
  animation: resource-empty-flow-label 0.9s steps(1, end) infinite;
}

.resource-empty .flow-value {
  animation: resource-empty-flow-value 0.9s steps(1, end) infinite;
}

.resource-empty .resource-bar-fill {
  animation: resource-empty-fill 0.9s steps(1, end) infinite;
}

@keyframes resource-empty-shell {
  0%, 49% {
    background: rgba(255, 45, 45, 0.18);
    border-color: rgba(255, 80, 80, 0.65);
    box-shadow: 0 0 10px rgba(255, 45, 45, 0.38);
  }
  50%, 100% {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
  }
}

@keyframes resource-empty-accent-text {
  0%, 49% {
    color: #ff5555;
  }
  50%, 100% {
    color: var(--resource-accent);
  }
}

@keyframes resource-empty-subtle-text {
  0%, 49% {
    color: #ff5555;
  }
  50%, 100% {
    color: rgba(255, 255, 255, 0.3);
  }
}

@keyframes resource-empty-flow-label {
  0%, 49% {
    color: #ff5555;
  }
  50%, 100% {
    color: rgba(160, 160, 170, 0.72);
  }
}

@keyframes resource-empty-flow-value {
  0%, 49% {
    color: #ff5555;
  }
  50%, 100% {
    color: rgba(205, 205, 215, 0.82);
  }
}

@keyframes resource-empty-fill {
  0%, 49% {
    background: #ff5555;
  }
  50%, 100% {
    background: var(--resource-accent);
  }
}

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
  display: inline-block;
  flex: 0 0 3ch;
  font-size: 9px;
  color: #ff4444;
  text-align: left;
  visibility: hidden;
}

.cap-warning.visible {
  animation: blink 1s infinite;
  visibility: visible;
}

@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0.3; }
}
</style>
