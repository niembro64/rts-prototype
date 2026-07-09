<script setup lang="ts">
import { computed, ref } from 'vue';
import { CLIENT_CONFIG, LOD_MODE_OPTIONS, isEntityHudElementSupported } from '../clientBarConfig';
import { GOOD_TPS } from '../config';
import {
  COMMAND_HOTKEY_DISPLAY_LABELS,
  COMMAND_HOTKEY_IDS,
  COMMAND_HOTKEY_PRESET_IDS,
  commandHotkeyLabel,
  createCommandHotkeyChordFromEvent,
  getCommandHotkeyConflicts,
  resetAllCustomCommandHotkeys,
  resetCustomCommandHotkeyBinding,
  setCustomCommandHotkeyBinding,
  type CommandHotkeyId,
  type CommandHotkeyPresetId,
} from '../game/input/commandHotkeys';
import { unitRosterDisplay } from '../game/sim/blueprints/displayRosters';
import { RESOURCE_BALL_DENSITY_OPTIONS } from '../resourceConfig';
import {
  presentationSnapshotRateHz,
  SPARSE_ENTITY_MOTION_SNAPSHOT_RATE_DEFAULT,
} from '../presentationSnapshotConfig';
import BarButton from './BarButton.vue';
import BarButtonGroup from './BarButtonGroup.vue';
import BarControlGroup from './BarControlGroup.vue';
import BarDivider from './BarDivider.vue';
import BarLabel from './BarLabel.vue';
import type { GameCanvasClientControlBarModel } from './gameCanvasControlBarModels';
import type { EntityHudElement, EntityHudType, LodMode, PathingDebugUnitId } from '../types/client';
import { fmt4, fmtBytes4, msBarStyle, statBarStyle } from './uiUtils';

const ENTITY_HUD_TYPE_LABELS: Record<EntityHudType, string> = {
  unit: 'UNIT',
  tower: 'TOWER',
  building: 'BLDG',
  turret: 'TURR',
  shot: 'SHOT',
};

const ENTITY_HUD_ELEMENT_LABELS: Record<EntityHudElement, string> = {
  name: 'NAME',
  healthBar: 'HP',
  buildBars: 'BUILD',
};

const ENTITY_HUD_ELEMENT_DESCRIPTIONS: Record<EntityHudElement, string> = {
  name: 'name',
  healthBar: 'health bar',
  buildBars: 'construction progress bars',
};

const COMMAND_HOTKEY_PRESET_LABELS: Record<CommandHotkeyPresetId, string> = {
  prototype: 'PROTO',
  'bar-grid': 'GRID',
  'bar-grid-60pct': 'GRID60',
  'bar-legacy': 'LEGACY',
  'bar-legacy-60pct': 'LEG60',
  custom: 'CUSTOM',
};

const COMMAND_HOTKEY_PRESET_DESCRIPTIONS: Record<CommandHotkeyPresetId, string> = {
  prototype: 'prototype defaults',
  'bar-grid': 'BAR grid subset',
  'bar-grid-60pct': 'BAR grid 60% subset',
  'bar-legacy': 'BAR legacy subset',
  'bar-legacy-60pct': 'BAR legacy 60% subset',
  custom: 'local custom bindings',
};

const LOD_MODE_TITLES: Record<LodMode, string> = {
  auto: 'Switch between HIGH and LOW at the configured camera distance',
  high: 'Never render unit, building, or tower level-of-detail proxies',
  low: 'Always render unit, building, and tower level-of-detail proxies',
};

const CAMERA_ANCHOR_SLOTS = [0, 1, 2, 3] as const;
const PATHING_DEBUG_UNIT_OPTIONS: readonly {
  readonly value: PathingDebugUnitId;
  readonly label: string;
  readonly title: string;
}[] = [
  { value: 'none', label: 'NONE', title: 'Clear unit pathability overlay' },
  ...unitRosterDisplay.map((unit) => ({
    value: unit.unitBlueprintId,
    label: unit.shortName,
    title: `Show valid pathfinding cells for ${unit.label}`,
  })),
];

const SNAPSHOT_REASONABLE_BYTES = 1024 * 1024;
const SNAPSHOT_SIZE_TARGET_RATIO_BUDGET = 1;
const SNAPSHOT_APPLY_REASONABLE_MS = 4;

function snapshotSizeTargetRatio(bytes: number, reasonableBytes: number): number {
  if (!Number.isFinite(bytes) || !Number.isFinite(reasonableBytes) || reasonableBytes <= 0) {
    return 0;
  }
  return Math.max(0, bytes / reasonableBytes);
}

function fmtRatio4(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 0.095) return value.toFixed(2);
  if (value < 9.95) return value.toFixed(1).replace(/\.0$/, '');
  if (value < 999.5) return `${Math.round(value)}`;
  const kilo = value / 1000;
  if (kilo < 9.95) return `${Math.round(kilo)}k`;
  return '9k';
}

function fmtCount4(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 999.5) return Math.round(value).toString();
  const thousands = value / 1000;
  if (thousands < 9.95) return `${thousands.toFixed(1)}k`;
  if (thousands < 999.5) return `${Math.round(thousands)}k`;
  const millions = thousands / 1000;
  if (millions < 9.95) return `${millions.toFixed(1)}m`;
  return `${Math.round(millions)}m`;
}

function richSnapshotTargetHz(model: GameCanvasClientControlBarModel): number {
  return presentationSnapshotRateHz(model.displaySnapshotRate, model.displayTickRate);
}

function totalSnapshotCadenceTitle(model: GameCanvasClientControlBarModel): string {
  return `EMA of snapshots consumed by the local renderer. ${fmt4(model.displayTickRate)} Hz is the fixed-step publication ceiling, not a required non-empty packet rate; rich snapshots target ${fmt4(richSnapshotTargetHz(model))} Hz and sparse deltas are event-driven.`;
}

function richSnapshotCadenceTitle(model: GameCanvasClientControlBarModel): string {
  return `Rich presentation snapshots carry server metadata and slower-changing presentation state. Target ${fmt4(richSnapshotTargetHz(model))} Hz from architecture.lockstep.presentationSnapshots.nominalSnapshotRateHz.`;
}

function deltaSnapshotCadenceTitle(model: GameCanvasClientControlBarModel): string {
  return `Sparse no-metadata deltas. Combined avg/low includes entity and projectile deltas. Entity motion has ${fmt4(SPARSE_ENTITY_MOTION_SNAPSHOT_RATE_DEFAULT)} Hz opportunities; projectile presentation deltas can emit up to ${fmt4(model.displayTickRate)} Hz during active combat. Empty opportunities do not count as SPS.`;
}

const props = defineProps<{
  model: GameCanvasClientControlBarModel;
}>();

const hotkeyEditorOpen = ref(false);
const captureCommandId = ref<CommandHotkeyId | null>(null);
const hotkeyEditorRevision = ref(0);

const currentHotkeyConflicts = computed(() => {
  void props.model.commandHotkeyRevision;
  return getCommandHotkeyConflicts(props.model.commandHotkeyPreset);
});
const hotkeyConflictLabel = computed(() => {
  const count = currentHotkeyConflicts.value.length;
  return count === 0 ? 'OK' : `${count} CONFLICT${count === 1 ? '' : 'S'}`;
});
const hotkeyConflictTitle = computed(() => {
  if (currentHotkeyConflicts.value.length === 0) {
    return 'The active command hotkey preset has no conflicting bindings.';
  }
  return currentHotkeyConflicts.value
    .map((conflict) => `${conflict.signature}: ${conflict.commandIds.join(' / ')}`)
    .join('\n');
});

const hotkeyEditorRows = computed(() => {
  void props.model.commandHotkeyRevision;
  void hotkeyEditorRevision.value;
  return COMMAND_HOTKEY_IDS.map((commandId) => ({
    commandId,
    label: COMMAND_HOTKEY_DISPLAY_LABELS[commandId],
    customKey: commandHotkeyLabel(commandId, 'custom'),
    activeKey: commandHotkeyLabel(commandId, props.model.commandHotkeyPreset),
    capturing: captureCommandId.value === commandId,
  }));
});

function toggleHotkeyEditor(): void {
  hotkeyEditorOpen.value = !hotkeyEditorOpen.value;
  if (!hotkeyEditorOpen.value) captureCommandId.value = null;
}

function beginHotkeyCapture(commandId: CommandHotkeyId): void {
  props.model.changeCommandHotkeyPreset('custom');
  hotkeyEditorOpen.value = true;
  captureCommandId.value = commandId;
}

function cancelHotkeyCapture(): void {
  captureCommandId.value = null;
}

function handleHotkeyCapture(commandId: CommandHotkeyId, event: KeyboardEvent): void {
  if (captureCommandId.value !== commandId) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') {
    cancelHotkeyCapture();
    return;
  }
  const chord = createCommandHotkeyChordFromEvent(event);
  if (chord === null) return;
  setCustomCommandHotkeyBinding(commandId, [chord]);
  props.model.changeCommandHotkeyPreset('custom');
  props.model.refreshCommandHotkeys();
  hotkeyEditorRevision.value += 1;
  captureCommandId.value = null;
}

function resetCustomHotkey(commandId: CommandHotkeyId): void {
  resetCustomCommandHotkeyBinding(commandId);
  props.model.changeCommandHotkeyPreset('custom');
  props.model.refreshCommandHotkeys();
  hotkeyEditorRevision.value += 1;
  if (captureCommandId.value === commandId) captureCommandId.value = null;
}

function resetEveryCustomHotkey(): void {
  resetAllCustomCommandHotkeys();
  props.model.changeCommandHotkeyPreset('custom');
  props.model.refreshCommandHotkeys();
  hotkeyEditorRevision.value += 1;
  captureCommandId.value = null;
}
</script>

<template>
  <div class="control-bar" :style="model.barStyle">
    <div class="bar-info">
      <BarButton
        :active="true"
        class="bar-label"
        title="Click to reset client settings to defaults"
        @click="model.resetClientDefaults"
      >
        <span class="bar-label-text">{{ model.clientLabel }}</span
        ><span class="bar-label-hover">DEFAULTS</span>
      </BarButton>
      <BarButton
        :active="model.playerClientEnabled"
        class="client-power-button"
        :title="model.playerClientEnabled ? `Turn ${model.clientLabel} game rendering off` : `Turn ${model.clientLabel} game rendering on`"
        @click="model.togglePlayerClientEnabled"
      >{{ model.playerClientEnabled ? 'ON' : 'OFF' }}</BarButton>
    </div>
    <div class="bar-controls">
      <BarControlGroup v-if="model.displayedClientTime">
        <BarDivider />
        <span
          class="time-display"
          title="Host-propagated client wall-clock time"
          >{{ model.displayedClientTime }}</span
        >
      </BarControlGroup>
      <BarControlGroup v-if="model.displayedClientIp">
        <BarDivider />
        <span
          class="ip-display"
          title="Host-propagated public IP address"
          >{{ model.displayedClientIp }}</span
        >
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>WAYPOINTS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.waypointDetail.options"
            :key="opt.value"
            :active="model.waypointDetail === opt.value"
            title="Waypoint visualization - SIMPLE shows only your click points; DETAILED shows the planner's intermediates too"
            @click="model.changeWaypointDetail(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Command hotkey preset used by keyboard dispatch and command-card labels.">KEYS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="presetId in COMMAND_HOTKEY_PRESET_IDS"
            :key="presetId"
            :active="model.commandHotkeyPreset === presetId"
            :title="`Use ${COMMAND_HOTKEY_PRESET_DESCRIPTIONS[presetId]} command hotkeys`"
            @click="model.changeCommandHotkeyPreset(presetId)"
          >{{ COMMAND_HOTKEY_PRESET_LABELS[presetId] }}</BarButton>
        </BarButtonGroup>
        <BarButton
          :active="hotkeyEditorOpen"
          title="Edit local custom command hotkeys"
          @click="toggleHotkeyEditor"
        >EDIT</BarButton>
        <BarLabel :title="hotkeyConflictTitle">CONFLICTS:</BarLabel>
        <span
          class="fps-value"
          :style="{ color: currentHotkeyConflicts.length > 0 ? '#ffb84d' : undefined }"
        >{{ hotkeyConflictLabel }}</span>
        <div
          v-if="hotkeyEditorOpen"
          class="hotkey-editor"
          @keydown.stop
        >
          <div class="hotkey-editor-header">
            <BarLabel title="Click BIND on a command, then press the desired key chord. Escape cancels capture.">CUSTOM KEYS:</BarLabel>
            <BarButton
              title="Reset every custom command binding to the prototype fallback"
              @click="resetEveryCustomHotkey"
            >RESET ALL</BarButton>
            <BarButton
              title="Close custom hotkey editor"
              @click="toggleHotkeyEditor"
            >CLOSE</BarButton>
          </div>
          <div class="hotkey-editor-grid">
            <div
              v-for="row in hotkeyEditorRows"
              :key="row.commandId"
              class="hotkey-editor-row"
              :class="{ capturing: row.capturing }"
            >
              <span class="hotkey-command">{{ row.label }}</span>
              <span
                class="hotkey-key"
                :title="`Active key: ${row.activeKey}`"
              >{{ row.capturing ? 'PRESS KEY' : row.customKey }}</span>
              <button
                type="button"
                class="hotkey-row-btn"
                :title="row.capturing ? 'Press a new key chord, or Escape to cancel' : `Bind ${row.label}`"
                @click="beginHotkeyCapture(row.commandId)"
                @keydown="handleHotkeyCapture(row.commandId, $event)"
              >BIND</button>
              <button
                type="button"
                class="hotkey-row-btn"
                :title="`Reset ${row.label} to prototype fallback`"
                @click="resetCustomHotkey(row.commandId)"
              >RESET</button>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>ENTITY HUD:</BarLabel>
        <BarLabel title="Current-selection HUD elements override the per-type toggles below for selected entities. ALL always shows them; OFF never does; DMG shows bars only when damaged or under construction.">SEL:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.selectionHudMode.options"
            :key="opt.value"
            :active="model.selectionHudMode === opt.value"
            :title="`Selection HUD: ${opt.label}.`"
            @click="model.changeSelectionHudMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
        <div class="entity-hud-grid">
          <div
            v-for="element in model.entityHudElements"
            :key="element"
            class="entity-hud-row"
          >
            <BarLabel>{{ ENTITY_HUD_ELEMENT_LABELS[element] }}:</BarLabel>
            <BarButtonGroup>
              <BarButton
                v-for="type in model.entityHudTypes"
                :key="type"
                :active="isEntityHudElementSupported(type, element) && model.entityHud[type][element]"
                :disabled="!isEntityHudElementSupported(type, element)"
                :title="isEntityHudElementSupported(type, element)
                  ? `Show ${ENTITY_HUD_ELEMENT_DESCRIPTIONS[element]} for ${ENTITY_HUD_TYPE_LABELS[type]}`
                  : `${ENTITY_HUD_ELEMENT_LABELS[element]} is not available for ${ENTITY_HUD_TYPE_LABELS[type]}`"
                @click="isEntityHudElementSupported(type, element) && model.toggleEntityHud(type, element)"
              >{{ ENTITY_HUD_TYPE_LABELS[type] }}</BarButton>
            </BarButtonGroup>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <div class="fps-stats">
          <BarLabel :title="`Canvas HUD sprite pools for bars, labels, and waypoint flags. Active ${model.hudSpriteActiveCount}, retained ${model.hudSpriteRetainedCount}, peak retained ${model.hudSpritePeakCount}, retained budget ${model.hudSpriteBudgetCount}, disposed ${model.hudSpriteDisposedCount}.`">HUD SPR:</BarLabel>
          <span class="fps-value">{{ model.hudSpriteActiveCount }}/{{ model.hudSpriteRetainedCount }}</span>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <div class="fps-stats">
          <BarLabel :title="`Scoped render mesh retention. Retained units ${model.scopedRetainedUnitMeshes}, retained buildings ${model.scopedRetainedBuildingMeshes}, hidden ${fmt4(model.scopedMeshHiddenPerSec)}/s, shown ${fmt4(model.scopedMeshReactivatedPerSec)}/s, scoped destroys ${fmt4(model.scopedMeshDestroyPerSec)}/s, scoped rebuilds ${fmt4(model.scopedMeshRebuildPerSec)}/s.`">SCOPE:</BarLabel>
          <span class="fps-value">{{ model.scopedRetainedUnitMeshes }}/{{ model.scopedRetainedBuildingMeshes }}</span>
          <span class="fps-label">u/b</span>
          <span class="fps-value">{{ fmt4(model.scopedMeshDestroyPerSec) }}/{{ fmt4(model.scopedMeshRebuildPerSec) }}</span>
          <span class="fps-label">d/r</span>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Client CPU - simulation prediction, input, HUD updates. Raw logicMs avg/hi in milliseconds per frame.">CPU:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.logicMsAvg) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.logicMsAvg)"></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.logicMsHi) }}</span>
              <span class="fps-label">hi</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.logicMsHi)"></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="`Client GPU - source: ${model.gpuSourceLabel}. Runtime ${model.runtimeProfile}; DPR ${fmt4(model.activePixelRatio)} / native ${fmt4(model.nativePixelRatio)} (${model.dynamicPixelRatioEnabled ? 'adaptive' : 'stable'}). Scene render-prep avg/hi ${fmt4(model.renderMsAvg)} / ${fmt4(model.renderMsHi)} ms. WebGL submit ${fmt4(model.webglRendererRenderMs)} ms. Timer-query (when supported) shows actual GPU-side execution time. WebGL contexts: main ${model.rendererContextMainCount}, auxiliary ${model.rendererContextAuxiliaryCount}/${model.rendererContextAuxiliaryBudget}, denied auxiliary ${model.rendererContextDeniedAuxiliaryCount}.`">GPU:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.displayGpuMs) }}</span>
              <span class="fps-label">
                {{ model.gpuTimerSupported ? 'hw' : 'cpu' }}
              </span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.displayGpuMs)"></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.renderMsHi) }}</span>
              <span class="fps-label">hi</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.renderMsHi)"></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <div class="fps-stats">
          <BarLabel :title="`Three/WebGL workload from the last completed draw. Draw calls ${model.webglDrawCalls}, triangles ${model.webglTriangles}, points ${model.webglPoints}, lines ${model.webglLines}, retained geometries ${model.webglGeometries}, textures ${model.webglTextures}.`">DRAW:</BarLabel>
          <span class="fps-value">{{ fmtCount4(model.webglDrawCalls) }}</span>
          <span class="fps-label">dc</span>
          <span class="fps-value">{{ fmtCount4(model.webglTriangles) }}</span>
          <span class="fps-label">tri</span>
          <span class="fps-value">{{ fmtCount4(model.webglPoints) }}</span>
          <span class="fps-label">pt</span>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <div class="fps-stats">
          <BarLabel :title="`WebGL buffer upload pressure from bufferData/bufferSubData during the last completed draw. Profiler ${model.webglBufferProfilerSupported ? 'active' : 'unavailable'}. bufferData calls ${model.webglBufferDataCalls}, bufferSubData calls ${model.webglBufferSubDataCalls}, upload bytes ${fmtBytes4(model.webglBufferUploadBytes)}, WebGL submit ${fmt4(model.webglRendererRenderMs)} ms.`">UPLOAD:</BarLabel>
          <span class="fps-value">{{ fmtBytes4(model.webglBufferUploadBytes) }}</span>
          <span class="fps-label">buf</span>
          <span class="fps-value">{{ fmtCount4(model.webglBufferDataCalls + model.webglBufferSubDataCalls) }}</span>
          <span class="fps-label">calls</span>
          <span class="fps-value">{{ fmt4(model.webglRendererRenderMs) }}</span>
          <span class="fps-label">ms</span>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Total frame time - CPU + GPU wall-clock per frame (ms)">FRAME:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.frameMsAvg) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.frameMsAvg)"></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.frameMsHi) }}</span>
              <span class="fps-label">hi</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.frameMsHi)"></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup v-if="model.longtaskSupported">
        <BarDivider />
        <BarLabel title="Long-task blocked time from PerformanceObserver - ms per second of wall-clock time lost to main-thread tasks >=50 ms. 0 = smooth; 200+ = heavy main-thread contention. Not available in Safari.">LONG:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.longtaskMsPerSec) }}</span>
              <span class="fps-label">ms/s</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.longtaskMsPerSec, 200)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="`${model.clientLabel} update-loop ticks per second. This includes prediction/input/render prep cadence.`">R-TPS:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.renderTpsAvg) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="statBarStyle(model.renderTpsAvg, GOOD_TPS)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.renderTpsWorst) }}</span>
              <span class="fps-label">low</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="statBarStyle(model.renderTpsWorst, GOOD_TPS)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <div class="fps-stats">
          <BarLabel title="Rendered camera-eye distance from the map center origin, in world units. Zoom-out is capped at the configured max map-center distance.">ZOOM:</BarLabel>
          <span class="fps-value">{{ fmt4(model.currentZoom) }}</span>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="totalSnapshotCadenceTitle(model)">TOTAL SPS:</BarLabel>
        <span class="fps-label">ceil {{ fmt4(model.displayTickRate) }}</span>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.snapAvgRate) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  statBarStyle(
                    model.snapAvgRate,
                    model.displayTickRate,
                  )
                "
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.snapWorstRate) }}</span>
              <span class="fps-label">low</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  statBarStyle(
                    model.snapWorstRate,
                    model.displayTickRate,
                  )
                "
              ></div>
            </div>
          </div>
        </div>
        <div class="snapshot-delta-split">
          <span title="Raw snapshots received from the connection over the telemetry sample window.">rx {{ fmt4(model.rawSnapshotReceivedRate) }}</span>
          <span title="Raw snapshots applied by ClientViewState over the telemetry sample window.">ap {{ fmt4(model.rawSnapshotAppliedRate) }}</span>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="richSnapshotCadenceTitle(model)">RICH SPS:</BarLabel>
        <span class="fps-label">tgt {{ fmt4(richSnapshotTargetHz(model)) }}</span>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.richSnapAvgRate) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  statBarStyle(
                    model.richSnapAvgRate,
                    richSnapshotTargetHz(model),
                  )
                "
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.richSnapWorstRate) }}</span>
              <span class="fps-label">low</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  statBarStyle(
                    model.richSnapWorstRate,
                    richSnapshotTargetHz(model),
                  )
                "
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="deltaSnapshotCadenceTitle(model)">DELTA SPS:</BarLabel>
        <span class="fps-label">ceil {{ fmt4(SPARSE_ENTITY_MOTION_SNAPSHOT_RATE_DEFAULT) }}/{{ fmt4(model.displayTickRate) }}</span>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.deltaSnapAvgRate) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  statBarStyle(
                    model.deltaSnapAvgRate,
                    model.displayTickRate,
                  )
                "
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.deltaSnapWorstRate) }}</span>
              <span class="fps-label">low</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  statBarStyle(
                    model.deltaSnapWorstRate,
                    model.displayTickRate,
                  )
                "
              ></div>
            </div>
          </div>
        </div>
        <div class="snapshot-delta-split">
          <span title="Entity motion delta snapshots. Target is the sparse entity motion rate.">ent {{ fmt4(model.entityDeltaSnapAvgRate) }}/{{ fmt4(model.entityDeltaSnapWorstRate) }}</span>
          <span title="Projectile delta snapshots. Target can rise to the fixed simulation tick rate during active projectile traffic.">proj {{ fmt4(model.projectileDeltaSnapAvgRate) }}/{{ fmt4(model.projectileDeltaSnapWorstRate) }}</span>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="`Encoded local snapshot payload size estimate before decode/unpack. Lockstep uses local snapshots for renderer input, not remote gameplay authority. Target ${fmtBytes4(SNAPSHOT_REASONABLE_BYTES)}; x is avg divided by target.`">SNAP SIZE:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtBytes4(model.snapshotSizeAvgBytes) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.snapshotSizeAvgBytes, SNAPSHOT_REASONABLE_BYTES)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtBytes4(model.snapshotSizeHiBytes) }}</span>
              <span class="fps-label">hi</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.snapshotSizeHiBytes, SNAPSHOT_REASONABLE_BYTES)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtRatio4(snapshotSizeTargetRatio(model.snapshotSizeAvgBytes, SNAPSHOT_REASONABLE_BYTES)) }}</span>
              <span class="fps-label">x</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  msBarStyle(
                    snapshotSizeTargetRatio(model.snapshotSizeAvgBytes, SNAPSHOT_REASONABLE_BYTES),
                    SNAPSHOT_SIZE_TARGET_RATIO_BUDGET,
                  )
                "
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Payload bytes for rich metadata-carrying presentation snapshots.">RICH BYTES:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtBytes4(model.richSnapshotSizeAvgBytes) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.richSnapshotSizeAvgBytes, SNAPSHOT_REASONABLE_BYTES)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtBytes4(model.richSnapshotSizeHiBytes) }}</span>
              <span class="fps-label">hi</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.richSnapshotSizeHiBytes, SNAPSHOT_REASONABLE_BYTES)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Payload bytes for sparse no-metadata entity/projectile deltas.">DELTA BYTES:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtBytes4(model.deltaSnapshotSizeAvgBytes) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.deltaSnapshotSizeAvgBytes, SNAPSHOT_REASONABLE_BYTES)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtBytes4(model.deltaSnapshotSizeHiBytes) }}</span>
              <span class="fps-label">hi</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.deltaSnapshotSizeHiBytes, SNAPSHOT_REASONABLE_BYTES)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="ClientViewState.applyNetworkState wall-clock cost split by all/rich/delta snapshots.">SNAP APPLY:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.snapshotApplyAvgMs) }}</span>
              <span class="fps-label">all</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.snapshotApplyAvgMs, SNAPSHOT_APPLY_REASONABLE_MS)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.richSnapshotApplyAvgMs) }}</span>
              <span class="fps-label">rich</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.richSnapshotApplyAvgMs, SNAPSHOT_APPLY_REASONABLE_MS)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.deltaSnapshotApplyAvgMs) }}</span>
              <span class="fps-label">delta</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.deltaSnapshotApplyAvgMs, SNAPSHOT_APPLY_REASONABLE_MS)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>EVENTS:</BarLabel>
        <BarButton
          :active="model.audioSmoothing"
          title="Smooth one-shot events and turret projectile spawns across snapshot intervals"
          @click="model.toggleAudioSmoothing"
        >SMOOTH</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>MARKS:</BarLabel>
        <BarButton
          :active="model.burnMarks"
          title="Draw beam, laser, and dgun scorch trails on the ground"
          @click="model.toggleBurnMarks"
        >BURN</BarButton>
        <BarButton
          :active="model.locomotionMarks"
          title="Draw wheel, tread, and footstep prints from unit movement"
          @click="model.toggleLocomotionMarks"
        >LOCO</BarButton>
        <BarButton
          :active="model.smokeTrails"
          title="Draw smoke-puff trails behind thrust-powered projectiles"
          @click="model.toggleSmokeTrails"
        >SMOKE</BarButton>
        <BarButton
          :active="model.smokeSoftEdges"
          title="Smoke-puff edge style — on: soft fog-style blobs; off: legacy hard-edged spheres"
          @click="model.toggleSmokeSoftEdges"
        >SOFT</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>VIS FX:</BarLabel>
        <BarButton
          :active="model.fogShade"
          title="Shade currently unseen terrain with a terrain-attached fog-of-war mask. Battle-level FOG OF WAR still controls visibility and snapshot filtering."
          @click="model.toggleFogShade"
        >SHADE</BarButton>
        <BarButton
          :active="model.fogClouds"
          title="Generate soft fog-of-war cloud puffs. Battle-level FOG OF WAR still controls visibility and snapshot filtering."
          @click="model.toggleFogClouds"
        >CLOUDS</BarButton>
        <BarButton
          :active="model.materialExplosions"
          title="Generate client-only death material explosions: death fire puff plus part-based debris chunks"
          @click="model.toggleMaterialExplosions"
        >MATEXP</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>LOD:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in LOD_MODE_OPTIONS"
            :key="opt.value"
            :active="model.lodMode === opt.value"
            :title="LOD_MODE_TITLES[opt.value]"
            @click="model.changeLodMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>BEAMS:</BarLabel>
        <BarButton
          :active="model.beamSnapToTurret"
          title="Snap beam origins to live rendered turret centers"
          @click="model.toggleBeamSnapToTurret"
        >TURRET</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Resource-ball density. Balls per second equals absolute resources per second multiplied by this scalar.">RES BALLS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in RESOURCE_BALL_DENSITY_OPTIONS"
            :key="opt.value"
            :active="model.resourceBallDensity === opt.value"
            :title="`Resource-ball density scalar ${opt.value}: balls/sec = resources/sec x ${opt.value}`"
            @click="model.changeResourceBallDensity(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Client prediction physics order: POS snaps to snapshot position only; VEL integrates server-reported velocity each frame. Acceleration is not on the wire, so there is no ACC mode.">PREDICT:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.predictionMode.options"
            :key="opt.value"
            :active="model.predictionMode === opt.value"
            :title="`Prediction physics: ${opt.label}.`"
            @click="model.changePredictionMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Movement position EMA. SNAP replaces every tick; FAST/MED/SLOW EMA toward the snapshot position with the named half-life.">MOV POS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.movementPosEma.options"
            :key="opt.value"
            :active="model.movementPosEma === opt.value"
            :title="`Movement position EMA: ${opt.label}.`"
            @click="model.changeMovementPosEma(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Movement velocity EMA. IGN ignores the snapshot velocity; SNAP replaces every tick; FAST/MED/SLOW EMA toward it with the named half-life.">MOV VEL:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.movementVelEma.options"
            :key="opt.value"
            :active="model.movementVelEma === opt.value"
            :title="`Movement velocity EMA: ${opt.label}.`"
            @click="model.changeMovementVelEma(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Rotation position EMA. Covers body yaw, hover orientation, and turret yaw/pitch. SNAP replaces every tick; FAST/MED/SLOW EMA toward the snapshot rotation with the named half-life.">ROT POS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.rotationPosEma.options"
            :key="opt.value"
            :active="model.rotationPosEma === opt.value"
            :title="`Rotation position EMA: ${opt.label}.`"
            @click="model.changeRotationPosEma(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Rotation velocity EMA. Covers body angular velocity and turret angular/pitch velocity. IGN ignores the snapshot angular velocity; SNAP replaces every tick; FAST/MED/SLOW EMA toward it with the named half-life.">ROT VEL:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.rotationVelEma.options"
            :key="opt.value"
            :active="model.rotationVelEma === opt.value"
            :title="`Rotation velocity EMA: ${opt.label}.`"
            @click="model.changeRotationVelEma(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Per-frame unit ground normal EMA on the client. Layered on top of the HOST SERVER UNIT GROUND NORMAL EMA - sim smooths first, then this knob smooths further at render cadence.">UNIT GROUND NORMAL EMA:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.unitGroundNormalEma.options"
            :key="opt.value"
            :active="model.clientUnitGroundNormalEmaMode === opt.value"
            :title="`Set client-side unit ground normal EMA to ${opt.label}.`"
            @click="model.changeClientUnitGroundNormalEmaMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>PAN:</BarLabel>
        <BarButton
          :active="model.allPanActive"
          title="Toggle all camera pan methods on/off"
          @click="model.toggleAllPan"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            :active="model.dragPanEnabled"
            title="Middle-click drag to pan camera"
            @click="model.toggleDragPan"
          >DRAG</BarButton>
          <BarButton
            :active="model.edgeScrollEnabled"
            title="Edge scroll - move camera when mouse near viewport border"
            @click="model.toggleEdgeScroll"
          >EDGE</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>DEBUG:</BarLabel>
        <BarButton
          :active="model.triangleDebug"
          title="TRIS - debug-color every terrain mesh triangle so triangle reduction and flat-tile optimization are visually obvious"
          @click="model.toggleTriangleDebug"
        >TRIS</BarButton>
        <BarButton
          :active="model.wallTriangleDebug"
          title="WALL TRIS - show only terrain triangles classified as D-PLATEAU wall faces"
          @click="model.toggleWallTriangleDebug"
        >WALL TRIS</BarButton>
        <BarButton
          :active="model.buildGridDebug"
          title="BUILD - show every fine build-placement cell using the same green/red/blue colors as the building ghost"
          @click="model.toggleBuildGridDebug"
        >BUILD</BarButton>
        <BarButton
          :active="model.airLiftProbeDebug"
          title="LIFT - show the five forward height probe points and vertical lines to sampled terrain/water for selected hover/flying units"
          @click="model.toggleAirLiftProbeDebug"
        >LIFT</BarButton>
        <BarButton
          :active="model.metalMap"
          title="METAL - show metal-producing build cells without the rest of the buildability grid"
          @click="model.toggleMetalMap"
        >METAL</BarButton>
        <BarButton
          :active="model.elevationMap"
          title="ELEV - colorize the terrain by elevation"
          @click="model.toggleElevationMap"
        >ELEV</BarButton>
        <BarButton
          :active="model.pathingMap"
          title="WATER - show cells blocked by water plus the configured shoreline buffer"
          @click="model.togglePathingMap"
        >WATER</BarButton>
        <BarDivider />
        <BarLabel>PATH:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in PATHING_DEBUG_UNIT_OPTIONS"
            :key="opt.value"
            :active="model.pathingDebugUnit === opt.value"
            :title="opt.title"
            @click="model.changePathingDebugUnit(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
        <BarButton
          :active="model.sightBoundary"
          title="SIGHT - draw the local player's total full-sight boundary"
          @click="model.toggleSightBoundary"
        >SIGHT</BarButton>
        <BarButton
          :active="model.radarBoundary"
          title="RADAR - draw radar-level coverage, including all SIGHT areas plus radar-only sensor areas"
          @click="model.toggleRadarBoundary"
        >RADAR</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>RENDER:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.render.options"
            :key="opt.value"
            :active="model.renderMode === opt.value"
            :title="
              opt.value === 'window'
                ? 'Render only visible window'
                : opt.value === 'padded'
                  ? 'Render window plus padding'
                  : 'Render entire map'
            "
            @click="model.changeRenderMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Water/map boundary presentation. INF extends water and perimeter terrain to a fake horizon; SQUARE cuts off the real map and renders water as a shallow cuboid; SEA uses the square cuboid with a solid dark-blue sea background.">WATER EDGE:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.waterBoundaryMode.options"
            :key="opt.value"
            :active="model.waterBoundaryMode === opt.value"
            :title="
              opt.value === 'infinity'
                ? 'Extend water and perimeter terrain outward into fake infinity'
                : opt.value === 'floating-square'
                  ? 'Cut off the map and show water as a slightly oversized cuboid below the real map'
                  : 'Use the square water cuboid and replace the sky/sun background with solid dark-blue sea'
            "
            @click="model.changeWaterBoundaryMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>AUDIO:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.audio.options"
            :key="opt.value"
            :active="model.audioScope === opt.value"
            :title="
              opt.value === 'window'
                ? 'Play audio from visible area'
                : opt.value === 'padded'
                  ? 'Play audio from visible area plus padding'
                  : 'Play audio from entire map'
            "
            @click="model.changeAudioScope(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>VOL:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.masterVolume.options"
            :key="opt.value"
            :active="model.masterVolume === opt.value"
            :title="`Set master volume to ${opt.value}%`"
            @click="model.changeMasterVolume(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>SOUNDS:</BarLabel>
        <BarButton
          :active="model.allSoundsActive"
          title="Toggle all sound categories on/off"
          @click="model.toggleAllSounds"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            v-for="cat in model.sfxCategories"
            :key="cat"
            :active="model.soundToggles[cat]"
            :title="model.soundTooltips[cat]"
            @click="model.toggleSoundCategory(cat)"
          >{{ model.soundLabels[cat] }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>MUSIC:</BarLabel>
        <BarButton
          :active="model.soundToggles.music"
          :title="model.soundTooltips.music"
          @click="model.toggleSoundCategory('music')"
        >{{ model.soundToggles.music ? 'ON' : 'OFF' }}</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>TURR CIR:</BarLabel>
        <BarButton
          :active="model.allRangesActive"
          title="Toggle every 2D turret/build circle viz on/off"
          @click="model.toggleAllRanges"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            :active="model.rangeToggles.trackAcquire"
            title="Show tracking acquire circle (2D ground-plane start tracking target range)"
            @click="model.toggleRange('trackAcquire')"
          >T.A</BarButton>
          <BarButton
            :active="model.rangeToggles.trackRelease"
            title="Show tracking release circle (2D ground-plane lose target range)"
            @click="model.toggleRange('trackRelease')"
          >T.R</BarButton>
          <BarButton
            :active="model.rangeToggles.engageAcquire"
            title="Show engage acquire circle (2D ground-plane start firing range)"
            @click="model.toggleRange('engageAcquire')"
          >E.A</BarButton>
          <BarButton
            :active="model.rangeToggles.engageRelease"
            title="Show engage release circle (2D ground-plane stop firing range)"
            @click="model.toggleRange('engageRelease')"
          >E.R</BarButton>
          <BarButton
            :active="model.rangeToggles.engageMinAcquire"
            title="Show minimum engage acquire circle (2D inner dead-zone start firing boundary)"
            @click="model.toggleRange('engageMinAcquire')"
          >M.A</BarButton>
          <BarButton
            :active="model.rangeToggles.engageMinRelease"
            title="Show minimum engage release circle (2D inner dead-zone stop firing boundary)"
            @click="model.toggleRange('engageMinRelease')"
          >M.R</BarButton>
          <BarButton
            :active="model.rangeToggles.build"
            title="Show build circle (2D ground-plane builder range)"
            @click="model.toggleRange('build')"
          >BLD</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>SHOT SPH:</BarLabel>
        <BarButton
          :active="model.allProjRangesActive"
          title="Toggle every 3D projectile sphere viz on/off"
          @click="model.toggleAllProjRanges"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            :active="model.projRangeToggles.collision"
            title="Show projectile collision sphere (3D hit volume)"
            @click="model.toggleProjRange('collision')"
          >COL</BarButton>
          <BarButton
            :active="model.projRangeToggles.explosion"
            title="Show projectile explosion sphere (3D splash volume)"
            @click="model.toggleProjRange('explosion')"
          >EXP</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>HOST SPH:</BarLabel>
        <BarButton
          :active="model.allUnitRadiiActive"
          title="Toggle every 3D host sphere viz on/off"
          @click="model.toggleAllUnitRadii"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            :active="model.unitRadiusToggles.other"
            title="Show host body sphere (radius.other - outer/render extent: mesh size, LOD distance, selection volume)"
            @click="model.toggleUnitRadius('other')"
          >BODY</BarButton>
          <BarButton
            :active="model.unitRadiusToggles.hitbox"
            title="Show host hitbox sphere (radius.hitbox - projectile/beam hit detection)"
            @click="model.toggleUnitRadius('hitbox')"
          >HIT</BarButton>
          <BarButton
            :active="model.unitRadiusToggles.collision"
            title="Show host collision sphere (radius.collision - collision physics, ground-click selection fallback)"
            @click="model.toggleUnitRadius('collision')"
          >COL</BarButton>
          <BarButton
            :active="model.unitRadiusToggles.shotArmingRadius"
            title="Show host projectile arming sphere (radius.shotArmingRadius - shots arm after leaving this safe zone)"
            @click="model.toggleUnitRadius('shotArmingRadius')"
          >ARM</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>LEGS:</BarLabel>
        <BarButton
          :active="model.legsRadiusToggle"
          title="Show each leg's rest circle (chassis-local - the foot wanders inside this radius before snapping to the opposite edge)"
          @click="model.toggleLegsRadius"
        >RAD</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Main 3D camera vertical field-of-view in degrees. Lower is narrower/telephoto; higher is wider-angle.">FOV:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.cameraFov.options"
            :key="opt.value"
            :active="model.cameraFovDegrees === opt.value"
            :title="`Set camera field-of-view to ${opt.value} degrees`"
            @click="model.changeCameraFovDegrees(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>CAMERA:</BarLabel>
        <BarButtonGroup>
          <BarButton
            :active="model.cameraSmoothMode === 'snap'"
            title="Zoom and pan apply instantly - original behavior, no animation"
            @click="model.setCameraMode('snap')"
          >SNAP</BarButton>
          <BarButton
            :active="model.cameraSmoothMode === 'fast'"
            title="Zoom and pan ease with EMA tau around 50 ms - quick settle"
            @click="model.setCameraMode('fast')"
          >FAST</BarButton>
          <BarButton
            :active="model.cameraSmoothMode === 'mid'"
            title="Zoom and pan ease with EMA tau around 120 ms - default-feeling smoothness"
            @click="model.setCameraMode('mid')"
          >MID</BarButton>
          <BarButton
            :active="model.cameraSmoothMode === 'slow'"
            title="Zoom and pan ease with EMA tau around 400 ms - deliberate, weighty feel"
            @click="model.setCameraMode('slow')"
          >SLOW</BarButton>
        </BarButtonGroup>
        <BarButtonGroup>
          <BarButton
            :active="false"
            title="Switch to a steep overhead camera angle without changing the current target or zoom"
            @click="model.setCameraViewMode('overhead')"
          >TOP</BarButton>
          <BarButton
            :active="false"
            title="Switch to the default Total Annihilation-style RTS camera angle"
            @click="model.setCameraViewMode('ta')"
          >TA</BarButton>
          <BarButton
            :active="false"
            title="Switch to a shallower Spring-style 3D camera angle"
            @click="model.setCameraViewMode('spring')"
          >SPR</BarButton>
        </BarButtonGroup>
        <BarButton
          :active="false"
          title="Rotate the camera view 180 degrees around the current target"
          @click="model.flipCameraYaw"
        >FLIP</BarButton>
        <BarDivider />
      </BarControlGroup>
      <BarControlGroup>
        <BarLabel>ANCHOR:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="slot in CAMERA_ANCHOR_SLOTS"
            :key="`save-${slot}`"
            :active="false"
            :title="`Save camera anchor ${slot + 1}`"
            @click="model.setCameraAnchor(slot)"
          >S{{ slot + 1 }}</BarButton>
        </BarButtonGroup>
        <BarButtonGroup>
          <BarButton
            v-for="slot in CAMERA_ANCHOR_SLOTS"
            :key="`focus-${slot}`"
            :active="false"
            :title="`Focus camera anchor ${slot + 1}`"
            @click="model.focusCameraAnchor(slot)"
          >{{ slot + 1 }}</BarButton>
        </BarButtonGroup>
        <BarDivider />
      </BarControlGroup>
      <BarControlGroup>
        <BarLabel>SCREEN:</BarLabel>
        <BarButton
          :active="model.optionsMenuOpen"
          :title="`Open options menu (${commandHotkeyLabel('ui.optionsMenu', model.commandHotkeyPreset)})`"
          @click="model.toggleOptionsMenu"
        >OPTS</BarButton>
        <BarButton
          :active="model.fullscreenActive"
          :title="model.fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'"
          @click="model.toggleFullscreen"
        >FULL</BarButton>
        <BarButton
          :active="false"
          title="Save the current game canvas as a PNG screenshot"
          @click="model.captureScreenshot"
        >SHOT</BarButton>
        <BarButton
          :active="model.uiChromeVisible"
          :title="model.uiChromeVisible ? 'Hide game UI chrome' : 'Show game UI chrome'"
          @click="model.toggleUiChrome"
        >UI</BarButton>
        <BarDivider />
      </BarControlGroup>
      <BarControlGroup>
        <BarLabel>SPEED:</BarLabel>
        <BarButton
          :active="false"
          title="Pause the lockstep simulation"
          @click="model.setGamePaused(true)"
        >PAUSE</BarButton>
        <BarButton
          :active="false"
          title="Resume the lockstep simulation"
          @click="model.setGamePaused(false)"
        >PLAY</BarButton>
        <BarDivider />
      </BarControlGroup>
      <BarControlGroup>
        <BarLabel>MAP:</BarLabel>
        <BarButton
          :active="false"
          title="Switch to an overhead map overview"
          @click="model.showMapOverview"
        >OVR</BarButton>
        <BarButton
          :active="model.mapDetailsVisible"
          title="Show map details"
          @click="model.toggleMapDetails"
        >INFO</BarButton>
        <BarButton
          :active="false"
          title="Move the camera to the latest ping or scanner marker"
          @click="model.goToLastPing"
        >PING</BarButton>
        <BarDivider />
      </BarControlGroup>
      <BarControlGroup>
        <BarLabel title="Camera follow for a single selected unit. Only active when exactly one unit is selected; eases through the CAMERA smoothing above, so switching modes transitions smoothly.">FOLLOW:</BarLabel>
        <BarButtonGroup>
          <BarButton
            :active="model.cameraFollowMode === 'free'"
            title="Camera is controlled only by the mouse - default behavior"
            @click="model.setCameraFollowMode('free')"
          >FREE</BarButton>
          <BarButton
            :active="model.cameraFollowMode === 'follow'"
            title="Glide the camera to keep the selected unit centered, preserving the current distance, yaw, and pitch"
            @click="model.setCameraFollowMode('follow')"
          >UNIT</BarButton>
          <BarButton
            :active="model.cameraFollowMode === 'follow-behind'"
            title="Keep the camera behind the selected unit, looking down its forward axis, preserving the current distance and pitch"
            @click="model.setCameraFollowMode('follow-behind')"
          >BEHIND</BarButton>
        </BarButtonGroup>
        <BarDivider />
      </BarControlGroup>
    </div>
  </div>
</template>

<style scoped>
/* Compact 3-row entity-HUD matrix: one row per HUD element (NAME / HP /
 * BUILD), each row a connected 6-button pill across the entity types. The
 * rows stack vertically inside the surrounding flex control-group. */
.entity-hud-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.entity-hud-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.snapshot-delta-split {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 88px;
  color: #aeb8c6;
  font-size: 10px;
  white-space: nowrap;
}

.hotkey-editor {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px;
  max-width: min(780px, calc(100vw - 36px));
  max-height: 260px;
  overflow: auto;
  background: rgba(18, 20, 24, 0.96);
  border: 1px solid rgba(150, 160, 172, 0.35);
}

.hotkey-editor-header {
  display: flex;
  align-items: center;
  gap: 5px;
  position: sticky;
  top: 0;
  z-index: 1;
  padding-bottom: 3px;
  background: rgba(18, 20, 24, 0.96);
}

.hotkey-editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(250px, 1fr));
  gap: 4px;
}

.hotkey-editor-row {
  display: grid;
  grid-template-columns: minmax(116px, 1fr) 72px 44px 52px;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  padding: 2px 4px;
  background: rgba(44, 48, 54, 0.86);
  border: 1px solid rgba(120, 128, 138, 0.25);
  color: #cfd6df;
}

.hotkey-editor-row.capturing {
  border-color: var(--bar-active-border);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
}

.hotkey-command {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.hotkey-key {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #fff;
  font-size: 11px;
  text-align: center;
}

.hotkey-row-btn {
  min-width: 0;
  height: 20px;
  padding: 2px 5px;
  border: 1px solid rgba(130, 140, 152, 0.45);
  border-radius: 2px;
  background: rgba(58, 62, 70, 0.95);
  color: #d8dde5;
  font: inherit;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}

.hotkey-row-btn:hover,
.hotkey-row-btn:focus-visible {
  border-color: var(--bar-active-border);
  color: #fff;
}

@media (max-width: 720px) {
  .hotkey-editor-grid {
    grid-template-columns: minmax(250px, 1fr);
  }
}
</style>
