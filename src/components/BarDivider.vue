<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const divider = ref<HTMLElement | null>(null);
const hidden = ref(false);
let ro: ResizeObserver | null = null;

function check() {
  const el = divider.value;
  if (!el) return;

  const group = el.closest('.control-group') as HTMLElement | null;
  const flexItem = group ?? el;
  const prev = flexItem.previousElementSibling as HTMLElement | null;

  if (prev) {
    const prevRect = prev.getBoundingClientRect();
    const flexRect = flexItem.getBoundingClientRect();
    hidden.value = flexRect.top > prevRect.top + prevRect.height * 0.5;
  } else {
    hidden.value = true;
  }
}

onMounted(() => {
  const container = divider.value?.closest('.bar-controls') ?? divider.value?.closest('.control-bar');
  if (container) {
    ro = new ResizeObserver(check);
    ro.observe(container);
  }
  check();
});

onUnmounted(() => {
  ro?.disconnect();
});
</script>

<template>
  <div ref="divider" class="bar-divider" :class="{ hidden }"></div>
</template>

<style scoped>
.bar-divider {
  width: 2px;
  align-self: stretch;
  background: rgba(66,66,66,.3);
  margin-left: 3px;
  margin-right: 3px;
}

.bar-divider.hidden {
  visibility: hidden;
  width: 0;
  margin: 0;
}
</style>
