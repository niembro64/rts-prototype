<script setup lang="ts">
import { GOOD_TPS } from '../telemetryConfig';
import {
  SERVER_CONFIG,
  snapshotRateLabel,
  snapshotRateTitle,
} from '../serverBarConfig';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import BarButton from './BarButton.vue';
import BarButtonGroup from './BarButtonGroup.vue';
import BarControlGroup from './BarControlGroup.vue';
import BarDivider from './BarDivider.vue';
import BarLabel from './BarLabel.vue';
import type { GameCanvasServerControlBarModel } from './gameCanvasControlBarModels';
import { fmt4, msBarStyle, statBarStyle } from './uiUtils';

defineProps<{
  model: GameCanvasServerControlBarModel;
}>();

const UNIT_GROUND_NORMAL_EMA_LABEL: Record<UnitGroundNormalEmaMode, string> = {
  snap: 'SNAP',
  fast: 'FAST',
  mid: 'MED',
  slow: 'SLOW',
};

function fullSnapTitle(opt: string | number): string {
  if (opt === 'ALL') return 'Every snapshot is a full keyframe (1/1)';
  if (opt === 'NONE') return 'Never send full keyframes (delta only)';
  return `One full keyframe every ${Math.round(1 / Number(opt))} snapshots`;
}

function fullSnapLabel(opt: string | number): string {
  if (opt === 'ALL') return '1/1';
  if (opt === 'NONE') return 'NONE';
  return `1/${Math.round(1 / Number(opt))}`;
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
        <span class="bar-label-text">HOST SERVER</span
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
      <BarControlGroup>
        <BarDivider />
        <BarLabel>TARGET SERVER TPS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="rate in SERVER_CONFIG.tickRate.options"
            :key="rate"
            :active="model.displayTickRate === rate"
            :title="`Run the host at ${rate} simulation ticks per second.`"
            @click="model.setTickRateValue(rate)"
          >{{ rate }}</BarButton>
        </BarButtonGroup>
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
        <BarLabel title="Server simulation ticks per second">S-TPS:</BarLabel>
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
                  statBarStyle(model.displayServerTpsAvg, GOOD_TPS, model.isReadonly)
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
                  statBarStyle(model.displayServerTpsWorst, GOOD_TPS, model.isReadonly)
                "
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Host CPU load - simulation tick time as a percent of the target tick budget. >100% means the host is falling behind.">CPU:</BarLabel>
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
        <BarLabel title="Delta snapshots emitted per second by the host.">DIFFSNAP:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="rate in SERVER_CONFIG.snapshot.options"
            :key="String(rate)"
            :active="model.displaySnapshotRate === rate"
            :title="snapshotRateTitle(rate)"
            @click="model.setNetworkUpdateRate(rate)"
          >{{ snapshotRateLabel(rate) }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Fraction of DIFFSNAPs that are actually FULLSNAPs.">FULLSNAP:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in SERVER_CONFIG.keyframe.options"
            :key="String(opt)"
            :active="model.displayKeyframeRatio === opt"
            :title="fullSnapTitle(opt)"
            @click="model.setKeyframeRatioValue(opt)"
          >{{ fullSnapLabel(opt) }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
    </div>
  </div>
</template>
