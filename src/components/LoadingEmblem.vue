<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  mountLoadingUnitPreview,
  pickRandomLoadingEntity,
  type LoadingUnitPreviewRuntime,
} from './loadingUnitPreview3d';
import { isMobileLikeBrowser } from '@/browserRuntime';
import { buildLoadingEntityInfo } from './loadingUnitInfo';
import LoadingInfoColumn from './LoadingInfoColumn.vue';

const props = withDefaults(defineProps<{
  progress?: number;
  phase?: string;
  nextLabel?: string;
  showProgress?: boolean;
}>(), {
  progress: 0,
  phase: 'Preparing battle',
  nextLabel: '',
  showProgress: true,
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
const nextLabelText = computed(() => props.nextLabel.trim());
const previewHost = ref<HTMLElement | null>(null);
const previewEntity = pickRandomLoadingEntity();
const entityInfo = buildLoadingEntityInfo(previewEntity.kind, previewEntity.id);
const previewEnabled = !isMobileLikeBrowser();
const previewReady = ref(false);
let previewRuntime: LoadingUnitPreviewRuntime | null = null;

onMounted(() => {
  if (!previewEnabled) {
    previewReady.value = true;
    return;
  }
  if (!previewHost.value) return;
  previewRuntime = mountLoadingUnitPreview(
    previewHost.value,
    previewEntity.kind,
    previewEntity.id,
    {
      fullBleed: true,
      onReady: () => {
        previewReady.value = true;
      },
    },
  );
});

onBeforeUnmount(() => {
  previewRuntime?.destroy();
  previewRuntime = null;
});
</script>

<template>
  <div class="loading-emblem">
    <div class="loader-title">BUDGET ANNIHILATION</div>

    <div class="loader-body">
      <div class="loader-info-col left">
        <LoadingInfoColumn :sections="entityInfo.leftSections" />
      </div>

      <div class="loader-stage-col">
        <div class="loader-unit-name">{{ previewEntity.name }}</div>
        <div class="loader-stage">
          <div
            v-if="previewEnabled"
            ref="previewHost"
            class="loader-unit-preview"
            :class="{ ready: previewReady }"
            aria-hidden="true"
          ></div>
        </div>
        <div class="loader-summary-strip">
          <div
            v-for="item in entityInfo.summary"
            :key="item.label"
            class="loader-summary-item"
          >
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </div>
        </div>
      </div>

      <div class="loader-info-col right">
        <LoadingInfoColumn :sections="entityInfo.rightSections" />
      </div>
    </div>

    <div class="loader-footer">
      <div v-if="nextLabelText" class="loader-mode-banner">{{ nextLabelText }}</div>
      <div class="loader-phase">{{ phaseText }}</div>
      <div v-if="props.showProgress" class="loader-progress-wrap">
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
  </div>
</template>

<style scoped>
.loading-emblem {
  --loader-gap: 14px;
  --loader-width: min(1280px, 92vw);
  --loader-track-height: clamp(16px, 2.2vh, 24px);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--loader-gap);
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  padding:
    max(18px, env(safe-area-inset-top))
    max(18px, env(safe-area-inset-right))
    max(24px, calc(env(safe-area-inset-bottom) + 18px))
    max(18px, env(safe-area-inset-left));
  color: #edf3ff;
  text-align: center;
}

.loading-emblem::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    linear-gradient(180deg, rgba(5, 7, 10, 0.05) 0%, rgba(5, 7, 10, 0) 34%, rgba(5, 7, 10, 0.62) 100%),
    repeating-linear-gradient(0deg, rgba(237, 243, 255, 0.045) 0 1px, transparent 1px 9px);
}

.loader-mode-banner {
  position: relative;
  z-index: 2;
  font-family: monospace;
  font-size: clamp(28px, 5.5vw, 72px);
  font-weight: 900;
  line-height: 1;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: rgba(110, 242, 207, 0.96);
  text-shadow:
    0 0 18px rgba(110, 242, 207, 0.55),
    0 0 36px rgba(74, 158, 255, 0.32);
  padding: 4px 0 2px;
}

.loader-body {
  position: relative;
  z-index: 2;
  flex: 1 1 auto;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  justify-content: center;
  gap: clamp(10px, 1.6vw, 24px);
  min-height: 0;
}

/* Left/right entity-info columns flank the spinning visual. */
.loader-info-col {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 14px;
  box-sizing: border-box;
  border: 1px solid rgba(237, 243, 255, 0.16);
  border-radius: 10px;
  background:
    linear-gradient(180deg, rgba(10, 19, 29, 0.82), rgba(4, 8, 13, 0.76)),
    rgba(5, 8, 12, 0.72);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.035),
    0 18px 46px rgba(0, 0, 0, 0.34);
}

/* Center column: name above the visual, summary strip below it. */
.loader-stage-col {
  flex: 1.5 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.loader-stage {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  border: 1px solid rgba(237, 243, 255, 0.12);
  border-radius: 10px;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 60%, rgba(74, 158, 255, 0.18), transparent 65%),
    rgba(3, 7, 12, 0.55);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.03),
    0 18px 46px rgba(0, 0, 0, 0.34);
}

.loader-unit-preview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  opacity: 0;
  transition: opacity 520ms ease-out;
}

.loader-unit-preview.ready {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .loader-unit-preview {
    transition: none;
  }
}

.loader-unit-preview :deep(.loader-unit-stage) {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.loader-unit-preview :deep(.loader-unit-canvas) {
  width: 100%;
  height: 100%;
  display: block;
}

.loader-unit-name {
  font-family: monospace;
  font-size: clamp(20px, 2.6vw, 38px);
  font-weight: 900;
  line-height: 1.05;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  text-align: center;
  color: rgba(237, 243, 255, 0.96);
  text-shadow:
    0 0 16px rgba(237, 243, 255, 0.35),
    0 0 28px rgba(110, 242, 207, 0.22);
}

.loader-summary-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid rgba(237, 243, 255, 0.16);
  border-radius: 8px;
  overflow: hidden;
  background: rgba(3, 9, 15, 0.58);
  box-shadow: 0 0 28px rgba(74, 158, 255, 0.12);
}

.loader-summary-item {
  display: grid;
  gap: 2px;
  min-width: 0;
  padding: 7px 9px;
  font-family: monospace;
  line-height: 1.1;
  background: rgba(237, 243, 255, 0.035);
  text-align: left;
}

.loader-summary-item span {
  overflow-wrap: anywhere;
  font-size: 10px;
  color: rgba(237, 243, 255, 0.56);
  text-transform: uppercase;
}

.loader-summary-item strong {
  overflow-wrap: anywhere;
  font-size: 12px;
  color: rgba(237, 243, 255, 0.92);
}

.loader-footer {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.loader-title {
  font-family: monospace;
  font-size: clamp(20px, 3vw, 44px);
  font-weight: 800;
  line-height: 1.1;
  text-transform: uppercase;
  text-shadow:
    0 0 18px rgba(74, 158, 255, 0.6),
    0 0 34px rgba(110, 242, 207, 0.18);
}

.loader-phase {
  width: var(--loader-width);
  min-height: 1.25em;
  font-family: monospace;
  font-size: clamp(13px, 1.4vw, 16px);
  font-weight: 800;
  line-height: 1.25;
  color: rgba(237, 243, 255, 0.82);
  text-shadow: 0 0 14px rgba(74, 158, 255, 0.42);
}

.loader-progress-wrap {
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

@media (max-width: 900px) {
  .loader-body {
    flex-direction: column;
  }

  .loader-stage-col {
    order: -1;
    flex: 0 0 38%;
    min-height: 200px;
  }

  .loader-info-col {
    flex: 1 1 auto;
    padding: 10px;
  }

  .loader-summary-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 520px) {
  .loader-mode-banner {
    letter-spacing: 0.14em;
  }

  .loader-summary-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
