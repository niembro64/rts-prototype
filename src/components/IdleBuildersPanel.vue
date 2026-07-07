<script setup lang="ts">
// Idle-builders HUD panel (BAR gui_idle_builders parity).
//
// One chip per idle-builder blueprint with a live count badge. Hidden when
// nothing is idle (BAR's default alwaysShow=false). Interactions:
//   left-click        select next idle builder of the type (cycles) + center camera
//   Shift+left-click  add all idle builders of the type to the selection
//   right-click       center camera on the next idle builder without selecting
// (BAR's right-click selects AND centers; here right-click is a pure camera
// peek per the panel spec — left-click already selects.)
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { COLORS } from '@/colorsConfig';
import type { IdleBuilderGroupInfo } from '../game/scenes/helpers';
import {
  getCachedEntityThumbnail,
  requestEntityThumbnail,
  subscribeEntityThumbnailCache,
} from './entityPreviewThumbnails';
import type { LoadingEntityBlueprintId } from './loadingUnitPreview3d';

const props = defineProps<{
  groups: IdleBuilderGroupInfo[];
  playableBottomInsetPx: number;
}>();

const emit = defineEmits<{
  (e: 'cycle', unitBlueprintId: string): void;
  (e: 'addAll', unitBlueprintId: string): void;
  (e: 'center', unitBlueprintId: string): void;
}>();

const SELECTION_PANEL = COLORS.ui.selectionPanel;
const BUTTON_COLORS = SELECTION_PANEL.buttons;

const panelStyle = computed(() => ({
  '--idle-builders-bg': SELECTION_PANEL.surface.background,
  '--idle-builders-border': SELECTION_PANEL.surface.border,
  '--idle-builders-text': SELECTION_PANEL.surface.text,
  '--idle-builders-label': SELECTION_PANEL.surface.label,
  '--idle-builders-button-bg': BUTTON_COLORS.background,
  '--idle-builders-button-border': BUTTON_COLORS.border,
  '--idle-builders-button-hover-bg': BUTTON_COLORS.hoverBackground,
  '--idle-builders-playable-bottom': `${Math.max(0, Math.round(props.playableBottomInsetPx))}px`,
}) as const);

// Same async unit-thumbnail cache the SelectionPanel build menu uses.
const thumbnailRevision = ref(0);
let unsubscribeEntityThumbnails: (() => void) | null = null;

onMounted(() => {
  unsubscribeEntityThumbnails = subscribeEntityThumbnailCache(() => {
    thumbnailRevision.value++;
  });
});

onUnmounted(() => {
  unsubscribeEntityThumbnails?.();
  unsubscribeEntityThumbnails = null;
});

watch(
  () => props.groups,
  (groups) => {
    for (const group of groups) {
      void requestEntityThumbnail('unit', group.unitBlueprintId as LoadingEntityBlueprintId);
    }
  },
  { immediate: true },
);

function chipThumbnail(unitBlueprintId: string): string | null {
  void thumbnailRevision.value;
  return getCachedEntityThumbnail('unit', unitBlueprintId as LoadingEntityBlueprintId);
}

function chipTitle(group: IdleBuilderGroupInfo): string {
  return `${group.count}× ${group.label} idle\n`
    + 'Click: select next + center camera\n'
    + 'Shift+Click: add all to selection\n'
    + 'Right-click: center camera only';
}

function handleChipClick(group: IdleBuilderGroupInfo, event: MouseEvent): void {
  if (event.shiftKey) emit('addAll', group.unitBlueprintId);
  else emit('cycle', group.unitBlueprintId);
}
</script>

<template>
  <div
    v-if="groups.length > 0"
    class="idle-builders-panel"
    :style="panelStyle"
    role="toolbar"
    aria-label="Idle builders"
  >
    <span class="idle-builders-title">IDLE</span>
    <button
      v-for="group in groups"
      :key="group.unitBlueprintId"
      type="button"
      class="idle-builder-chip"
      :title="chipTitle(group)"
      @click="handleChipClick(group, $event)"
      @contextmenu.prevent="emit('center', group.unitBlueprintId)"
    >
      <img
        v-if="chipThumbnail(group.unitBlueprintId)"
        class="chip-icon"
        :src="chipThumbnail(group.unitBlueprintId) ?? undefined"
        :alt="group.label"
        draggable="false"
      >
      <span
        v-else
        class="chip-icon chip-icon-fallback"
      >{{ group.shortName }}</span>
      <span
        v-if="group.count > 1"
        class="chip-count"
      >{{ group.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.idle-builders-panel {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: var(--idle-builders-playable-bottom, 0px);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  background: var(--idle-builders-bg);
  border: 1px solid var(--idle-builders-border);
  border-radius: 4px 4px 0 0;
  font-family: monospace;
  color: var(--idle-builders-text);
  pointer-events: auto;
  z-index: 1000;
}

.idle-builders-title {
  font-size: 10px;
  font-weight: bold;
  letter-spacing: 0.08em;
  color: var(--idle-builders-label);
  margin-right: 2px;
  user-select: none;
}

.idle-builder-chip {
  position: relative;
  display: grid;
  place-items: center;
  width: clamp(30px, 3.6vh, 42px);
  height: clamp(30px, 3.6vh, 42px);
  padding: 0;
  background: var(--idle-builders-button-bg);
  border: 1px solid var(--idle-builders-button-border);
  border-radius: 3px;
  color: var(--idle-builders-text);
  cursor: pointer;
  overflow: hidden;
}

.idle-builder-chip:hover {
  background: var(--idle-builders-button-hover-bg);
}

.chip-icon {
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

.chip-icon-fallback {
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: bold;
}

.chip-count {
  position: absolute;
  right: 1px;
  bottom: 0;
  padding: 0 2px;
  font-size: 10px;
  font-weight: bold;
  line-height: 1.2;
  background: rgba(0, 0, 0, 0.62);
  border-radius: 2px;
  color: #f0f0f0;
  pointer-events: none;
}
</style>
