<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const divider = ref<HTMLElement | null>(null);
const hidden = ref(false);
let ro: ResizeObserver | null = null;

function check() {
  const el = divider.value;
  if (!el) return;
  const group = el.closest('.control-group') as HTMLElement | null;
  const container = el.closest('.bar-controls') as HTMLElement | null;
  if (!group || !container) {
    hidden.value = false;
    return;
  }
  const groupLeft = group.getBoundingClientRect().left;
  const containerLeft = container.getBoundingClientRect().left;
  hidden.value = groupLeft - containerLeft < 2;
}

onMounted(() => {
  const container = divider.value?.closest('.bar-controls');
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
  display: none;
}
</style>
