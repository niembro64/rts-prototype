<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  mountLoadingUnitPreview,
  pickRandomLoadingUnit,
  type LoadingUnitPreviewRuntime,
} from './loadingUnitPreview3d';
import { buildLoadingUnitInfo } from './loadingUnitInfo';

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
const unitInfo = buildLoadingUnitInfo(previewUnit.id);
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
    <div v-if="!props.compact" class="loader-info-panel loader-info-left">
      <section
        v-for="section in unitInfo.leftSections"
        :key="section.id"
        class="loader-info-section"
      >
        <h2>{{ section.title }}</h2>
        <div class="loader-info-list">
          <div
            v-for="item in section.items"
            :key="`${section.id}-${item.label}`"
            class="loader-info-item"
          >
            <div class="loader-info-row">
              <span class="loader-info-label">{{ item.label }}</span>
              <span v-if="item.value" class="loader-info-value">{{ item.value }}</span>
            </div>
            <div v-if="item.detail" class="loader-info-detail">{{ item.detail }}</div>
            <div v-if="item.children?.length" class="loader-info-children">
              <div
                v-for="child in item.children"
                :key="`${section.id}-${item.label}-${child.label}`"
                class="loader-info-item child"
              >
                <div class="loader-info-row">
                  <span class="loader-info-label">{{ child.label }}</span>
                  <span v-if="child.value" class="loader-info-value">{{ child.value }}</span>
                </div>
                <div v-if="child.detail" class="loader-info-detail">{{ child.detail }}</div>
                <div v-if="child.children?.length" class="loader-info-children nested">
                  <div
                    v-for="grandchild in child.children"
                    :key="`${section.id}-${item.label}-${child.label}-${grandchild.label}`"
                    class="loader-info-row grandchild"
                  >
                    <span class="loader-info-label">{{ grandchild.label }}</span>
                    <span v-if="grandchild.value" class="loader-info-value">{{ grandchild.value }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
    <div v-if="!props.compact" class="loader-info-panel loader-info-right">
      <section
        v-for="section in unitInfo.rightSections"
        :key="section.id"
        class="loader-info-section"
      >
        <h2>{{ section.title }}</h2>
        <div class="loader-info-list">
          <div
            v-for="item in section.items"
            :key="`${section.id}-${item.label}`"
            class="loader-info-item"
          >
            <div class="loader-info-row">
              <span class="loader-info-label">{{ item.label }}</span>
              <span v-if="item.value" class="loader-info-value">{{ item.value }}</span>
            </div>
            <div v-if="item.detail" class="loader-info-detail">{{ item.detail }}</div>
            <div v-if="item.children?.length" class="loader-info-children">
              <div
                v-for="child in item.children"
                :key="`${section.id}-${item.label}-${child.label}`"
                class="loader-info-item child"
              >
                <div class="loader-info-row">
                  <span class="loader-info-label">{{ child.label }}</span>
                  <span v-if="child.value" class="loader-info-value">{{ child.value }}</span>
                </div>
                <div v-if="child.detail" class="loader-info-detail">{{ child.detail }}</div>
                <div v-if="child.children?.length" class="loader-info-children nested">
                  <div
                    v-for="grandchild in child.children"
                    :key="`${section.id}-${item.label}-${child.label}-${grandchild.label}`"
                    class="loader-info-row grandchild"
                  >
                    <span class="loader-info-label">{{ grandchild.label }}</span>
                    <span v-if="grandchild.value" class="loader-info-value">{{ grandchild.value }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
    <div class="loader-unit-name">{{ previewUnit.name }}</div>
    <div v-if="!props.compact" class="loader-summary-strip">
      <div
        v-for="item in unitInfo.summary"
        :key="item.label"
        class="loader-summary-item"
      >
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </div>
    </div>
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
  filter: none;
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

.loader-info-panel {
  position: absolute;
  z-index: 2;
  top: clamp(18px, 3vh, 34px);
  bottom: clamp(205px, 29vh, 255px);
  width: clamp(270px, 27vw, 430px);
  box-sizing: border-box;
  overflow: auto;
  padding: 12px;
  border: 1px solid rgba(237, 243, 255, 0.16);
  border-radius: 8px;
  background:
    linear-gradient(180deg, rgba(10, 19, 29, 0.82), rgba(4, 8, 13, 0.76)),
    rgba(5, 8, 12, 0.72);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.035),
    0 18px 46px rgba(0, 0, 0, 0.34);
  pointer-events: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(110, 242, 207, 0.42) rgba(255, 255, 255, 0.06);
}

.loader-info-left {
  left: max(18px, env(safe-area-inset-left));
}

.loader-info-right {
  right: max(18px, env(safe-area-inset-right));
}

.loader-info-section + .loader-info-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(237, 243, 255, 0.12);
}

.loader-info-section h2 {
  margin: 0 0 8px;
  font-family: monospace;
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0;
  text-transform: uppercase;
  color: rgba(110, 242, 207, 0.86);
}

.loader-info-list {
  display: grid;
  gap: 6px;
}

.loader-info-item {
  min-width: 0;
}

.loader-info-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  font-family: monospace;
  font-size: 10px;
  line-height: 1.24;
}

.loader-info-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  color: rgba(237, 243, 255, 0.58);
  text-align: left;
}

.loader-info-value {
  flex: 0 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  color: rgba(237, 243, 255, 0.9);
  text-align: right;
}

.loader-info-detail {
  margin-top: 2px;
  font-family: monospace;
  font-size: 9px;
  line-height: 1.25;
  color: rgba(237, 243, 255, 0.52);
  text-align: left;
}

.loader-info-children {
  display: grid;
  gap: 4px;
  margin-top: 5px;
  padding-left: 9px;
  border-left: 1px solid rgba(74, 158, 255, 0.28);
}

.loader-info-children.nested {
  gap: 3px;
  margin-top: 4px;
  border-left-color: rgba(110, 242, 207, 0.22);
}

.loader-info-item.child .loader-info-row,
.loader-info-row.grandchild {
  font-size: 9px;
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

.loader-summary-strip {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 1px;
  width: min(980px, 76vw);
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
}

.loader-summary-item span {
  overflow-wrap: anywhere;
  font-size: 9px;
  color: rgba(237, 243, 255, 0.56);
  text-transform: uppercase;
}

.loader-summary-item strong {
  overflow-wrap: anywhere;
  font-size: 11px;
  color: rgba(237, 243, 255, 0.92);
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

@media (max-width: 900px) {
  .loader-info-panel {
    top: max(10px, env(safe-area-inset-top));
    bottom: auto;
    width: calc(50vw - 16px);
    max-height: 34vh;
    padding: 8px;
  }

  .loader-info-left {
    left: 8px;
  }

  .loader-info-right {
    right: 8px;
  }

  .loader-info-section h2 {
    font-size: 10px;
  }

  .loader-info-row {
    gap: 7px;
    font-size: 9px;
  }

  .loader-info-item.child .loader-info-row,
  .loader-info-row.grandchild,
  .loader-info-detail {
    font-size: 8px;
  }

  .loader-summary-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    width: min(620px, 92vw);
  }
}

@media (max-width: 520px) {
  .loader-info-panel {
    width: calc(50vw - 12px);
    max-height: 30vh;
    padding: 7px;
  }

  .loader-summary-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .loader-summary-item {
    padding: 5px 7px;
  }

  .loader-summary-item strong {
    font-size: 9px;
  }
}
</style>
