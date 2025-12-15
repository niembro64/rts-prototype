<script setup lang="ts">
import { computed } from 'vue';

export interface EconomyInfo {
  stockpile: number;
  maxStockpile: number;
  income: number;       // Total income (base + production)
  baseIncome: number;
  production: number;   // From solar panels
  expenditure: number;
  netFlow: number;      // income - expenditure
  solarCount: number;
  factoryCount: number;
  unitCount: number;    // Current units for this player
  unitCap: number;      // Max units allowed for this player
}

const props = defineProps<{
  economy: EconomyInfo;
  playerName: string;
  playerColor: string;
}>();

const stockpilePercent = computed(() =>
  Math.round((props.economy.stockpile / props.economy.maxStockpile) * 100)
);

const stockpileColor = computed(() => {
  const pct = stockpilePercent.value;
  if (pct > 60) return '#00ff88';
  if (pct > 30) return '#ffcc00';
  return '#ff4444';
});

const netFlowColor = computed(() => {
  if (props.economy.netFlow > 0) return '#00ff88';
  if (props.economy.netFlow < 0) return '#ff4444';
  return '#888888';
});

const netFlowSign = computed(() => {
  if (props.economy.netFlow > 0) return '+';
  return '';
});

const unitCapColor = computed(() => {
  const pct = (props.economy.unitCount / props.economy.unitCap) * 100;
  if (pct >= 100) return '#ff4444';
  if (pct >= 80) return '#ffcc00';
  return '#00ff88';
});

const isAtUnitCap = computed(() => props.economy.unitCount >= props.economy.unitCap);
</script>

<template>
  <div class="top-bar">
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
        <span :style="{ color: stockpileColor }">{{ Math.floor(economy.stockpile) }}</span>
        <span class="max-value">/ {{ economy.maxStockpile }}</span>
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
        <span class="positive">+{{ economy.income.toFixed(1) }}/s</span>
      </div>
      <div class="stat-detail">
        Base: {{ economy.baseIncome }} | Solar: +{{ economy.production.toFixed(1) }}
      </div>
    </div>

    <!-- Expenditure -->
    <div class="economy-section">
      <div class="stat-label">Spending</div>
      <div class="stat-value expenditure">
        <span :class="economy.expenditure > 0 ? 'negative' : 'neutral'">
          -{{ economy.expenditure.toFixed(1) }}/s
        </span>
      </div>
    </div>

    <!-- Net flow -->
    <div class="economy-section">
      <div class="stat-label">Net</div>
      <div class="stat-value net-flow" :style="{ color: netFlowColor }">
        {{ netFlowSign }}{{ economy.netFlow.toFixed(1) }}/s
      </div>
    </div>

    <!-- Unit count -->
    <div class="economy-section units">
      <div class="stat-label">Units</div>
      <div class="stat-value" :style="{ color: unitCapColor }">
        {{ economy.unitCount }} / {{ economy.unitCap }}
        <span v-if="isAtUnitCap" class="cap-warning" title="At unit cap!">(MAX)</span>
      </div>
    </div>

    <!-- Building counts -->
    <div class="economy-section buildings">
      <div class="stat-label">Buildings</div>
      <div class="building-counts">
        <span class="building-count solar" title="Solar Panels">
          ☀️ {{ economy.solarCount }}
        </span>
        <span class="building-count factory" title="Factories">
          🏭 {{ economy.factoryCount }}
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
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.7) 100%);
  border-bottom: 2px solid rgba(255, 255, 255, 0.2);
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
  border-right: 1px solid rgba(255, 255, 255, 0.2);
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
  color: rgba(255, 255, 255, 0.5);
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

.positive {
  color: #00ff88;
}

.negative {
  color: #ff4444;
}

.neutral {
  color: #888888;
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
