<script setup lang="ts">
import { CLIENT_CONFIG } from '../clientBarConfig';
import { GOOD_TPS } from '../lodConfig';
import {
  SERVER_CONFIG,
  snapshotRateHz,
  snapshotRateLabel,
  snapshotRateTitle,
} from '../serverBarConfig';
import { SERVER_SIM_LOD_SIGNALS_ENABLED } from '../serverSimLodConfig';
import type { TiltEmaMode } from '../shellConfig';
import BarButton from './BarButton.vue';
import BarButtonGroup from './BarButtonGroup.vue';
import BarControlGroup from './BarControlGroup.vue';
import BarDivider from './BarDivider.vue';
import BarLabel from './BarLabel.vue';
import type { GameCanvasServerControlBarModel } from './gameCanvasControlBarModels';
import { fmt4, msBarStyle, statBarStyle } from './uiUtils';

const props = defineProps<{
  model: GameCanvasServerControlBarModel;
}>();

const TILT_EMA_LABEL: Record<TiltEmaMode, string> = {
  snap: 'SNAP',
  fast: 'FAST',
  mid: 'MED',
  slow: 'SLOW',
};

function secPerFullsnap(ratio: number): string {
  const sps = snapshotRateHz(props.model.displaySnapshotRate, props.model.displayTickRate);
  const sec = 1 / (sps * ratio);
  return `~1 fullsnap every ${+sec.toPrecision(2)}s`;
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
        <BarLabel>TARGET TPS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="rate in SERVER_CONFIG.tickRate.options"
            :key="rate"
            :active="model.displayTargetTickRate === rate"
            :active-level="model.displayTickRate === rate && model.displayTargetTickRate !== rate"
            :title="`Target ${rate} simulation ticks per second. Effective TPS cap is currently ${model.displayTickRate}.`"
            @click="model.setTickRateValue(rate)"
          >{{ rate }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Per-unit chassis-tilt EMA. SNAP = no smoothing (raw triangle-jump), FAST/MED/SLOW progressively heavier blending. Drives the sim's updateUnitTilt half-life.">TILT EMA:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="mode in SERVER_CONFIG.tiltEma.options"
            :key="mode"
            :active="model.serverTiltEmaMode === mode"
            :title="`Set chassis-tilt EMA to ${TILT_EMA_LABEL[mode]}.`"
            @click="model.setTiltEmaModeValue(mode)"
          >{{ TILT_EMA_LABEL[mode] }}</BarButton>
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
        <BarLabel>TARGET SPS:</BarLabel>
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
        <BarLabel>FULLSNAP:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in SERVER_CONFIG.keyframe.options"
            :key="String(opt)"
            :active="model.displayKeyframeRatio === opt"
            :title="
              opt === 'ALL'
                ? 'Every snapshot is a full keyframe'
                : opt === 'NONE'
                  ? 'Never send full keyframes (delta only)'
                  : secPerFullsnap(opt as number)
            "
            @click="model.setKeyframeRatioValue(opt)"
          >{{
            opt === 'ALL'
              ? 'ALL'
              : opt === 'NONE'
                ? 'NONE'
                : `1e-${Math.round(-Math.log10(opt as number))}`
          }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>LOD:</BarLabel>
        <BarButton
          :active="model.serverSimQuality === 'auto' && !model.serverAnySolo"
          :active-level="model.serverSimQuality === 'auto' && model.serverAnySolo"
          title="Auto-adjust sim throttling (lowest of TPS, CPU, units)"
          @click="model.setSimQualityValue('auto')"
        >AUTO</BarButton>
        <BarButtonGroup>
          <BarButton
            v-if="SERVER_SIM_LOD_SIGNALS_ENABLED.tps"
            :active="model.serverSimQuality === 'auto' && model.serverSignalStates.tps === 'solo'"
            :active-level="
              model.serverSimQuality === 'auto'
                && model.serverSignalStates.tps === 'active'
                && !model.serverAnySolo
            "
            :title="`Server TPS signal - click to cycle off / active / solo. Currently ${model.serverSignalStates.tps}.`"
            @click="model.cycleServerSignal('tps')"
          >TPS</BarButton>
          <BarButton
            v-if="SERVER_SIM_LOD_SIGNALS_ENABLED.cpu"
            :active="model.serverSimQuality === 'auto' && model.serverSignalStates.cpu === 'solo'"
            :active-level="
              model.serverSimQuality === 'auto'
                && model.serverSignalStates.cpu === 'active'
                && !model.serverAnySolo
            "
            :title="`Host CPU load signal - click to cycle off / active / solo. Currently ${model.serverSignalStates.cpu}.`"
            @click="model.cycleServerSignal('cpu')"
          >CPU</BarButton>
          <BarButton
            v-if="SERVER_SIM_LOD_SIGNALS_ENABLED.units"
            :active="model.serverSimQuality === 'auto' && model.serverSignalStates.units === 'solo'"
            :active-level="
              model.serverSimQuality === 'auto'
                && model.serverSignalStates.units === 'active'
                && !model.serverAnySolo
            "
            :title="`World fullness signal - click to cycle off / active / solo. Currently ${model.serverSignalStates.units}.`"
            @click="model.cycleServerSignal('units')"
          >UNITS</BarButton>
        </BarButtonGroup>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.graphics.options"
            :key="opt.value"
            :active="model.serverSimQuality === opt.value"
            :active-level="
              model.effectiveSimQuality === opt.value &&
              model.serverSimQuality !== opt.value
            "
            :title="`Lock sim throttling to ${opt.value} tier`"
            @click="model.setSimQualityValue(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
        <BarDivider />
      </BarControlGroup>
    </div>
  </div>
</template>
