<script setup lang="ts">
// Hold-I unit stats peek (BAR gui_unit_stats parity).
//
// Shown by GameCanvas while the ui.unitStats hotkey is held (BAR registers
// press+release actions for "unit_stats" — hold, not toggle). Follows the
// cursor like the BAR widget; content is display-only blueprint data plus
// the live hp / production fields already on ClientViewState.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { COLORS } from '@/colorsConfig';
import type {
  UnitStatsOverlayInfo,
  UnitStatsWeaponInfo,
} from '../game/scenes/helpers';

const props = defineProps<{
  info: UnitStatsOverlayInfo;
}>();

const SELECTION_PANEL = COLORS.ui.selectionPanel;

const overlayRootStyle = computed(() => ({
  '--unit-stats-bg': SELECTION_PANEL.surface.background,
  '--unit-stats-border': SELECTION_PANEL.surface.border,
  '--unit-stats-text': SELECTION_PANEL.surface.text,
  '--unit-stats-label': SELECTION_PANEL.surface.label,
  '--unit-stats-header-border': SELECTION_PANEL.surface.headerBorder,
  '--unit-stats-energy': SELECTION_PANEL.cost.energy,
  '--unit-stats-metal': SELECTION_PANEL.cost.resource,
  left: `${panelLeft.value}px`,
  top: `${panelTop.value}px`,
}) as const);

// Cursor following (BAR draws at mouse + offset). The overlay only exists
// while the key is held, so the mousemove listener life is the hold.
const CURSOR_OFFSET_X = 26;
const CURSOR_OFFSET_Y = 20;
const PANEL_MAX_WIDTH = 340;
const PANEL_EDGE_MARGIN = 8;

const cursorX = ref(Math.floor(window.innerWidth / 2));
const cursorY = ref(Math.floor(window.innerHeight / 2));
const panelHeight = ref(160);
const panelRef = ref<HTMLElement | null>(null);

const panelLeft = computed(() => {
  const flip = cursorX.value + CURSOR_OFFSET_X + PANEL_MAX_WIDTH + PANEL_EDGE_MARGIN > window.innerWidth;
  const left = flip
    ? cursorX.value - CURSOR_OFFSET_X - PANEL_MAX_WIDTH
    : cursorX.value + CURSOR_OFFSET_X;
  return Math.max(PANEL_EDGE_MARGIN, left);
});

const panelTop = computed(() => {
  const top = cursorY.value + CURSOR_OFFSET_Y;
  return Math.max(
    PANEL_EDGE_MARGIN,
    Math.min(top, window.innerHeight - panelHeight.value - PANEL_EDGE_MARGIN),
  );
});

function handleMouseMove(event: MouseEvent): void {
  cursorX.value = event.clientX;
  cursorY.value = event.clientY;
  panelHeight.value = panelRef.value?.offsetHeight ?? panelHeight.value;
}

onMounted(() => {
  window.addEventListener('mousemove', handleMouseMove);
});

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', handleMouseMove);
});

function fmt(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 100) return `${Math.round(value)}`;
  if (Math.abs(value) >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/\.?0+$/, '');
}

const hpPercent = computed(() =>
  props.info.maxHp > 0 ? Math.round((props.info.hp / props.info.maxHp) * 100) : 0,
);

const kindLabel = computed(() => props.info.kind.toUpperCase());

function weaponHeading(weapon: UnitStatsWeaponInfo): string {
  const count = weapon.count > 1 ? `${weapon.count}× ` : '';
  const emission = weapon.emission !== null && weapon.emission !== weapon.kind
    ? ` · ${weapon.emission}`
    : '';
  return `${count}${weapon.name} — ${weapon.kind}${emission}`;
}

function weaponNumbers(weapon: UnitStatsWeaponInfo): string {
  const parts: string[] = [`RNG ${fmt(weapon.range)}`];
  if (weapon.cooldownMs !== null && weapon.cooldownMs > 0) {
    parts.push(`CD ${fmt(weapon.cooldownMs / 1000)}s`);
  }
  if (weapon.volleyDamage !== null) parts.push(`DMG ${fmt(weapon.volleyDamage)}`);
  if (weapon.dps !== null) parts.push(`DPS ${fmt(weapon.dps)}`);
  return parts.join(' · ');
}
</script>

<template>
  <div
    ref="panelRef"
    class="unit-stats-overlay"
    :style="overlayRootStyle"
    role="status"
    aria-live="polite"
  >
    <div class="stats-header">
      <span class="stats-name">{{ info.name }}</span>
      <span class="stats-kind">{{ kindLabel }}</span>
    </div>
    <div class="stats-sub">{{ info.blueprintId }}</div>

    <div class="stats-row">
      <span class="stats-label">HP</span>
      <span>{{ fmt(info.hp) }} / {{ fmt(info.maxHp) }} ({{ hpPercent }}%)</span>
    </div>
    <div
      v-if="info.costEnergy !== null || info.costMetal !== null"
      class="stats-row"
    >
      <span class="stats-label">Cost</span>
      <span>
        <span class="stats-energy">E {{ fmt(info.costEnergy ?? 0) }}</span>
        <span class="stats-metal"> · M {{ fmt(info.costMetal ?? 0) }}</span>
      </span>
    </div>
    <div
      v-if="info.mass !== null"
      class="stats-row"
    >
      <span class="stats-label">Mass</span>
      <span>{{ fmt(info.mass) }}</span>
    </div>
    <div
      v-if="info.locomotion !== null"
      class="stats-row"
    >
      <span class="stats-label">Move</span>
      <span>{{ info.locomotion.type }} · force {{ fmt(info.locomotion.force) }} · traction {{ fmt(info.locomotion.traction) }}</span>
    </div>

    <template v-if="info.weapons.length > 0">
      <div class="stats-section">Weapons</div>
      <div
        v-for="weapon in info.weapons"
        :key="weapon.turretBlueprintId"
        class="stats-weapon"
      >
        <div class="stats-weapon-name">{{ weaponHeading(weapon) }}</div>
        <div class="stats-weapon-numbers">{{ weaponNumbers(weapon) }}</div>
      </div>
    </template>

    <template v-if="info.factory !== null">
      <div class="stats-section">Production</div>
      <div class="stats-row">
        <span class="stats-label">Building</span>
        <span v-if="info.factory.currentUnitLabel !== null">
          {{ info.factory.currentUnitLabel }} ({{ Math.round(info.factory.progress * 100) }}%)
        </span>
        <span v-else>—</span>
      </div>
      <div class="stats-row">
        <span class="stats-label">Queue</span>
        <span>
          {{ info.factory.queueLength }}
          <template v-if="info.factory.repeat"> · repeat</template>
          <template v-if="!info.factory.isProducing"> · idle</template>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.unit-stats-overlay {
  position: fixed;
  width: max-content;
  max-width: 340px;
  padding: 6px 9px;
  background: var(--unit-stats-bg);
  border: 1px solid var(--unit-stats-border);
  border-radius: 4px;
  font-family: monospace;
  font-size: 11px;
  line-height: 1.45;
  color: var(--unit-stats-text);
  pointer-events: none;
  z-index: 1200;
}

.stats-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  font-weight: bold;
}

.stats-kind {
  font-size: 9px;
  font-weight: normal;
  letter-spacing: 0.08em;
  color: var(--unit-stats-label);
}

.stats-sub {
  font-size: 9px;
  color: var(--unit-stats-label);
  margin-bottom: 4px;
  padding-bottom: 3px;
  border-bottom: 1px solid var(--unit-stats-header-border);
}

.stats-row {
  display: flex;
  gap: 8px;
}

.stats-label {
  flex: 0 0 52px;
  color: var(--unit-stats-label);
}

.stats-energy {
  color: var(--unit-stats-energy);
}

.stats-metal {
  color: var(--unit-stats-metal);
}

.stats-section {
  margin-top: 4px;
  padding-top: 3px;
  border-top: 1px solid var(--unit-stats-header-border);
  font-size: 9px;
  font-weight: bold;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--unit-stats-label);
}

.stats-weapon-name {
  font-weight: bold;
}

.stats-weapon-numbers {
  padding-left: 10px;
  color: var(--unit-stats-text);
}
</style>
