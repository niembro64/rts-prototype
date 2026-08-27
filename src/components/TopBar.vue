<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { COLORS, RESOURCE_COLOR_CSS } from '@/colorsConfig';
import WorldDirectionHud from './WorldDirectionHud.vue';
import { HUD_TOP_BAR_HEIGHT_PX } from './hudLayout';
import { closeCurrentTauriWindow, isTauriRuntime } from '@/browserRuntime';

import type { EconomyInfo, MinimapData } from '@/types/ui';

const isTauri = isTauriRuntime();

const props = defineProps<{
  economy: EconomyInfo;
  directionData: Pick<MinimapData, 'cameraView' | 'directionVersion' | 'wind'>;
  networkStatus?: string;
  networkWarning?: string | null;
  /** False for a WATCHER: the metal/energy blocks describe a seat's
   *  economy, and a watcher holds no seat — the per-team spectator overlay
   *  is their economy view. The shell keeps NET, compass/wind and the
   *  desktop EXIT either way. */
  showEconomy?: boolean;
  /** The seat's auto-conversion slider points (fractions of storage) as
   *  the SIM knows them. null/undefined hides the sliders (watchers). */
  autoConversion?: { energyAt: number; metalAt: number } | null;
}>();

const emit = defineEmits<{
  (e: 'set-auto-conversion', payload: { energyAt: number; metalAt: number }): void;
}>();

// BAR-style storage sliders: dragging previews locally, pointer-up sends
// ONE command, and the dragged value keeps rendering until the sim echoes
// it back through serverMeta (rich-snapshot cadence) so the marker never
// snaps back to the stale value in between.
type SliderKind = 'energy' | 'metal';
const sliderDragging = ref<SliderKind | null>(null);
const sliderDragValue = ref(0);
const sliderPending = ref<{ energyAt: number; metalAt: number } | null>(null);

watch(
  () => props.autoConversion,
  (incoming) => {
    const pending = sliderPending.value;
    if (incoming == null || pending === null) return;
    if (
      Math.abs(incoming.energyAt - pending.energyAt) < 0.005 &&
      Math.abs(incoming.metalAt - pending.metalAt) < 0.005
    ) {
      sliderPending.value = null;
    }
  },
);

function displayedSliderValue(kind: SliderKind): number {
  if (sliderDragging.value === kind) return sliderDragValue.value;
  const source = sliderPending.value ?? props.autoConversion;
  if (source == null) return 1;
  return kind === 'energy' ? source.energyAt : source.metalAt;
}

const energySliderStyle = computed(() => ({
  left: (displayedSliderValue('energy') * 100).toFixed(1) + '%',
}));
const metalSliderStyle = computed(() => ({
  left: (displayedSliderValue('metal') * 100).toFixed(1) + '%',
}));

function sliderFractionFromEvent(event: PointerEvent): number {
  const el = event.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

function beginSliderDrag(kind: SliderKind, event: PointerEvent): void {
  if (props.autoConversion == null) return;
  sliderDragging.value = kind;
  sliderDragValue.value = sliderFractionFromEvent(event);
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function updateSliderDrag(event: PointerEvent): void {
  if (sliderDragging.value === null) return;
  sliderDragValue.value = sliderFractionFromEvent(event);
}

function endSliderDrag(): void {
  const kind = sliderDragging.value;
  const current = sliderPending.value ?? props.autoConversion;
  if (kind === null || current == null) {
    sliderDragging.value = null;
    return;
  }
  const payload = {
    energyAt: kind === 'energy' ? sliderDragValue.value : current.energyAt,
    metalAt: kind === 'metal' ? sliderDragValue.value : current.metalAt,
  };
  sliderDragging.value = null;
  sliderPending.value = payload;
  emit('set-auto-conversion', payload);
}

function cancelSliderDrag(): void {
  sliderDragging.value = null;
}

const TOP_BAR = COLORS.ui.topBar;

// Unsigned magnitude format for the pull/income column. The column is
// right-aligned with a fixed ch width, so the value carries no padding.
function fmtMag(n: number): string {
  const abs = Math.abs(n);
  if (abs < 10) return abs.toFixed(1);
  return abs.toFixed(0);
}

function fmtStock(n: number): string {
  return Math.floor(n).toString();
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

// Style objects + formatted strings wrapped in computeds so Vue caches
// the returned identity across re-renders. Without these, every parent
// snapshot tick (TopBar receives economy props at 20 Hz) reallocates the
// inline `:style="{ ... }"` object and reruns each fmt*() template call,
// producing GC churn on otherwise unchanged values.
const energyBarStyle = computed(() => ({ width: energyPct.value + '%' }));
const metalBarStyle = computed(() => ({ width: metalPct.value + '%' }));
const topBarStyle = computed(() => ({
  '--hud-top-bar-height': `${HUD_TOP_BAR_HEIGHT_PX}px`,
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
  '--topbar-network-label': TOP_BAR.network.label,
  '--topbar-network-value': TOP_BAR.network.value,
  '--topbar-network-warning': TOP_BAR.network.warning,
  '--resource-energy-accent': RESOURCE_COLOR_CSS.energy,
  '--resource-metal-accent': RESOURCE_COLOR_CSS.metal,
  '--resource-bar-bg': TOP_BAR.resource.barBackground,
  '--resource-net-positive': TOP_BAR.resource.netPositive,
  '--resource-net-negative': TOP_BAR.resource.netNegative,
  '--resource-empty-flash': TOP_BAR.resource.emptyFlash,
  '--resource-empty-shell-bg': TOP_BAR.resource.emptyShellBackground,
  '--resource-empty-shell-border': TOP_BAR.resource.emptyShellBorder,
  '--resource-empty-shell-shadow': TOP_BAR.resource.emptyShellShadow,
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
      @click="closeCurrentTauriWindow"
    >EXIT</button>

    <div
      v-if="networkStatus || networkWarning"
      class="network-section"
      :class="{ warning: !!networkWarning }"
      :title="networkWarning || networkStatus"
    >
      <span class="network-label">NET</span>
      <span class="network-value">{{ networkWarning || networkStatus }}</span>
    </div>

    <div class="direction-slot">
      <WorldDirectionHud
        class="top-direction-widget"
        :data="directionData"
      />
    </div>

    <!-- Energy band: glyph | pull over income | stock over the bar, capacity at its end -->
    <div
      v-if="props.showEconomy !== false"
      class="resource-block energy-block"
      :class="{ 'resource-empty': isStockEmpty(economy.stockpile.curr) }"
    >
      <div class="resource-glyph">
        <span class="resource-icon">⚡</span>
        <span class="resource-label">ENERGY</span>
      </div>
      <div class="resource-flows">
        <span class="flow-value flow-pull" title="Energy consumption per second">−{{ energyConsumeDisplay }}</span>
        <span class="flow-value flow-income" title="Energy production per second">+{{ energyProduceDisplay }}</span>
      </div>
      <div class="resource-band">
        <div class="resource-row">
          <span class="resource-stock">{{ energyStockDisplay }}</span>
          <span class="resource-max">/ {{ economy.stockpile.max }}</span>
        </div>
        <div
          class="resource-bar-slider"
          :class="{ 'slider-enabled': autoConversion != null }"
          title="Auto-conversion point: energy above this line converts to metal"
          @pointerdown="beginSliderDrag('energy', $event)"
          @pointermove="updateSliderDrag"
          @pointerup="endSliderDrag"
          @pointercancel="cancelSliderDrag"
        >
          <div class="resource-bar">
            <div class="resource-bar-fill energy-fill" :style="energyBarStyle"></div>
          </div>
          <div
            v-if="autoConversion != null"
            class="slider-marker"
            :style="energySliderStyle"
          ></div>
        </div>
      </div>
    </div>

    <!-- Metal band -->
    <div
      v-if="props.showEconomy !== false"
      class="resource-block metal-block"
      :class="{ 'resource-empty': isStockEmpty(economy.metal.stockpile.curr) }"
    >
      <div class="resource-glyph">
        <span class="resource-icon">⛏</span>
        <span class="resource-label">METAL</span>
      </div>
      <div class="resource-flows">
        <span class="flow-value flow-pull" title="Metal consumption per second">−{{ metalConsumeDisplay }}</span>
        <span class="flow-value flow-income" title="Metal production per second">+{{ metalProduceDisplay }}</span>
      </div>
      <div class="resource-band">
        <div class="resource-row">
          <span class="resource-stock">{{ metalStockDisplay }}</span>
          <span class="resource-max">/ {{ economy.metal.stockpile.max }}</span>
        </div>
        <div
          class="resource-bar-slider"
          :class="{ 'slider-enabled': autoConversion != null }"
          title="Auto-conversion point: metal above this line converts to energy"
          @pointerdown="beginSliderDrag('metal', $event)"
          @pointermove="updateSliderDrag"
          @pointerup="endSliderDrag"
          @pointercancel="cancelSliderDrag"
        >
          <div class="resource-bar">
            <div class="resource-bar-fill metal-fill" :style="metalBarStyle"></div>
          </div>
          <div
            v-if="autoConversion != null"
            class="slider-marker"
            :style="metalSliderStyle"
          ></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* One band at BAR density: 44px tall, 6px gaps, translucent surface, no
   solid frame — a bottom hairline is the only edge. */
.top-bar {
  position: relative;
  width: max-content;
  max-width: calc(100vw - 24px);
  box-sizing: border-box;
  height: var(--hud-top-bar-height);
  background: var(--topbar-bg);
  border: 0;
  border-bottom: 1px solid var(--topbar-border);
  border-radius: 0 0 6px 6px;
  display: flex;
  align-items: center;
  padding: 0 6px;
  gap: 6px;
  font-family: monospace;
  color: var(--topbar-text);
  pointer-events: auto;
  overflow: hidden;
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
  padding: 0 8px;
  height: 26px;
  border: 1px solid var(--topbar-exit-border);
  border-radius: 4px;
  background: var(--topbar-exit-bg);
  color: var(--topbar-exit-text);
  font-family: monospace;
  font-size: 12px;
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

.network-section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 80px;
  max-width: 170px;
  padding-right: 6px;
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

/* Resource bands: glyph column | pull-over-income column | stock over the
   storage bar with the capacity at the bar's end. Everything rides the one
   bar row, BAR-style, instead of stacking four text rows. */
.resource-block {
  --resource-accent: var(--topbar-text);
  display: flex;
  align-items: center;
  min-width: 200px;
  gap: 5px;
  box-sizing: border-box;
  padding: 2px 4px;
  border: 1px solid transparent;
  border-radius: 3px;
}

.energy-block { --resource-accent: var(--resource-energy-accent); }
.metal-block { --resource-accent: var(--resource-metal-accent); }

.resource-glyph {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  flex: 0 0 auto;
  min-width: 34px;
  color: var(--resource-accent);
  line-height: 1;
}

.resource-icon {
  font-size: 16px;
  line-height: 1;
}

.resource-label {
  font-size: 8px;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-top: 1px;
}

.resource-flows {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  flex: 0 0 auto;
  min-width: 5ch;
  font-size: 11px;
  font-weight: bold;
  line-height: 1.15;
  white-space: nowrap;
}

.flow-value {
  color: var(--flow-color);
}

.flow-pull { --flow-color: var(--resource-net-negative); }
.flow-income { --flow-color: var(--resource-net-positive); }

.resource-band {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  gap: 0;
}

/* Stock centred over the bar (middle grid column), capacity flush to the
   bar's right end. */
.resource-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: baseline;
  white-space: nowrap;
  line-height: 1.05;
}

.resource-stock {
  grid-column: 2;
  color: var(--resource-accent);
  font-size: 17px;
  font-weight: bold;
}

.resource-max {
  grid-column: 3;
  justify-self: end;
  color: var(--topbar-subtle-text);
  font-size: 10px;
  font-weight: normal;
  padding-left: 6px;
}

.resource-bar-slider {
  position: relative;
  width: 100%;
  padding: 2px 0;
}

.slider-enabled {
  cursor: ew-resize;
  touch-action: none;
}

.slider-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 4px;
  margin-left: -2px;
  border-radius: 1px;
  background: var(--topbar-text);
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}

.resource-bar {
  width: 100%;
  height: 6px;
  background: var(--resource-bar-bg);
  border-radius: 1px;
  overflow: hidden;
}

.resource-bar-fill {
  height: 100%;
  background: var(--resource-accent);
  transition: width 0.2s ease;
}

.resource-empty {
  animation: resource-empty-shell 0.9s steps(1, end) infinite;
}

.resource-empty .resource-glyph,
.resource-empty .resource-stock {
  animation: resource-empty-accent-text 0.9s steps(1, end) infinite;
}

.resource-empty .resource-max {
  animation: resource-empty-subtle-text 0.9s steps(1, end) infinite;
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

@keyframes resource-empty-flow-value {
  0%, 49% {
    color: var(--resource-empty-flash);
  }
  50%, 100% {
    color: var(--flow-color);
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

</style>
