<script setup lang="ts">
// Bar label — the small uppercase gray text that prefixes a
// button-group ("CENTER:", "DIVIDERS:", "TPS:", etc.). Styling
// lives in `src/styles/barControls.css` so this component and the
// bottom bars' bare-HTML usage stay in lockstep.
</script>

<template>
  <span class="control-label"><slot /></span>
</template>
