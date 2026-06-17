<script setup lang="ts">
import { SERVER_CONFIG } from '../serverBarConfig';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import BarButton from './BarButton.vue';
import BarButtonGroup from './BarButtonGroup.vue';
import BarControlGroup from './BarControlGroup.vue';
import BarDivider from './BarDivider.vue';
import BarLabel from './BarLabel.vue';
import type { GameCanvasServerControlBarModel } from './gameCanvasControlBarModels';
import { fmt4, msBarStyle, statBarStyle } from './uiUtils';
import { ARCHITECTURE_CONFIG } from '../architectureConfig';

defineProps<{
  model: GameCanvasServerControlBarModel;
}>();

const LOCKSTEP_FIXED_SIM_HZ = ARCHITECTURE_CONFIG.lockstep.fixedStepHz;
const LOCKSTEP_CHECKSUM_INTERVAL_TICKS = ARCHITECTURE_CONFIG.lockstep.checksumIntervalTicks;

const UNIT_GROUND_NORMAL_EMA_LABEL: Record<UnitGroundNormalEmaMode, string> = {
  snap: 'SNAP',
  fast: 'FAST',
  mid: 'MED',
  slow: 'SLOW',
};

function architectureLabel(model: GameCanvasServerControlBarModel): string {
  return model.isLockstepBackend ? 'LOCKSTEP' : 'LOCAL SIM';
}

function architectureTitle(model: GameCanvasServerControlBarModel): string {
  if (model.isLockstepBackend) {
    return 'deterministic-lockstep: ordered command frames are multiplayer truth; each browser runs the same local server simulation.';
  }
  return 'local preview/demo simulation: this runtime is not the multiplayer lockstep backend.';
}

function simTpsLabel(model: GameCanvasServerControlBarModel): string {
  return model.isLockstepBackend ? 'ADV TPS' : 'TPS';
}

function simTpsTitle(model: GameCanvasServerControlBarModel): string {
  if (!model.isLockstepBackend) {
    return `Actual local simulation ticks per wall-clock second. Target is the local server tick rate reported by snapshot meta: ${fmt4(model.displayTickRate)} Hz.`;
  }
  return `Actual lockstep frames advanced per wall-clock second in this browser. This can be below ${LOCKSTEP_FIXED_SIM_HZ} when the browser pump is slow or waiting for command frames; the fixed simulation step still remains ${LOCKSTEP_FIXED_SIM_HZ} Hz.`;
}

function simTpsTarget(model: GameCanvasServerControlBarModel): number {
  return model.isLockstepBackend ? LOCKSTEP_FIXED_SIM_HZ : Math.max(1, model.displayTickRate);
}

function cpuTitle(model: GameCanvasServerControlBarModel): string {
  if (!model.isLockstepBackend) {
    return `Local simulation CPU load - measured server-simulation work as a percent of the ${fmt4(model.displayTickRate)} Hz tick budget.`;
  }
  return `Local lockstep simulation CPU load - measured server-simulation work as a percent of the fixed ${LOCKSTEP_FIXED_SIM_HZ} Hz frame budget.`;
}

function timingLabel(model: GameCanvasServerControlBarModel): string {
  return model.isLockstepBackend ? 'FIXED STEP:' : 'SIM STEP:';
}

function timingValue(model: GameCanvasServerControlBarModel): string {
  const hz = model.isLockstepBackend ? LOCKSTEP_FIXED_SIM_HZ : model.displayTickRate;
  return `${fmt4(hz)} HZ`;
}

function fixedStepTitle(model: GameCanvasServerControlBarModel): string {
  if (!model.isLockstepBackend) {
    return `Local preview/demo simulation step from snapshot meta: ${fmt4(model.displayTickRate)} Hz (${fmt4(1000 / Math.max(1, model.displayTickRate))} ms per tick).`;
  }
  return `deterministic-lockstep fixed simulation step from architecture.json: ${LOCKSTEP_FIXED_SIM_HZ} Hz (${fmt4(1000 / LOCKSTEP_FIXED_SIM_HZ)} ms per logical frame). Actual frame advancement is shown separately as ADV TPS.`;
}

function checksumTitle(): string {
  return `deterministic-lockstep checksum interval from architecture.json: compare canonical state every ${LOCKSTEP_CHECKSUM_INTERVAL_TICKS} lockstep ticks.`;
}

</script>

<template>
  <div
    class="control-bar"
    :class="{ 'bar-readonly': model.isReadonly }"
    :style="model.barStyle"
  >
    <div class="bar-info">
      <BarButton
        :active="true"
        class="bar-label"
        title="Click to reset server settings to defaults"
        @click="model.resetServerDefaults"
      >
        <span class="bar-label-text">{{ model.serverLabel }}</span
        ><span class="bar-label-hover">DEFAULTS</span>
      </BarButton>
    </div>
    <div class="bar-controls">
      <BarControlGroup v-if="model.displayServerTime">
        <BarDivider />
        <span
          class="time-display"
          title="Server wall-clock time"
          >{{ model.displayServerTime }}</span
        >
      </BarControlGroup>
      <BarControlGroup v-if="model.displayServerIp">
        <BarDivider />
        <span
          class="ip-display"
          title="Server IP address"
          >{{ model.displayServerIp }}</span
        >
      </BarControlGroup>
      <BarControlGroup v-if="model.isLockstepBackend">
        <BarDivider />
        <BarLabel>BACKEND:</BarLabel>
        <BarButton
          :active="true"
          :title="architectureTitle(model)"
        >{{ architectureLabel(model) }}</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="fixedStepTitle(model)">{{ timingLabel(model) }}</BarLabel>
        <BarButton
          :active="true"
          :title="fixedStepTitle(model)"
        >{{ timingValue(model) }}</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="checksumTitle()">CHECKSUM:</BarLabel>
        <BarButton
          :active="true"
          :title="checksumTitle()"
        >{{ LOCKSTEP_CHECKSUM_INTERVAL_TICKS }} TICKS</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Per-unit ground normal EMA. SNAP = no smoothing (raw triangle-edge), FAST/MED/SLOW progressively heavier blending. Drives the sim's updateUnitGroundNormal half-life.">UNIT GROUND NORMAL EMA:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="mode in SERVER_CONFIG.unitGroundNormalEma.options"
            :key="mode"
            :active="model.serverUnitGroundNormalEmaMode === mode"
            :title="`Set unit ground normal EMA to ${UNIT_GROUND_NORMAL_EMA_LABEL[mode]}.`"
            @click="model.setUnitGroundNormalEmaModeValue(mode)"
          >{{ UNIT_GROUND_NORMAL_EMA_LABEL[mode] }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="simTpsTitle(model)">{{ simTpsLabel(model) }}:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.displayServerTpsAvg) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  statBarStyle(model.displayServerTpsAvg, simTpsTarget(model), model.isReadonly)
                "
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{
                fmt4(model.displayServerTpsWorst)
              }}</span>
              <span class="fps-label">low</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  statBarStyle(model.displayServerTpsWorst, simTpsTarget(model), model.isReadonly)
                "
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="cpuTitle(model)">CPU:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.displayServerCpuAvg) }}%</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.displayServerCpuAvg, 100)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.displayServerCpuHi) }}%</span>
              <span class="fps-label">hi</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.displayServerCpuHi, 100)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="In deterministic-lockstep, ordered command frames and checksums are multiplayer truth.">TRUTH:</BarLabel>
        <BarButton
          :active="true"
          title="Gameplay truth is the canonical ordered command-frame stream."
        >CMD FRAMES</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Local snapshots still feed the existing renderer, but they are not remote gameplay authority.">SNAPS:</BarLabel>
        <BarButton
          :active="true"
          title="Snapshots are generated locally for presentation and diagnostics only."
        >LOCAL RENDER</BarButton>
      </BarControlGroup>
    </div>
  </div>
</template>
