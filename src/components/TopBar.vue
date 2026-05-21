<script setup lang="ts">
import { computed } from 'vue';
import { COLORS, RESOURCE_COLOR_CSS } from '@/colorsConfig';
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

const TOP_BAR = COLORS.ui.topBar;

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
const metalPct = computed(() =>
  Math.min(100, Math.round((props.economy.metal.stockpile.curr / props.economy.metal.stockpile.max) * 100))
);

const unitCapColor = computed(() => {
  const pct = (props.economy.units.count / props.economy.units.cap) * 100;
  if (pct >= 100) return TOP_BAR.unitCap.full;
  if (pct >= 80) return TOP_BAR.unitCap.warning;
  return TOP_BAR.unitCap.ok;
});

const isAtUnitCap = computed(() => props.economy.units.count >= props.economy.units.cap);

// Style objects + formatted strings wrapped in computeds so Vue caches
// the returned identity across re-renders. Without these, every parent
// snapshot tick (TopBar receives economy props at 20 Hz) reallocates the
// inline `:style="{ ... }"` object and reruns each fmt*() template call,
// producing GC churn on otherwise unchanged values.
const playerDotStyle = computed(() => ({ backgroundColor: props.playerColor }));
const unitCapStyle = computed(() => ({ color: unitCapColor.value }));
const energyBarStyle = computed(() => ({ width: energyPct.value + '%' }));
const metalBarStyle = computed(() => ({ width: metalPct.value + '%' }));
const topBarStyle = computed(() => ({
  '--topbar-bg': TOP_BAR.surface.background,
  '--topbar-border': TOP_BAR.surface.border,
  '--topbar-text': TOP_BAR.surface.text,
  '--topbar-divider': TOP_BAR.surface.divider,
  '--topbar-muted-text': TOP_BAR.surface.mutedText,
  '--topbar-subtle-text': TOP_BAR.surface.subtleText,
  '--topbar-exit-border': TOP_BAR.exitButton.border,
  '--topbar-exit-bg': TOP_BAR.exitButton.background,
  '--topbar-exit-text': TOP_BAR.exitButton.text,
  '--topbar-exit-hover-bg': TOP_BAR.exitButton.hoverBackground,
  '--topbar-exit-hover-text': TOP_BAR.exitButton.hoverText,
  '--topbar-exit-hover-border': TOP_BAR.exitButton.hoverBorder,
  '--topbar-exit-active-bg': TOP_BAR.exitButton.activeBackground,
  '--topbar-player-dot-border': TOP_BAR.playerDot.border,
  '--topbar-player-dot-hover-border': TOP_BAR.playerDot.hoverBorder,
  '--topbar-player-hover-bg': TOP_BAR.playerDot.hoverBackground,
  '--topbar-network-label': TOP_BAR.network.label,
  '--topbar-network-value': TOP_BAR.network.value,
  '--topbar-network-warning': TOP_BAR.network.warning,
  '--resource-energy-accent': RESOURCE_COLOR_CSS.energy,
  '--resource-metal-accent': RESOURCE_COLOR_CSS.metal,
  '--resource-bar-bg': TOP_BAR.resource.barBackground,
  '--resource-flow-text': TOP_BAR.resource.flowText,
  '--resource-flow-label': TOP_BAR.resource.flowLabel,
  '--resource-flow-value': TOP_BAR.resource.flowValue,
  '--resource-empty-flash': TOP_BAR.resource.emptyFlash,
  '--resource-empty-shell-bg': TOP_BAR.resource.emptyShellBackground,
  '--resource-empty-shell-border': TOP_BAR.resource.emptyShellBorder,
  '--resource-empty-shell-shadow': TOP_BAR.resource.emptyShellShadow,
  '--building-solar-color': TOP_BAR.buildings.solar,
  '--building-wind-color': TOP_BAR.buildings.wind,
  '--building-factory-color': TOP_BAR.buildings.factory,
  '--unit-cap-full': TOP_BAR.unitCap.full,
}));

const energyStockDisplay = computed(() => fmtStock(props.economy.stockpile.curr));
const energyProduceDisplay = computed(() => fmtMag(props.economy.income.total));
const energyConsumeDisplay = computed(() => fmtMag(props.economy.expenditure));
const metalStockDisplay = computed(() => fmtStock(props.economy.metal.stockpile.curr));
const metalProduceDisplay = computed(() => fmtMag(props.economy.metal.income.total));
const metalConsumeDisplay = computed(() => fmtMag(props.economy.metal.expenditure));
</script>

<template>
  <div class="top-bar" :style="topBarStyle">
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
        <span class="player-dot" :style="playerDotStyle"></span>
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
        <span class="count-value" :style="unitCapStyle">
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
          <span class="resource-stock">{{ energyStockDisplay }}</span>
          <span class="resource-sep">/</span>
          <span class="resource-max">{{ economy.stockpile.max }}</span>
        </div>
      </div>
      <div class="resource-bar">
        <div class="resource-bar-fill energy-fill" :style="energyBarStyle"></div>
      </div>
      <div class="resource-flows">
        <span class="resource-flow">
          <span class="flow-label">produce</span>
          <span class="flow-value">{{ energyProduceDisplay }}</span>
        </span>
        <span class="resource-flow">
          <span class="flow-label">consume</span>
          <span class="flow-value">{{ energyConsumeDisplay }}</span>
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
          <span class="resource-stock">{{ metalStockDisplay }}</span>
          <span class="resource-sep">/</span>
          <span class="resource-max">{{ economy.metal.stockpile.max }}</span>
        </div>
      </div>
      <div class="resource-bar">
        <div class="resource-bar-fill metal-fill" :style="metalBarStyle"></div>
      </div>
      <div class="resource-flows">
        <span class="resource-flow">
          <span class="flow-label">produce</span>
          <span class="flow-value">{{ metalProduceDisplay }}</span>
        </span>
        <span class="resource-flow">
          <span class="flow-label">consume</span>
          <span class="flow-value">{{ metalConsumeDisplay }}</span>
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
  background: var(--topbar-bg);
  border-bottom: 1px solid var(--topbar-border);
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 12px;
  font-family: monospace;
  color: var(--topbar-text);
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
  border: 1px solid var(--topbar-exit-border);
  border-radius: 4px;
  background: var(--topbar-exit-bg);
  color: var(--topbar-exit-text);
  font-family: monospace;
  font-size: 14px;
  font-weight: bold;
  cursor: pointer;
  flex-shrink: 0;
}

.exit-btn:hover {
  background: var(--topbar-exit-hover-bg);
  color: var(--topbar-exit-hover-text);
  border-color: var(--topbar-exit-hover-border);
}

.exit-btn:active {
  background: var(--topbar-exit-active-bg);
}

.player-section {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 8px;
  border: none;
  border-right: 1px solid var(--topbar-divider);
  background: none;
  color: var(--topbar-text);
  font-family: monospace;
  min-width: 80px;
  cursor: default;
}

.player-section.clickable {
  cursor: pointer;
  border-radius: 4px;
}

.player-section.clickable:hover {
  background: var(--topbar-player-hover-bg);
}

.player-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--topbar-player-dot-border);
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
  border-color: var(--topbar-player-dot-hover-border);
}

.network-section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 92px;
  max-width: 170px;
  padding-right: 12px;
  border-right: 1px solid var(--topbar-divider);
  overflow: hidden;
}

.network-label {
  font-size: 9px;
  font-weight: bold;
  color: var(--topbar-network-label);
}

.network-value {
  font-size: 11px;
  font-weight: bold;
  color: var(--topbar-network-value);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.network-section.warning .network-label,
.network-section.warning .network-value {
  color: var(--topbar-network-warning);
}

/* Resource blocks */
.resource-block {
  --resource-accent: var(--topbar-text);
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

.energy-block { --resource-accent: var(--resource-energy-accent); }
.metal-block { --resource-accent: var(--resource-metal-accent); }

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
  color: var(--topbar-subtle-text);
  font-size: 11px;
  margin: 0 2px;
}

.resource-max {
  color: var(--topbar-subtle-text);
  font-size: 11px;
  font-weight: normal;
}

.resource-bar {
  width: 100%;
  height: 3px;
  background: var(--resource-bar-bg);
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
  color: var(--resource-flow-text);
}

.resource-flow {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
}

.flow-label {
  color: var(--resource-flow-label);
  font-size: 9px;
  font-weight: bold;
  text-transform: uppercase;
}

.flow-value {
  color: var(--resource-flow-value);
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
    background: var(--resource-empty-shell-bg);
    border-color: var(--resource-empty-shell-border);
    box-shadow: 0 0 10px var(--resource-empty-shell-shadow);
  }
  50%, 100% {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
  }
}

@keyframes resource-empty-accent-text {
  0%, 49% {
    color: var(--resource-empty-flash);
  }
  50%, 100% {
    color: var(--resource-accent);
  }
}

@keyframes resource-empty-subtle-text {
  0%, 49% {
    color: var(--resource-empty-flash);
  }
  50%, 100% {
    color: var(--topbar-subtle-text);
  }
}

@keyframes resource-empty-flow-label {
  0%, 49% {
    color: var(--resource-empty-flash);
  }
  50%, 100% {
    color: var(--resource-flow-label);
  }
}

@keyframes resource-empty-flow-value {
  0%, 49% {
    color: var(--resource-empty-flash);
  }
  50%, 100% {
    color: var(--resource-flow-value);
  }
}

@keyframes resource-empty-fill {
  0%, 49% {
    background: var(--resource-empty-flash);
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
  color: var(--topbar-muted-text);
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

.building-solar { color: var(--building-solar-color); }
.building-wind { color: var(--building-wind-color); }
.building-factory { color: var(--building-factory-color); }

.cap-warning {
  display: inline-block;
  flex: 0 0 3ch;
  font-size: 9px;
  color: var(--unit-cap-full);
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
