<script setup lang="ts">
// Bar buttons — THE one button group of the bar-control family.
// A wrapping run of separate square `<BarButton>`s: every button
// keeps its text width and the run wraps when the row is exhausted.
// Every button in the bars sits inside one of these — even a run of
// one — so all bar buttons share identical container context. The
// old connected-pill button group (fused borders, rounded end caps)
// is gone; buttons are always individual squares.
</script>

<template>
  <div class="bar-buttons">
    <slot />
  </div>
</template>
