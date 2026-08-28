<script setup lang="ts">
import BarButton from './BarButton.vue';
import BarButtons from './BarButtons.vue';
import BarControlGroup from './BarControlGroup.vue';
import BarDivider from './BarDivider.vue';
import BarLabel from './BarLabel.vue';
import type { GameCanvasServerControlBarModel } from './gameCanvasControlBarModels';
import { fmt4, msBarStyle, statBarStyle } from './uiUtils';

defineProps<{
  model: GameCanvasServerControlBarModel;
}>();

function simTpsTitle(rateHz: number): string {
  return `Actual lockstep frames advanced per wall-clock second in this browser. This can be below ${rateHz} when the browser pump is slow or waiting for command frames; the selected fixed simulation step remains ${rateHz} Hz.`;
}

function simTpsTarget(rateHz: number): number {
  return rateHz;
}

function cpuTitle(rateHz: number): string {
  return `Local lockstep simulation CPU load - measured server-simulation work as a percent of the selected fixed ${rateHz} Hz frame budget.`;
}

</script>

<template>
  <div
    class="control-bar"
    :class="{ 'bar-readonly': model.isReadonly }"
    :style="model.barStyle"
  >
    <div class="bar-controls">
      <BarControlGroup>
        <BarButtons>
          <BarButton
            :active="true"
            class="bar-label"
            title="Server and lockstep runtime status"
          >
            <span class="bar-label-text">{{ model.serverLabel }}</span
            ><span class="bar-label-hover">STATUS</span>
          </BarButton>
        </BarButtons>
      </BarControlGroup>
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
        <BarLabel :title="simTpsTitle(model.displayTickRate)">ADV TPS:</BarLabel>
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
                  statBarStyle(model.displayServerTpsAvg, simTpsTarget(model.displayTickRate), model.isReadonly)
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
                  statBarStyle(model.displayServerTpsWorst, simTpsTarget(model.displayTickRate), model.isReadonly)
                "
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="cpuTitle(model.displayTickRate)">CPU:</BarLabel>
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
        <BarLabel
          title="Pathfinding queues per player as route / refine / refresh (route = first-motion queue, refine = search queue, refresh = stale-route queue), then request-to-route latency and pathfinding cost per tick over the last 5 s"
          >PATH:</BarLabel
        >
        <div class="path-queues">
          <span
            v-for="q in model.displayPathQueues"
            :key="q.playerId"
            class="path-queue"
            :title="`P${q.playerId}: route ${q.route}, refine ${q.refine}, refresh ${q.refresh}`"
            ><span class="path-queue-player">P{{ q.playerId }}</span
            >{{ q.route }}/{{ q.refine }}/{{ q.refresh }}</span
          >
          <span v-if="model.displayPathQueues.length === 0" class="path-queue path-queue-idle">&mdash;</span>
        </div>
        <div class="stat-bar-group">
          <div class="stat-bar" title="Request-to-route latency, average over the last 5 s">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.displayPathRouteAvgSec) }}s</span>
              <span class="fps-label">route avg</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.displayPathRouteAvgSec * 1000, 2000)"></div>
            </div>
          </div>
          <div class="stat-bar" title="Request-to-route latency, worst over the last 5 s">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.displayPathRouteWorstSec) }}s</span>
              <span class="fps-label">worst</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.displayPathRouteWorstSec * 1000, 2000)"></div>
            </div>
          </div>
          <div class="stat-bar" title="Queue wait before a search begins, average / worst over the last 5 s">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.displayPathWaitAvgSec) }}s</span>
              <span class="fps-label">wait / {{ fmt4(model.displayPathWaitWorstSec) }}s</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.displayPathWaitAvgSec * 1000, 2000)"></div>
            </div>
          </div>
          <div class="stat-bar" title="Pathfinding phase wall time per fixed tick, average / worst over the last 5 s">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.displayPathMsAvg) }}ms</span>
              <span class="fps-label">/ {{ fmt4(model.displayPathMsWorst) }}ms</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.displayPathMsAvg, 50)"></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Entities alive match-wide (units + buildings) / entity count cap">ENTITIES:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ model.displayUnitCount }}</span>
              <span class="fps-label">/ {{ model.displayUnitCap }}</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="statBarStyle(model.displayUnitCount, model.displayUnitCap)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
    </div>
  </div>
</template>

<style scoped>
.path-queues {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-wrap: nowrap;
}
/* Same palette as .fps-value / .fps-label in barControls.css: light
   monospace digits on the bar's dark ground, dim uppercase tag. */
.path-queue {
  color: #b0b0b0;
  font-family: 'Courier New', Courier, monospace;
  font-weight: bold;
  font-size: 11px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(176, 176, 176, 0.25);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.path-queue-player {
  color: #8a8a8a;
  font-size: 9px;
  font-weight: normal;
  text-transform: uppercase;
  margin-right: 3px;
}
.path-queue-idle {
  color: #777;
  border-color: transparent;
}
</style>
