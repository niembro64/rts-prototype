<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  compact?: boolean;
  progress?: number;
}>(), {
  progress: 0,
});

const clampedProgress = computed(() => {
  const raw = props.progress;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
});
const percentValue = computed(() => Math.round(clampedProgress.value * 100));
const progressBarStyle = computed(() => ({
  transform: `scaleX(${clampedProgress.value})`,
}));
</script>

<template>
  <div class="loading-emblem" :class="{ compact: props.compact }">
    <div class="loader-unit" aria-hidden="true">
      <span class="unit-track unit-track-left"></span>
      <span class="unit-track unit-track-right"></span>
      <span class="unit-hull"></span>
      <span class="unit-cockpit"></span>
      <span class="unit-turret"></span>
      <span class="unit-barrel"></span>
    </div>
    <div class="loader-title">BUDGET ANNIHILATION</div>
    <div class="loader-progress-wrap">
      <div class="loader-progress-meta">
        <span>LOADED</span>
        <span>{{ percentValue }}%</span>
      </div>
      <div
        class="loader-progress-track"
        role="progressbar"
        aria-label="Loading progress"
        :aria-valuenow="percentValue"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="loader-progress-fill" :style="progressBarStyle"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.loading-emblem {
  --loader-size: 70px;
  --loader-title-size: 22px;
  --loader-percent-size: 13px;
  --loader-gap: 12px;
  --loader-width: min(360px, 76vw);
  --loader-track-height: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--loader-gap);
  color: #edf3ff;
  text-align: center;
}

.loading-emblem.compact {
  --loader-size: 38px;
  --loader-title-size: 12px;
  --loader-percent-size: 10px;
  --loader-gap: 7px;
  --loader-width: min(176px, 82vw);
  --loader-track-height: 8px;
}

.loader-unit {
  position: relative;
  width: var(--loader-size);
  height: var(--loader-size);
  filter:
    drop-shadow(0 0 16px rgba(112, 205, 255, 0.24))
    drop-shadow(0 0 26px rgba(110, 242, 207, 0.14));
}

.unit-track,
.unit-hull,
.unit-cockpit,
.unit-turret,
.unit-barrel {
  position: absolute;
  display: block;
  box-sizing: border-box;
}

.unit-track {
  top: 28%;
  width: 19%;
  height: 48%;
  border-radius: 999px;
  background:
    repeating-linear-gradient(
      to bottom,
      #0b1118 0 5px,
      #26303b 5px 8px
    );
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  transform: rotate(-18deg);
}

.unit-track-left {
  left: 18%;
}

.unit-track-right {
  right: 18%;
}

.unit-hull {
  left: 28%;
  top: 31%;
  width: 44%;
  height: 38%;
  border-radius: 6px 8px 7px 8px;
  background: linear-gradient(135deg, #35a6c8 0%, #126077 52%, #0d3344 100%);
  border: 1px solid rgba(188, 246, 255, 0.28);
  transform: rotate(-18deg);
}

.unit-cockpit {
  left: 48%;
  top: 26%;
  width: 20%;
  height: 23%;
  border-radius: 999px;
  background: radial-gradient(circle at 35% 35%, #d7f8ff 0 18%, #6eead1 40%, #1c7b8e 78%);
  transform: rotate(-18deg);
}

.unit-turret {
  left: 39%;
  top: 39%;
  width: 27%;
  height: 23%;
  border-radius: 999px;
  background: linear-gradient(135deg, #7a8798, #263343);
  transform: rotate(-18deg);
}

.unit-barrel {
  left: 59%;
  top: 43%;
  width: 34%;
  height: 9%;
  border-radius: 999px;
  background: linear-gradient(90deg, #6d7785, #d5dbe6);
  transform: rotate(-18deg);
  transform-origin: 0 50%;
}

.loader-title {
  font-family: monospace;
  font-size: var(--loader-title-size);
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: 0;
  text-transform: uppercase;
  text-shadow:
    0 0 18px rgba(74, 158, 255, 0.6),
    0 0 34px rgba(110, 242, 207, 0.18);
}

.loader-progress-wrap {
  width: var(--loader-width);
  display: grid;
  gap: 6px;
}

.loader-progress-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-family: monospace;
  font-size: var(--loader-percent-size);
  font-weight: 800;
  color: rgba(237, 243, 255, 0.82);
  line-height: 1;
  text-shadow: 0 0 14px rgba(74, 158, 255, 0.42);
}

.loader-progress-track {
  width: 100%;
  height: var(--loader-track-height);
  overflow: hidden;
  border: 1px solid rgba(237, 243, 255, 0.24);
  border-radius: 4px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0)),
    rgba(7, 15, 24, 0.9);
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.34),
    0 0 24px rgba(74, 158, 255, 0.22);
}

.loader-progress-fill {
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background:
    linear-gradient(90deg, #4a9eff 0%, #57d6f4 52%, #6ef2cf 100%);
  box-shadow:
    0 0 16px rgba(74, 158, 255, 0.5),
    0 0 22px rgba(110, 242, 207, 0.28);
  transition: transform 0.18s ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .loader-progress-fill {
    transition: none;
  }
}
</style>
