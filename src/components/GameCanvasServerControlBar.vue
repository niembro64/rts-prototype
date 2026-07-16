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

function simTpsTitle(): string {
  return `Actual lockstep frames advanced per wall-clock second in this browser. This can be below ${LOCKSTEP_FIXED_SIM_HZ} when the browser pump is slow or waiting for command frames; the fixed simulation step still remains ${LOCKSTEP_FIXED_SIM_HZ} Hz.`;
}

function simTpsTarget(): number {
  return LOCKSTEP_FIXED_SIM_HZ;
}

function cpuTitle(): string {
  return `Local lockstep simulation CPU load - measured server-simulation work as a percent of the fixed ${LOCKSTEP_FIXED_SIM_HZ} Hz frame budget.`;
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
    </div>
  </div>
</template>
