<script setup lang="ts">
defineProps<{
  compact?: boolean;
}>();
</script>

<template>
  <div class="loading-emblem" :class="{ compact }">
    <div class="loader-orbit" aria-hidden="true">
      <div class="loader-ring"></div>
      <div class="loader-ping"></div>
      <div class="loader-unit">
        <span class="unit-track unit-track-left"></span>
        <span class="unit-track unit-track-right"></span>
        <span class="unit-hull"></span>
        <span class="unit-cockpit"></span>
        <span class="unit-turret"></span>
        <span class="unit-barrel"></span>
      </div>
    </div>
    <div class="loader-title">BUDGET ANNIHILATION</div>
  </div>
</template>

<style scoped>
.loading-emblem {
  --loader-size: 86px;
  --loader-title-size: 22px;
  --loader-gap: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--loader-gap);
  color: #edf3ff;
  text-align: center;
}

.loading-emblem.compact {
  --loader-size: 54px;
  --loader-title-size: 12px;
  --loader-gap: 9px;
}

.loader-orbit {
  position: relative;
  width: var(--loader-size);
  height: var(--loader-size);
  filter: drop-shadow(0 0 20px rgba(112, 205, 255, 0.28));
}

.loader-ring,
.loader-ping {
  position: absolute;
  inset: 0;
  border-radius: 50%;
}

.loader-ring {
  border: 2px solid rgba(237, 243, 255, 0.13);
  border-top-color: #80c7ff;
  border-right-color: rgba(110, 242, 207, 0.72);
  animation: loader-ring-spin 1.1s linear infinite;
}

.loader-ping {
  inset: 13%;
  border: 1px solid rgba(110, 242, 207, 0.28);
  animation: loader-ping 1.55s ease-out infinite;
}

.loader-unit {
  position: absolute;
  inset: 18%;
  animation: loader-unit-spin 2.2s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
  transform-origin: 50% 50%;
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
  border-radius: 8px 13px 10px 13px;
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

@keyframes loader-ring-spin {
  to { transform: rotate(360deg); }
}

@keyframes loader-unit-spin {
  0% { transform: rotate(0deg) scale(0.98); }
  50% { transform: rotate(180deg) scale(1.04); }
  100% { transform: rotate(360deg) scale(0.98); }
}

@keyframes loader-ping {
  0% {
    opacity: 0.72;
    transform: scale(0.62);
  }
  100% {
    opacity: 0;
    transform: scale(1.32);
  }
}

@media (prefers-reduced-motion: reduce) {
  .loader-ring,
  .loader-ping,
  .loader-unit {
    animation-duration: 8s;
  }
}
</style>
