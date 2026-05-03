<script setup lang="ts">
// Bar control group — composite that pairs a `BarLabel` with the
// caller's button-group (or any other inline content). The most
// common shape is:
//
//   <BarControlGroup label="CENTER:">
//     <BarButtonGroup>
//       <BarButton :active="...">VALLEY</BarButton>
//       …
//     </BarButtonGroup>
//   </BarControlGroup>
//
// For control-groups that need a more elaborate label (icons,
// dynamic stats, etc.) skip the `label` prop and pass a
// `<BarLabel>` of your own through the default slot — the
// wrapper just provides the flex layout.
import BarLabel from './BarLabel.vue';

defineProps<{
  /** Optional uppercase label text rendered before the slot
   *  content. Omit to compose a custom label inside the slot. */
  label?: string;
}>();
</script>

<template>
  <div class="control-group">
    <BarLabel v-if="label">{{ label }}</BarLabel>
    <slot />
  </div>
</template>
