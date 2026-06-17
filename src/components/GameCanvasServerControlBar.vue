<script setup lang="ts">
import BarButton from './BarButton.vue';
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

function architectureTitle(): string {
  return 'deterministic-lockstep: ordered command frames are multiplayer truth; each browser runs the same local server simulation.';
}

function simTpsTitle(): string {
  return `Actual lockstep frames advanced per wall-clock second in this browser. This can be below ${LOCKSTEP_FIXED_SIM_HZ} when the browser pump is slow or waiting for command frames; the fixed simulation step still remains ${LOCKSTEP_FIXED_SIM_HZ} Hz.`;
}

function simTpsTarget(): number {
  return LOCKSTEP_FIXED_SIM_HZ;
}

function cpuTitle(): string {
  return `Local lockstep simulation CPU load - measured server-simulation work as a percent of the fixed ${LOCKSTEP_FIXED_SIM_HZ} Hz frame budget.`;
}

function timingValue(): string {
  return `${fmt4(LOCKSTEP_FIXED_SIM_HZ)} HZ`;
}

function fixedStepTitle(): string {
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
        title="Server and lockstep runtime status"
      >
        <span class="bar-label-text">{{ model.serverLabel }}</span
        ><span class="bar-label-hover">STATUS</span>
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
      <BarControlGroup>
        <BarDivider />
        <BarLabel>BACKEND:</BarLabel>
        <BarButton
          :active="true"
          :title="architectureTitle()"
        >LOCKSTEP</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="fixedStepTitle()">FIXED STEP:</BarLabel>
        <BarButton
          :active="true"
          :title="fixedStepTitle()"
        >{{ timingValue() }}</BarButton>
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
        <BarLabel :title="simTpsTitle()">ADV TPS:</BarLabel>
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
                  statBarStyle(model.displayServerTpsAvg, simTpsTarget(), model.isReadonly)
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
                  statBarStyle(model.displayServerTpsWorst, simTpsTarget(), model.isReadonly)
                "
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="cpuTitle()">CPU:</BarLabel>
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
