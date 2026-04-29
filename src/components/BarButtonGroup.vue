<script setup lang="ts">
// Bar button group — wraps a row of `<BarButton>`s as a connected
// pill (first/last child get the rounded ends, middle children
// share borders). Styled by the global `.button-group` rule.
</script>

<template>
  <div class="button-group">
    <slot />
  </div>
</template>
