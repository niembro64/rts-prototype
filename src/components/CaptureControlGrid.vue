<script setup lang="ts">
// The VID/PIC capture grid that sits beside the fullscreen toggle. Pure
// presentation: mode cells come straight from captureConfig.json and every
// click is forwarded to the CaptureController; the only local state is the
// elapsed-time readout on the active recording cell.
import { onBeforeUnmount, ref, watch } from 'vue';
import { CAPTURE_CONFIG, type CaptureModeConfig, type CaptureModeId } from '@/captureConfig';
import type {
  CaptureAvailability,
  CaptureLifecycleState,
} from '../game/capture/CaptureController';

const props = defineProps<{
  availability: Readonly<Record<CaptureModeId, CaptureAvailability>>;
  lifecycleState: CaptureLifecycleState;
  recordingModeId: CaptureModeId | null;
  recordingStartedAtMs: number | null;
}>();

const emit = defineEmits<{
  trigger: [modeId: CaptureModeId];
}>();

const elapsedLabel = ref('0:00');
let elapsedTimer: number | null = null;

function stopElapsedTimer(): void {
  if (elapsedTimer !== null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

watch(
  () => props.recordingStartedAtMs,
  (startedAtMs) => {
    stopElapsedTimer();
    if (startedAtMs === null) {
      elapsedLabel.value = '0:00';
      return;
    }
    const refresh = () => {
      const totalSeconds = Math.max(0, Math.floor((performance.now() - startedAtMs) / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      elapsedLabel.value = `${minutes}:${seconds}`;
    };
    refresh();
    elapsedTimer = window.setInterval(refresh, 500);
  },
  { immediate: true },
);

onBeforeUnmount(stopElapsedTimer);

function isRecordingCell(mode: CaptureModeConfig): boolean {
  return props.recordingModeId === mode.id;
}

function cellDisabled(mode: CaptureModeConfig): boolean {
  if (!props.availability[mode.id].supported) return true;
  // While a capture is in flight only its own cell stays live (as the stop
  // control); arming/finalizing states briefly disable the whole grid.
  if (props.recordingModeId !== null) return !isRecordingCell(mode);
  return props.lifecycleState !== 'idle';
}

function cellTitle(mode: CaptureModeConfig): string {
  const availability = props.availability[mode.id];
  if (!availability.supported) return availability.reason ?? mode.title;
  if (isRecordingCell(mode)) return 'Stop recording and save';
  return mode.title;
}
</script>

<template>
  <div
    class="capture-control-grid"
    role="group"
    aria-label="Capture gameplay media"
  >
    <button
      v-for="mode in CAPTURE_CONFIG.modes"
      :key="mode.id"
      type="button"
      :class="{ recording: isRecordingCell(mode) }"
      :disabled="cellDisabled(mode)"
      :title="cellTitle(mode)"
      :aria-label="cellTitle(mode)"
      :aria-pressed="isRecordingCell(mode)"
      @click.stop="emit('trigger', mode.id)"
    >{{ isRecordingCell(mode) ? elapsedLabel : mode.label }}</button>
  </div>
</template>
