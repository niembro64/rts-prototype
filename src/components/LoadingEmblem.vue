<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  mountLoadingUnitPreview,
  pickRandomLoadingUnit,
  type LoadingUnitPreviewRuntime,
} from './loadingUnitPreview3d';

const props = withDefaults(defineProps<{
  compact?: boolean;
  progress?: number;
  phase?: string;
}>(), {
  progress: 0,
  phase: 'Preparing battle',
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
const phaseText = computed(() => props.phase.trim() || 'Preparing battle');
const previewHost = ref<HTMLElement | null>(null);
const previewUnit = pickRandomLoadingUnit();
let previewRuntime: LoadingUnitPreviewRuntime | null = null;

onMounted(() => {
  if (!previewHost.value) return;
  previewRuntime = mountLoadingUnitPreview(
    previewHost.value,
    previewUnit.id,
    { fullBleed: props.compact !== true },
  );
});

onBeforeUnmount(() => {
  previewRuntime?.destroy();
  previewRuntime = null;
});
</script>

<template>
  <div class="loading-emblem" :class="{ compact: props.compact }">
    <div ref="previewHost" class="loader-unit-preview" aria-hidden="true"></div>
    <div class="loader-unit-name">{{ previewUnit.name }}</div>
    <div class="loader-title">BUDGET ANNIHILATION</div>
    <div class="loader-phase">{{ phaseText }}</div>
    <div class="loader-progress-wrap">
      <div
        class="loader-progress-track"
        role="progressbar"
        :aria-label="phaseText"
        :aria-valuenow="percentValue"
        :aria-valuetext="phaseText"
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
  --loader-size: min(100vw, 100vh);
  --loader-name-size: 13px;
  --loader-title-size: 22px;
  --loader-phase-size: 13px;
  --loader-gap: 10px;
  --loader-width: min(1280px, 92vw);
  --loader-track-height: clamp(16px, 2.2vh, 24px);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: var(--loader-gap);
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  padding: 0 max(18px, env(safe-area-inset-right)) max(34px, calc(env(safe-area-inset-bottom) + 28px)) max(18px, env(safe-area-inset-left));
  color: #edf3ff;
  text-align: center;
}

.loading-emblem:not(.compact)::before,
.loading-emblem:not(.compact)::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.loading-emblem:not(.compact)::before {
  z-index: 1;
  background:
    linear-gradient(180deg, rgba(5, 7, 10, 0.05) 0%, rgba(5, 7, 10, 0) 34%, rgba(5, 7, 10, 0.62) 100%),
    repeating-linear-gradient(0deg, rgba(237, 243, 255, 0.045) 0 1px, transparent 1px 9px);
}

.loading-emblem:not(.compact)::after {
  z-index: 0;
  background:
    linear-gradient(90deg, rgba(74, 158, 255, 0.2), transparent 18%, transparent 82%, rgba(110, 242, 207, 0.16)),
    linear-gradient(180deg, rgba(255, 255, 255, 0.05), transparent 45%);
  mix-blend-mode: screen;
}

.loading-emblem.compact {
  --loader-size: 58px;
  --loader-name-size: 9px;
  --loader-title-size: 12px;
  --loader-phase-size: 10px;
  --loader-gap: 5px;
  --loader-width: min(176px, 82vw);
  --loader-track-height: 8px;
  justify-content: center;
  width: auto;
  height: auto;
  padding: 0;
  overflow: visible;
}

.loader-unit-preview {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  filter:
    drop-shadow(0 0 34px rgba(237, 243, 255, 0.24))
    drop-shadow(0 0 56px rgba(110, 242, 207, 0.13));
}

.loading-emblem.compact .loader-unit-preview {
  position: relative;
  inset: auto;
  z-index: auto;
  width: var(--loader-size);
  height: var(--loader-size);
  filter:
    drop-shadow(0 0 20px rgba(237, 243, 255, 0.26))
    drop-shadow(0 0 34px rgba(110, 242, 207, 0.13));
}

.loader-unit-preview :deep(.loader-unit-canvas) {
  width: 100%;
  height: 100%;
  display: block;
}

.loader-unit-name {
  position: relative;
  z-index: 2;
  max-width: var(--loader-width);
  min-height: calc(var(--loader-name-size) * 1.1);
  font-family: monospace;
  font-size: clamp(var(--loader-name-size), 1.55vw, 18px);
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: 0;
  text-transform: uppercase;
  color: rgba(237, 243, 255, 0.8);
  text-shadow:
    0 0 14px rgba(237, 243, 255, 0.32),
    0 0 22px rgba(110, 242, 207, 0.16);
}

.loading-emblem.compact .loader-unit-name {
  font-size: var(--loader-name-size);
}

.loader-title {
  position: relative;
  z-index: 2;
  font-family: monospace;
  font-size: clamp(var(--loader-title-size), 3.6vw, 52px);
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: 0;
  text-transform: uppercase;
  text-shadow:
    0 0 18px rgba(74, 158, 255, 0.6),
    0 0 34px rgba(110, 242, 207, 0.18);
}

.loading-emblem.compact .loader-title {
  font-size: var(--loader-title-size);
}

.loader-phase {
  position: relative;
  z-index: 2;
  width: var(--loader-width);
  min-height: calc(var(--loader-phase-size) * 1.25);
  font-family: monospace;
  font-size: clamp(var(--loader-phase-size), 1.55vw, 18px);
  font-weight: 800;
  line-height: 1.25;
  color: rgba(237, 243, 255, 0.82);
  text-shadow: 0 0 14px rgba(74, 158, 255, 0.42);
}

.loading-emblem.compact .loader-phase {
  font-size: var(--loader-phase-size);
}

.loader-progress-wrap {
  position: relative;
  z-index: 2;
  width: var(--loader-width);
  display: grid;
  gap: 8px;
}

.loader-progress-track {
  position: relative;
  width: 100%;
  height: var(--loader-track-height);
  overflow: hidden;
  border: 1px solid rgba(237, 243, 255, 0.32);
  border-radius: 6px;
  background:
    repeating-linear-gradient(90deg, transparent 0 46px, rgba(237, 243, 255, 0.06) 46px 47px),
    linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0)),
    rgba(7, 15, 24, 0.9);
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.34),
    0 0 24px rgba(74, 158, 255, 0.22),
    0 0 42px rgba(110, 242, 207, 0.11);
}

.loader-progress-fill {
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background:
    linear-gradient(90deg, #4a9eff 0%, #57d6f4 45%, #f7fbff 56%, #6ef2cf 100%);
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
