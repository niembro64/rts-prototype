<script setup lang="ts">
import type { LoadingUnitInfoSection } from './loadingUnitInfo';

defineProps<{
  sections: LoadingUnitInfoSection[];
}>();
</script>

<template>
  <div class="loader-info-sections">
    <section
      v-for="section in sections"
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
            <span class="loader-info-value">{{ item.value ?? '' }}</span>
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
                <span class="loader-info-value">{{ child.value ?? '' }}</span>
              </div>
              <div v-if="child.detail" class="loader-info-detail">{{ child.detail }}</div>
              <div v-if="child.children?.length" class="loader-info-children nested">
                <div
                  v-for="grandchild in child.children"
                  :key="`${section.id}-${item.label}-${child.label}-${grandchild.label}`"
                  class="loader-info-row grandchild"
                >
                  <span class="loader-info-label">{{ grandchild.label }}</span>
                  <span class="loader-info-value">{{ grandchild.value ?? '' }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.loader-info-sections {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(110, 242, 207, 0.42) rgba(255, 255, 255, 0.06);
}

.loader-info-section + .loader-info-section {
  padding-top: 12px;
  border-top: 1px solid rgba(237, 243, 255, 0.12);
}

.loader-info-section h2 {
  margin: 0 0 8px;
  font-family: monospace;
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  text-transform: uppercase;
  color: rgba(110, 242, 207, 0.86);
  text-align: center;
}

.loader-info-list {
  display: grid;
  gap: 6px;
}

.loader-info-item {
  min-width: 0;
}

/* Two-column "spine": the key (label) is right-aligned hard against the
 * center gutter and the value is left-aligned right after it, so the eye
 * can run straight down the middle to match each key to its value. */
.loader-info-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: baseline;
  column-gap: 12px;
  min-width: 0;
  font-family: monospace;
  font-size: 11px;
  line-height: 1.24;
}

.loader-info-label {
  min-width: 0;
  overflow-wrap: anywhere;
  color: rgba(237, 243, 255, 0.58);
  text-align: right;
}

.loader-info-value {
  min-width: 0;
  overflow-wrap: anywhere;
  color: rgba(237, 243, 255, 0.9);
  text-align: left;
}

.loader-info-detail {
  margin-top: 2px;
  font-family: monospace;
  font-size: 10px;
  line-height: 1.25;
  color: rgba(237, 243, 255, 0.52);
  text-align: center;
}

.loader-info-children {
  display: grid;
  gap: 4px;
  margin-top: 5px;
  padding: 0 9px;
  border-left: 1px solid rgba(74, 158, 255, 0.28);
}

.loader-info-children.nested {
  gap: 3px;
  margin-top: 4px;
  border-left-color: rgba(110, 242, 207, 0.22);
}

.loader-info-item.child .loader-info-row,
.loader-info-row.grandchild {
  font-size: 10px;
}
</style>
