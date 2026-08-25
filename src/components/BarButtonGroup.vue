<script setup lang="ts">
// Bar button group — wraps `<BarButton>`s as a connected, wrapping sequence.
// Buttons retain their text width; when the available row is exhausted the
// sequence wraps instead of squeezing labels into unreadable cells.
</script>

<template>
  <div class="bar-button-group">
    <slot />
  </div>
</template>
