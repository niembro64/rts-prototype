<script setup lang="ts">
import { computed } from 'vue';
import { fmtSigned, signedColor } from './uiUtils';

export type { EconomyInfo } from '@/types/ui';
import type { EconomyInfo } from '@/types/ui';

const props = defineProps<{
  economy: EconomyInfo;
  playerName: string;
  playerColor: string;
}>();

const stockpilePercent = computed(() =>
  Math.round((props.economy.stockpile.curr / props.economy.stockpile.max) * 100)
);

const stockpileColor = computed(() => {
  const pct = stockpilePercent.value;
  if (pct > 60) return '#00ff88';
  if (pct > 30) return '#ffcc00';
  return '#ff4444';
});

const unitCapColor = computed(() => {
  const pct = (props.economy.units.count / props.economy.units.cap) * 100;
  if (pct >= 100) return '#ff4444';
  if (pct >= 80) return '#ffcc00';
  return '#00ff88';
});

const isAtUnitCap = computed(() => props.economy.units.count >= props.economy.units.cap);
</script>

<template>
  <div class="top-bar" :style="{ '--player-color': playerColor }">
    <!-- Player indicator -->
    <div class="player-section">
      <span class="player-dot" :style="{ backgroundColor: playerColor }"></span>
      <span class="player-name">{{ playerName }}</span>
    </div>

    <!-- Energy stockpile -->
    <div class="economy-section stockpile-section">
      <div class="stat-label">Energy</div>
      <div class="stat-value">
        <span class="energy-icon">⚡</span>
        <span :style="{ color: stockpileColor }">{{ fmtSigned(economy.stockpile.curr) }}</span>
        <span class="max-value">/ {{ economy.stockpile.max }}</span>
      </div>
      <div class="stockpile-bar">
        <div
          class="stockpile-fill"
          :style="{ width: stockpilePercent + '%', backgroundColor: stockpileColor }"
        ></div>
      </div>
    </div>

    <!-- Income breakdown -->
    <div class="economy-section">
      <div class="stat-label">Income</div>
      <div class="stat-value income">
        <span :style="{ color: signedColor(economy.income.total) }">{{ fmtSigned(economy.income.total) }}/s</span>
      </div>
      <div class="stat-detail">
        <span :style="{ color: signedColor(economy.income.base) }">Base: {{ fmtSigned(economy.income.base) }}</span>
        |
        <span :style="{ color: signedColor(economy.income.production) }">Solar: {{ fmtSigned(economy.income.production) }}</span>
      </div>
    </div>

    <!-- Expenditure -->
    <div class="economy-section">
      <div class="stat-label">Spending</div>
      <div class="stat-value expenditure">
        <span :style="{ color: signedColor(-economy.expenditure) }">
          {{ fmtSigned(-economy.expenditure) }}/s
        </span>
      </div>
    </div>

    <!-- Net flow -->
    <div class="economy-section">
      <div class="stat-label">Net</div>
      <div class="stat-value net-flow" :style="{ color: signedColor(economy.netFlow) }">
        {{ fmtSigned(economy.netFlow) }}/s
      </div>
    </div>

    <!-- Unit count -->
    <div class="economy-section units">
      <div class="stat-label">Units</div>
      <div class="stat-value" :style="{ color: unitCapColor }">
        {{ economy.units.count }} / {{ economy.units.cap }}
        <span v-if="isAtUnitCap" class="cap-warning" title="At unit cap!">(MAX)</span>
      </div>
    </div>

    <!-- Building counts -->
    <div class="economy-section buildings">
      <div class="stat-label">Buildings</div>
      <div class="building-counts">
        <span class="building-count solar" title="Solar Panels">
          ☀️ {{ economy.buildings.solar }}
        </span>
        <span class="building-count factory" title="Factories">
          🏭 {{ economy.buildings.factory }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.top-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 50px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--player-color) 15%, transparent) 0%, transparent 100%),
    linear-gradient(180deg, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.7) 100%);
  border-bottom: 2px solid var(--player-color);
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 24px;
  font-family: monospace;
  color: white;
  z-index: 1000;
  pointer-events: auto;
}

.player-section {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 16px;
  border-right: 1px solid color-mix(in srgb, var(--player-color) 40%, transparent);
}

.player-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.5);
}

.player-name {
  font-weight: bold;
  font-size: 14px;
}

.economy-section {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.stat-label {
  font-size: 10px;
  color: color-mix(in srgb, var(--player-color) 50%, rgba(255, 255, 255, 0.5));
  text-transform: uppercase;
}

.stat-value {
  font-size: 16px;
  font-weight: bold;
  display: flex;
  align-items: center;
  gap: 4px;
}

.energy-icon {
  font-size: 14px;
}

.max-value {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  font-weight: normal;
}

.stat-detail {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.5);
}

.stockpile-section {
  min-width: 140px;
}

.stockpile-bar {
  width: 100%;
  height: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 2px;
}

.stockpile-fill {
  height: 100%;
  transition: width 0.2s ease, background-color 0.3s ease;
}

.buildings {
  margin-left: auto;
}

.building-counts {
  display: flex;
  gap: 12px;
}

.building-count {
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.building-count.solar {
  color: #ffcc00;
}

.building-count.factory {
  color: #88ccff;
}

.units {
  min-width: 80px;
}

.cap-warning {
  font-size: 10px;
  animation: blink 1s infinite;
}

@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0.5; }
}
</style>
