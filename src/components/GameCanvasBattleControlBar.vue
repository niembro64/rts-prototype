<script setup lang="ts">
import { BATTLE_CONFIG } from '../battleBarConfig';
import { getUnitDisplayShortName } from '../game/sim/blueprints/displayRosters';
import BarButton from './BarButton.vue';
import BarButtonGroup from './BarButtonGroup.vue';
import BarControlGroup from './BarControlGroup.vue';
import BarDivider from './BarDivider.vue';
import BarLabel from './BarLabel.vue';
import type { GameCanvasBattleControlBarModel } from './gameCanvasControlBarModels';
import { statBarStyle } from './uiUtils';

defineProps<{
  model: GameCanvasBattleControlBarModel;
}>();
</script>

<template>
  <div
    class="control-bar"
    :class="{ 'bar-readonly': model.isReadonly }"
    :style="model.barStyle"
  >
    <div class="bar-info">
      <BarButton
        :active="true"
        class="bar-label"
        title="Click to reset battle settings to defaults"
        @click="model.resetDemoDefaults"
      >
        <span class="bar-label-text">{{ model.battleLabel }}</span
        ><span class="bar-label-hover">DEFAULTS</span>
      </BarButton>
    </div>
    <div class="bar-controls">
      <BarControlGroup>
        <BarDivider />
        <span class="time-display" title="Battle elapsed time">{{
          model.battleElapsed
        }}</span>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>UNITS:</BarLabel>
        <BarButton
          :active="model.allDemoUnitsActive"
          title="Toggle all unit types on/off"
          @click="model.toggleAllDemoUnits"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            v-for="ut in model.demoUnitTypes"
            :key="ut"
            :active="model.currentAllowedUnitsSet.has(ut)"
            :title="`Toggle ${ut} units in demo battle`"
            @click="model.toggleDemoUnitType(ut)"
          >{{ getUnitDisplayShortName(ut) }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>CAP:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.cap.options"
            :key="opt"
            :active="model.displayUnitCap === opt"
            :title="`Max ${opt} total units`"
            @click="model.changeMaxTotalUnits(opt)"
          >{{ opt.toLocaleString() }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>WIDTH:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.mapSize.width.options"
            :key="opt.label"
            :active="model.mapWidthLandCells === opt.valueLandCells"
            :title="`Set map width to ${opt.label} land cells`"
            @click="model.applyMapLandDimensions({ widthLandCells: opt.valueLandCells, lengthLandCells: model.mapLengthLandCells })"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>LENGTH:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.mapSize.length.options"
            :key="opt.label"
            :active="model.mapLengthLandCells === opt.valueLandCells"
            :title="`Set map length to ${opt.label} land cells`"
            @click="model.applyMapLandDimensions({ widthLandCells: model.mapWidthLandCells, lengthLandCells: opt.valueLandCells })"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>CENTER:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.center.options"
            :key="opt.value"
            :active="model.terrainCenter === opt.value"
            :title="`Set the central ripple to ${opt.label.toLowerCase()}`"
            @click="model.applyTerrainShape('center', opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>DIVIDERS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.dividers.options"
            :key="opt.value"
            :active="model.terrainDividers === opt.value"
            :title="`Set the team-separator ridges to ${opt.label.toLowerCase()}`"
            @click="model.applyTerrainShape('dividers', opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>PERIMETER:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.mapShape.options"
            :key="opt.value"
            :active="model.terrainMapShape === opt.value"
            :title="`Set the map perimeter to ${opt.label.toLowerCase()}`"
            @click="model.applyTerrainMapShape(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Total units alive / unit cap">UNITS:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ model.displayUnitCount }}</span>
              <span class="fps-label">/ {{ model.displayUnitCap }}</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="statBarStyle(model.displayUnitCount, model.displayUnitCap)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>REFLECTIONS:</BarLabel>
        <BarButton
          :active="model.currentMirrorsEnabled"
          title="Enable mirror turrets and laser/beam reflections"
          @click="model.setMirrorsEnabled(!model.currentMirrorsEnabled)"
        >MIRROR</BarButton>
        <BarButton
          :active="model.currentForceFieldsEnabled"
          title="Enable force-field turrets, force-field simulation, and force-field rendering"
          @click="model.setForceFieldsEnabled(!model.currentForceFieldsEnabled)"
        >FIELD</BarButton>
        <BarButton
          :active="model.currentForceFieldsBlockTargeting"
          title="Force fields block turret lock-on through their boundary (applies to every turret, both directions)"
          @click="model.setForceFieldsBlockTargeting(!model.currentForceFieldsBlockTargeting)"
        >BLOCK LOS</BarButton>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.forceFieldReflectionMode.options"
            :key="opt.value"
            :active="model.currentForceFieldReflectionMode === opt.value"
            :title="`Force fields reflect ${opt.label === 'IN' ? 'outside-to-inside crossings' : opt.label === 'OUT' ? 'inside-to-outside crossings' : 'crossings in both directions'}`"
            @click="model.setForceFieldReflectionMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>FOG:</BarLabel>
        <BarButton
          :active="model.currentFogOfWarEnabled"
          title="Enable player vision, radar coverage, and fog-of-war rendering"
          @click="model.setFogOfWarEnabled(!model.currentFogOfWarEnabled)"
        >FOG</BarButton>
        <BarDivider />
      </BarControlGroup>
    </div>
  </div>
</template>
