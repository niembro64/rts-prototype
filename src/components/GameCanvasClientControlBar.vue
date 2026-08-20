<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  AA_MSAA_MODE_OPTIONS,
  AA_RESOLUTION_MODE_OPTIONS,
  CLIENT_CONFIG,
  LOD_MODE_OPTIONS,
} from '../clientBarConfig';
import { BATTLE_CONFIG } from '../battleBarConfig';
import { AUDIO_ENABLED, GOOD_TPS, ZOOM_MAX_MAP_CENTER_DISTANCE } from '../config';
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
import BarButton from './BarButton.vue';
import BarButtonGroup from './BarButtonGroup.vue';
import BarControlGroup from './BarControlGroup.vue';
import BarDivider from './BarDivider.vue';
import BarLabel from './BarLabel.vue';
import type { GameCanvasClientControlBarModel } from './gameCanvasControlBarModels';
import type {
  AntialiasMsaaMode,
  AntialiasResolutionMode,
  BuildGridDebugMode,
  LodMode,
  PathingDebugMode,
  PathingDebugUnitId,
} from '../types/client';
import {
  budgetBarStyle,
  fmt4,
  fmtBytes4,
  msBarStyle,
  statBarStyle,
} from './uiUtils';

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
  auto: 'Choose HIGH, MED, LOW, or OFF automatically from projected screen size',
  high: 'Freeze all visual detail at the high-resolution rung',
  medium: 'Freeze all visual detail at the medium-resolution rung',
  low: 'Freeze all visual detail at the low-resolution rung',
  off: 'Hide models: show entity strategic shapes and remove trees and grass',
};

const AA_MSAA_MODE_TITLES: Record<AntialiasMsaaMode, string> = {
  default: 'Draw straight into the canvas. MSAA is whatever the browser granted the WebGL context hint — usually 4x, never adjustable after creation.',
  '4x': 'Draw the scene into an explicit 4x multisampled offscreen target and present it with a raw copy pass. Applies live.',
  '8x': 'Draw the scene into an explicit 8x multisampled offscreen target and present it with a raw copy pass — double the default edge quality. Clamped to the GPU MAX_SAMPLES. Applies live.',
  max: 'Draw the scene into a multisampled offscreen target at the GPU\'s maximum supported sample count. Applies live.',
};

function aaResolutionTitle(value: AntialiasResolutionMode): string {
  if (value === 'auto') {
    return 'Let the runtime profile drive render resolution: the adaptive pixel-ratio governor on browser desktop, the fixed 1x cap on the desktop app and mobile.';
  }
  if (value > 100) {
    return `Pin render resolution to ${value}% of the display's native pixel ratio — supersampling. The only antialiasing here that also fixes shader/specular shimmer; cost grows with the square of the factor.`;
  }
  if (value === 100) {
    return 'Pin render resolution to the display\'s full native pixel ratio and suspend the adaptive governor. On the desktop app this lifts the built-in 1x cap — the biggest edge-quality win on HiDPI screens.';
  }
  return `Pin render resolution to ${value}% of the display's native pixel ratio — reduced-resolution performance mode.`;
}

const CAMERA_ANCHOR_SLOTS = [0, 1, 2, 3] as const;
const TELEMETRY_BUDGETS = CLIENT_CONFIG.telemetryBudgets;
const PATHING_DEBUG_UNIT_OPTIONS: readonly {
  readonly value: PathingDebugUnitId;
  readonly label: string;
  readonly title: string;
}[] = [
  ...unitRosterDisplay.map((unit) => ({
    value: unit.unitBlueprintId,
    label: unit.shortName,
    title: `Use ${unit.label} for the selected pathability overlay mode`,
  })),
];
const PATHING_DEBUG_MODE_OPTIONS: readonly {
  readonly value: PathingDebugMode;
  readonly label: string;
  readonly title: string;
}[] = [
  { value: 'none', label: 'NONE', title: 'Hide the selected unit pathability overlay' },
  {
    value: 'waypoint',
    label: 'WAYPOINT',
    title: 'Show cells where the selected unit may intentionally receive an order (cyan)',
  },
  {
    value: 'move',
    label: 'MOVE',
    title: 'Show every cell the selected unit can physically traverse, including recovery-only cells (amber)',
  },
];
const BUILD_GRID_DEBUG_MODE_TITLES: Record<BuildGridDebugMode, string> = {
  none: 'Hide the whole-map build-square availability overlay',
  'ground-build-squares-hover': 'Show wholly-ground squares available to hovering structures; slope is irrelevant',
  'ground-build-squares-surface': 'Show wholly-ground squares with valid terrain slope and plateau level',
  'water-build-squares-sea-bed': 'Show wholly-water squares with a valid sea-bed slope and plateau level',
  'water-build-squares-sea-on-surface': 'Show wholly-water squares with enough depth for a waterline-centered structure',
  'water-build-squares-hover-surface': 'Show wholly-water squares available to hovering structures; bed slope and depth are irrelevant',
};

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

function fmtCameraPositionCoordinate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(1);
}

function fmtCameraDirectionCoordinate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(3);
}

const props = defineProps<{
  model: GameCanvasClientControlBarModel;
}>();

const hotkeyEditorOpen = ref(false);
const captureCommandId = ref<CommandHotkeyId | null>(null);
const hotkeyEditorRevision = ref(0);
const cameraDebugCopyStatus = ref<'idle' | 'copied' | 'failed'>('idle');
let cameraDebugCopyTimeout: ReturnType<typeof setTimeout> | null = null;

function formatCameraDebugClipboardCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : 'INVALID';
}

function setCameraDebugCopyStatus(status: 'copied' | 'failed'): void {
  cameraDebugCopyStatus.value = status;
  if (cameraDebugCopyTimeout !== null) clearTimeout(cameraDebugCopyTimeout);
  cameraDebugCopyTimeout = setTimeout(() => {
    cameraDebugCopyTimeout = null;
    cameraDebugCopyStatus.value = 'idle';
  }, 1800);
}

async function copyCameraDebugPose(): Promise<void> {
  const { model } = props;
  const text = [
    'Camera debug (Three world XYZ; Y is altitude)',
    `position: x=${formatCameraDebugClipboardCoordinate(model.cameraPositionX)}, y=${formatCameraDebugClipboardCoordinate(model.cameraPositionY)}, z=${formatCameraDebugClipboardCoordinate(model.cameraPositionZ)}`,
    `direction: x=${formatCameraDebugClipboardCoordinate(model.cameraDirectionX)}, y=${formatCameraDebugClipboardCoordinate(model.cameraDirectionY)}, z=${formatCameraDebugClipboardCoordinate(model.cameraDirectionZ)}`,
  ].join('\n');

  try {
    await navigator.clipboard.writeText(text);
    setCameraDebugCopyStatus('copied');
    return;
  } catch {
    // Older/embedded browser fallback when the async Clipboard API is
    // unavailable. Keep the temporary selection entirely out of the UI.
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.append(textArea);
    textArea.select();
    const copied = document.execCommand('copy');
    textArea.remove();
    setCameraDebugCopyStatus(copied ? 'copied' : 'failed');
  }
}

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

function isAudioHotkey(commandId: CommandHotkeyId): boolean {
  return commandId === 'ui.muteSound' || commandId.startsWith('ui.volume');
}

const hotkeyEditorRows = computed(() => {
  void props.model.commandHotkeyRevision;
  void hotkeyEditorRevision.value;
  return COMMAND_HOTKEY_IDS
    .filter((commandId) => AUDIO_ENABLED || !isAudioHotkey(commandId))
    .map((commandId) => ({
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
            title="Waypoint visualization. SIMPLE connects authored command points. DETAILED shows only the exact remaining active movement plan; future command points remain visible but unconnected until planned."
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
        <BarLabel title="How enabled per-type HUD elements behave on selected entities. ALL shows enabled health even when full; OFF suppresses selected bars and names; DMG shows health only when damaged and build bars only during construction. Names have no fullness, so DMG leaves enabled selected names visible. Hover can still force a health bar for inspection, and unselected entities are unaffected by this selector.">SEL:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.selectionHudMode.options"
            :key="opt.value"
            :active="model.selectionHudMode === opt.value"
            :title="`Selection HUD: ${opt.label}.`"
            @click="model.changeSelectionHudMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Client CPU - adjacent-tick presentation sampling, input, and HUD updates. Raw logicMs avg/hi in milliseconds per frame.">CPU:</BarLabel>
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
        <BarLabel :title="`Three/WebGL workload from the last completed draw. The bars compare against configurable soft per-frame budgets, not GPU hard limits: ${fmtCount4(TELEMETRY_BUDGETS.trianglesPerFrame)} triangles and ${fmtCount4(TELEMETRY_BUDGETS.drawCallsPerFrame)} draw calls. Current points ${model.webglPoints}, lines ${model.webglLines}, retained geometries ${model.webglGeometries}, textures ${model.webglTextures}.`">DRAW:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtCount4(model.webglTriangles) }}</span>
              <span class="fps-label">/{{ fmtCount4(TELEMETRY_BUDGETS.trianglesPerFrame) }} tri</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="budgetBarStyle(model.webglTriangles, TELEMETRY_BUDGETS.trianglesPerFrame)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtCount4(model.webglDrawCalls) }}</span>
              <span class="fps-label">/{{ fmtCount4(TELEMETRY_BUDGETS.drawCallsPerFrame) }} dc</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="budgetBarStyle(model.webglDrawCalls, TELEMETRY_BUDGETS.drawCallsPerFrame)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="`WebGL buffer uploads during the last completed draw. The bars compare against configurable soft per-frame budgets of ${fmtBytes4(TELEMETRY_BUDGETS.bufferUploadBytesPerFrame)} and ${TELEMETRY_BUDGETS.bufferUploadCallsPerFrame} calls. Profiler ${model.webglBufferProfilerSupported ? 'active' : 'unavailable'}. bufferData ${model.webglBufferDataCalls}, bufferSubData ${model.webglBufferSubDataCalls}, WebGL submit ${fmt4(model.webglRendererRenderMs)} ms.`">UPLOAD:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtBytes4(model.webglBufferUploadBytes) }}</span>
              <span class="fps-label">/{{ fmtBytes4(TELEMETRY_BUDGETS.bufferUploadBytesPerFrame) }}</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="budgetBarStyle(model.webglBufferUploadBytes, TELEMETRY_BUDGETS.bufferUploadBytesPerFrame)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtCount4(model.webglBufferDataCalls + model.webglBufferSubDataCalls) }}</span>
              <span class="fps-label">/{{ TELEMETRY_BUDGETS.bufferUploadCallsPerFrame }} calls</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="budgetBarStyle(model.webglBufferDataCalls + model.webglBufferSubDataCalls, TELEMETRY_BUDGETS.bufferUploadCallsPerFrame)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="RAF callback wall-clock: scene update plus WebGL submission. Compare this with R-TPS: a low FRAME value at ~30 R-TPS indicates browser/display pacing, while 17+ ms of FRAME work can miss 60 Hz vsync. Hardware GPU execution is reported separately by GPU when timer queries are available.">FRAME:</BarLabel>
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
        <BarLabel :title="`${model.clientLabel} update-loop ticks per second. This includes presentation sampling, input, and render-prep cadence.`">R-TPS:</BarLabel>
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
        <BarLabel :title="`Rendered camera-eye distance from the map center origin, in world units. ${fmtCount4(ZOOM_MAX_MAP_CENTER_DISTANCE)} is the telemetry display reference; the camera rail follows BAR and scales with map size.`">ZOOM:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmtCount4(model.currentZoom) }}</span>
              <span class="fps-label">/{{ fmtCount4(ZOOM_MAX_MAP_CENTER_DISTANCE) }}</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="statBarStyle(model.currentZoom, ZOOM_MAX_MAP_CENTER_DISTANCE, true)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Actual rendered Three.js camera-eye position in world XYZ. Y is altitude; this is not the orbit target.">CAM POS:</BarLabel>
        <span class="fps-value camera-vector-value">X {{ fmtCameraPositionCoordinate(model.cameraPositionX) }}</span>
        <span class="fps-value camera-vector-value">Y {{ fmtCameraPositionCoordinate(model.cameraPositionY) }}</span>
        <span class="fps-value camera-vector-value">Z {{ fmtCameraPositionCoordinate(model.cameraPositionZ) }}</span>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Actual rendered Three.js normalized forward/view direction in world XYZ. This is where the camera is pointing.">CAM DIR:</BarLabel>
        <span class="fps-value camera-vector-value">X {{ fmtCameraDirectionCoordinate(model.cameraDirectionX) }}</span>
        <span class="fps-value camera-vector-value">Y {{ fmtCameraDirectionCoordinate(model.cameraDirectionY) }}</span>
        <span class="fps-value camera-vector-value">Z {{ fmtCameraDirectionCoordinate(model.cameraDirectionZ) }}</span>
        <BarButton
          :active="cameraDebugCopyStatus === 'copied'"
          :title="cameraDebugCopyStatus === 'copied' ? 'Camera position and direction copied' : 'Copy the camera position and direction as a paste-ready XYZ diagnostic'"
          @click="copyCameraDebugPose"
        >{{ cameraDebugCopyStatus === 'copied' ? 'COPIED' : cameraDebugCopyStatus === 'failed' ? 'FAILED' : 'COPY' }}</BarButton>
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
        <BarLabel :title="`Antialiasing. MSAA picks the geometric edge pipeline; RES pins render resolution as a percent of the display's native pixel ratio. Both apply live. Current MSAA target: ${model.antialiasSamples > 0 ? `${model.antialiasSamples}x offscreen` : 'canvas default'}; DPR ${fmt4(model.activePixelRatio)} / native ${fmt4(model.nativePixelRatio)}.`">AA MSAA:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in AA_MSAA_MODE_OPTIONS"
            :key="opt.value"
            :active="model.aaMsaaMode === opt.value"
            :title="AA_MSAA_MODE_TITLES[opt.value]"
            @click="model.changeAaMsaaMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
        <BarLabel>RES:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in AA_RESOLUTION_MODE_OPTIONS"
            :key="opt.value"
            :active="model.aaResolutionMode === opt.value"
            :title="aaResolutionTitle(opt.value)"
            @click="model.changeAaResolutionMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>WALL EDGE:</BarLabel>
        <BarButton
          :active="model.terrainSplitWallBoundaryVertices"
          title="Split D-PLATEAU wall-edge render vertices so wall and flat triangles bake normals, texture masks, and light from their own side of the edge."
          @click="model.toggleTerrainSplitWallBoundaryVertices"
        >SPLIT</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>TEXTURE SMOOTH:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.terrainTextureSmoothing.options"
            :key="opt"
            :active="model.terrainTextureSmoothing === opt"
            :title="opt === 0
              ? 'Disable extra terrain texture smoothing'
              : `Terrain texture smoothing passes: ${opt}`"
            @click="model.applyTerrainTextureSmoothing(opt)"
          >{{ opt }}</BarButton>
        </BarButtonGroup>
        <BarButton
          :active="model.terrainTextureSmoothAcrossWallBoundary"
          title="Allow terrain texture smoothing to cross D-PLATEAU wall/non-wall triangle boundaries. Off keeps the two triangle classes separate."
          @click="model.toggleTerrainTextureSmoothAcrossWallBoundary"
        >CROSS WALL</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>LIGHT SMOOTH:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.terrainLightSmoothing.options"
            :key="opt"
            :active="model.terrainLightSmoothing === opt"
            :title="opt === 0
              ? 'Disable extra baked terrain light smoothing'
              : `Baked terrain light smoothing passes: ${opt}`"
            @click="model.applyTerrainLightSmoothing(opt)"
          >{{ opt }}</BarButton>
        </BarButtonGroup>
        <BarButton
          :active="model.terrainLightSmoothAcrossWallBoundary"
          title="Allow baked terrain light smoothing to cross D-PLATEAU wall/non-wall triangle boundaries. Off keeps the two triangle classes separate."
          @click="model.toggleTerrainLightSmoothAcrossWallBoundary"
        >CROSS WALL</BarButton>
      </BarControlGroup>
      <BarControlGroup class="debug-control-group">
        <BarDivider />
        <BarLabel>DEBUG:</BarLabel>
        <BarButton
          :active="model.burnMarks"
          title="Draw beam, laser, and dgun scorch trails on the ground"
          @click="model.toggleBurnMarks"
        >BURN</BarButton>
        <BarButton
          :active="model.windParticles"
          title="Draw ambient wind particles drifting with the authoritative wind"
          @click="model.toggleWindParticles"
        >WIND</BarButton>
        <BarButton
          :active="model.locomotionMarks"
          title="Draw wheel, tread, and footstep prints from unit movement"
          @click="model.toggleLocomotionMarks"
        >LOCO</BarButton>
        <BarButton
          :active="model.teamTrim"
          title="Draw the extra TEAM-colored ornamentation bolted onto entities (a unit's fin, a building's roof band). Identity colors are unaffected either way: bodies stay player-colored and turret accents stay team-colored, since those recolor existing parts instead of adding geometry."
          @click="model.toggleTeamTrim"
        >TRIM</BarButton>
        <BarButton
          :active="model.surfaceTexture"
          title="Apply the procedural trim-sheet texturing to charted surfaces: hull plating, nose facets, sensor housings, barrel fluting, leg hydraulics, and team livery. Only units that have been through the charting pass are affected."
          @click="model.toggleSurfaceTexture"
        >TEX</BarButton>
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
        <BarButton
          :active="model.entityShadows"
          title="Draw client-side entity shadows in the shared world coverage field"
          @click="model.toggleEntityShadows"
        >SHADOWS</BarButton>
        <BarButton
          :active="model.forceFieldsVisible"
          title="Show local force-field surfaces and impact flashes. Shield interception remains active when hidden."
          @click="model.toggleForceFieldsVisible"
        >FIELDS</BarButton>
        <BarButton
          :active="model.fogShade"
          title="Shade currently unseen terrain and environment props with a world-attached fog-of-war mask. Battle-level FOG OF WAR still controls visibility and snapshot filtering."
          @click="model.toggleFogShade"
        >SHADE</BarButton>
        <BarButton
          :active="model.materialExplosions"
          title="Break every textured entity part apart with the killing blast, plus the consolidated fire effect"
          @click="model.toggleMaterialExplosions"
        >MATEXP</BarButton>
        <BarButton
          :active="model.legsRadiusToggle"
          title="Show the authored chopped snap envelope: cyan foot spheres, pink attachment-ground chopping spheres, yellow snap-ray origin dots, and first-hit rays following each dot's own velocity."
          @click="model.toggleLegsRadius"
        >LEG RAD</BarButton>
        <BarButton
          :active="model.legsReachToggle"
          title="Show each leg's amber hip-centered mechanical reach sphere and the center-through-attachment ray to full extension."
          @click="model.toggleLegsReach"
        >LEG REACH</BarButton>
        <BarButton
          :active="model.triangleDebug"
          title="TRIS - debug-color every terrain mesh triangle so triangle reduction and flat-tile optimization are visually obvious"
          @click="model.toggleTriangleDebug"
        >TRIS</BarButton>
        <BarButton
          :active="model.waterTriangleDebug"
          title="WATER TRIS - highlight every triangle in the rendered water surface and its floating-square perimeter curtains"
          @click="model.toggleWaterTriangleDebug"
        >WATER TRIS</BarButton>
        <BarButton
          :active="model.wallTriangleDebug"
          title="WALL TRIS - show only terrain triangles classified as D-PLATEAU wall faces"
          @click="model.toggleWallTriangleDebug"
        >WALL TRIS</BarButton>
        <BarLabel title="Exclusive whole-map build-square availability view. All colors are projected on the actual terrain, including the seabed.">BUILD:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.buildGridDebug.options"
            :key="opt.value"
            :active="model.buildGridDebugMode === opt.value"
            :title="BUILD_GRID_DEBUG_MODE_TITLES[opt.value]"
            @click="model.changeBuildGridDebugMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
        <BarButton
          :active="model.pathingHierarchyDebug"
          title="HIER - show level-1 pathfinding chunks: cyan boundaries, alternating chunk tint, and orange nominal center nodes"
          @click="model.togglePathingHierarchyDebug"
        >HIER</BarButton>
        <BarButton
          :active="model.airLiftProbeDebug"
          title="PROBES - show authoritative force-tick lift probes; brown lines are active solid/support distances and blue lines are active exposed-water distances"
          @click="model.toggleAirLiftProbeDebug"
        >PROBES</BarButton>
        <BarButton
          :active="model.zoomPointsDebug"
          title="ZOOM POINTS - show the exact configured terrain neighborhood; red marks the point currently selected by MIN distance mode"
          @click="model.toggleZoomPointsDebug"
        >ZOOM POINTS</BarButton>
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
      </BarControlGroup>
      <BarControlGroup class="path-control-group">
        <BarDivider />
        <BarLabel>PATH:</BarLabel>
        <BarButtonGroup class="path-mode-button-group">
          <BarButton
            v-for="opt in PATHING_DEBUG_MODE_OPTIONS"
            :key="opt.value"
            :active="model.pathingDebugMode === opt.value"
            :title="opt.title"
            @click="model.changePathingDebugMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
        <BarButtonGroup class="path-unit-button-group">
          <BarButton
            v-for="opt in PATHING_DEBUG_UNIT_OPTIONS"
            :key="opt.value"
            :active="model.pathingDebugUnit === opt.value"
            :title="opt.title"
            @click="model.changePathingDebugUnit(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
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
        <BarLabel>ENV:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.environmentLight.options"
            :key="opt.value"
            :active="model.environmentLight === opt.value"
            :title="`Image-based light from the RoomEnvironment cube, at ${opt.value}% of default. THE DOMINANT TERM: with this at 0 and the other lights off, lit surfaces including terrain go black.`"
            @click="model.changeEnvironmentLight(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>AMB:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.ambientLight.options"
            :key="opt.value"
            :active="model.ambientLight === opt.value"
            :title="`AmbientLight at ${opt.value}% of the authored intensity. Flat fill — raising it flattens shading, lowering it deepens contrast. A trim on top of ENV, not a main light.`"
            @click="model.changeAmbientLight(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>SUN:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.directionalLight.options"
            :key="opt.value"
            :active="model.directionalLight === opt.value"
            :title="`DirectionalLight at ${opt.value}% of the authored intensity. Only reaches LIT materials — unit bodies, turret heads, buildings. Terrain bakes the sun in at build time and legs/effects are unlit, so zoom in on a unit to judge this one.`"
            @click="model.changeDirectionalLight(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>SKY:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.skyLight.options"
            :key="opt.value"
            :active="model.skyLight === opt.value"
            :title="`Sky brightness at ${opt.value}%, covering both sky paths: three's scene background and the parallax panorama layers. Which one you see depends on the preset, so they share one control. Pixels only — the sky contributes no light to surfaces.`"
            @click="model.changeSkyLight(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>EXPO:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.exposure.options"
            :key="opt.value"
            :active="model.exposure === opt.value"
            :title="`Tone-mapping exposure at ${opt.value}%. Scales everything in the 3D view, including the custom shaders that cannot tone-map themselves and are handed the scale by hand — so at 0 the screen is black with no exceptions. Inert on mobile-class runtime profiles, which disable tone mapping entirely.`"
            @click="model.changeExposure(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="AUDIO_ENABLED">
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
      <BarControlGroup v-if="AUDIO_ENABLED">
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
      <BarControlGroup v-if="AUDIO_ENABLED">
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
        <BarLabel>VOLUMES:</BarLabel>
        <BarButton
          :active="model.allVolumesActive"
          title="Toggle every 3D volume viz on/off. Each button draws one CONCEPT across every entity that carries it — units, buildings/towers, mounted turrets, shots, and vegetation props — in its true shape."
          @click="model.toggleAllVolumes"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            :active="model.volumeToggles.selection"
            title="SELECTION — the exact volume the mouse picker ray-tests. Units: body sphere (1.18 × radius, min 12). Buildings/towers: upright footprint × visual-height box. Hovering fabricator: its torus ring (the open middle does not pick). Vegetation props: their upright reclaim cylinder."
            @click="model.toggleVolume('selection')"
          >SEL</BarButton>
          <BarButton
            :active="model.volumeToggles.hit"
            title="HIT — the damage volume projectiles, beams, and splash test, plus the target-acquisition cylinder combat targeting gates on. Units: hitbox sphere. Buildings: the width × height × depth combat box. Shots: their own collision sphere. Both float at the combat center for hovering buildings."
            @click="model.toggleVolume('hit')"
          >HIT</BarButton>
          <BarButton
            :active="model.volumeToggles.collision"
            title="COLLISION — the physics volume. Units: collision sphere (radius.collision). Grounded buildings: the static ground-seated cuboid. Hovering fabricator: the floating annular ring (open center hole)."
            @click="model.toggleVolume('collision')"
          >COL</BarButton>
          <BarButton
            :active="model.volumeToggles.arming"
            title="ARMING — the host HIT shape enlarged at least 1.5× about the same center and far enough to retain its collision safety margin. A physical shot remains collision-inactive until its complete hitbox clears this volume. Drawn on every host."
            @click="model.toggleVolume('arming')"
          >ARM</BarButton>
          <BarButton
            :active="model.volumeToggles.explosion"
            title="EXPLOSION / DAMAGE — authoritative damage spheres. Draws the future splash volume on live explosive shots and the active terminal damage volume for projectile impacts and beam endpoints. Debug-only; disabled by default."
            @click="model.toggleVolume('explosion')"
          >EXP</BarButton>
          <BarButton
            :active="model.volumeToggles.turretLockOn"
            title="TURRET LOCK-ON — every turret's real 3D tracking and engagement range shells, centered on its authoritative AimFrom mount. Colors match TURR CIR. Sphere and cylinder modes follow the authored rangeVolume; arrow-tipped ends continue without bound, and water-capped volumes stop at the water surface. Target bodies become valid when their own target volume intersects these shells."
            @click="model.toggleVolume('turretLockOn')"
          >TGT</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>ANCHOR:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="slot in CAMERA_ANCHOR_SLOTS"
            :key="`save-${slot}`"
            :active="false"
            :title="`Save the current camera target, distance, yaw, and pitch in in-memory anchor ${slot + 1}`"
            @click="model.setCameraAnchor(slot)"
          >S{{ slot + 1 }}</BarButton>
        </BarButtonGroup>
        <BarButtonGroup>
          <BarButton
            v-for="slot in CAMERA_ANCHOR_SLOTS"
            :key="`focus-${slot}`"
            :active="false"
            :title="`Restore in-memory camera anchor ${slot + 1}; does nothing until that slot has been saved`"
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
        <BarLabel title="Camera follow for a single selected unit. Only active when exactly one unit is selected; follow movement shares the configured camera smoothing.">FOLLOW:</BarLabel>
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
.debug-control-group,
.path-control-group {
  flex: 1 1 100%;
  min-width: 0;
  flex-wrap: wrap;
}

.debug-control-group :deep(.control-btn) {
  flex: 0 0 auto;
  white-space: nowrap;
}

.path-mode-button-group {
  flex: 0 0 auto;
}

.path-unit-button-group {
  display: flex;
  flex: 1 1 24rem;
  min-width: 0;
  flex-wrap: wrap;
}

.path-unit-button-group :deep(.control-btn) {
  flex: 0 0 auto;
  overflow: visible;
  white-space: nowrap;
}

.camera-vector-value {
  width: 8ch;
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
