<script setup lang="ts">
// Bar button — single tappable cell in a control-group's
// button-group. Styled by the global `.control-btn` rule (see
// `src/styles/barControls.css`). The `:disabled.active` rule there
// drops the saturated active-color background to a muted outline,
// so non-host clients viewing read-only lobby controls see WHICH
// option the host has selected without it looking interactive.

defineProps<{
  /** ACTIVE state — bg + border fully colored, white text.
   *  The "this is THE selected option" highlight (single-pick
   *  groups, solo LOD signals). Mutually exclusive with
   *  `activeLevel` in normal use; if both are passed, `active`
   *  wins because its CSS rules have higher specificity. */
  active?: boolean;
  /** ACTIVE-LEVEL state — text-only white highlight, bg + border
   *  match the muted OFF state. Used for the middle tier of
   *  tri-state controls (e.g. LOD signals in ACTIVE-but-not-SOLO
   *  mode) where the indicator should read as "engaged" without
   *  competing visually with the SOLO highlight. */
  activeLevel?: boolean;
  /** Disabled state — non-clickable + visually muted. */
  disabled?: boolean;
  /** Native HTML title for hover tooltips. */
  title?: string;
}>();

defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <button
    type="button"
    class="control-btn"
    :class="{ active, 'active-level': activeLevel }"
    :disabled="disabled"
    :title="title"
    @click="$emit('click')"
  >
    <slot />
  </button>
</template>
