<script setup lang="ts">
import { BATTLE_CONFIG } from '../battleBarConfig';
import { SERVER_CONFIG } from '../serverBarConfig';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import {
  getUnitDisplayShortName,
  getBuildingDisplayShortName,
  getTowerDisplayShortName,
} from '../game/sim/blueprints/displayRosters';
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

const UNIT_GROUND_NORMAL_EMA_LABEL: Record<UnitGroundNormalEmaMode, string> = {
  snap: 'SNAP',
  fast: 'FAST',
  mid: 'MED',
  slow: 'SLOW',
};
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
        <BarLabel>PRESETS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="preset in model.presets"
            :key="preset.name"
            :active="model.activePresetName === preset.name"
            :title="`Apply preset: ${preset.name}`"
            @click="model.applyPreset(preset)"
          >{{ preset.name }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>UNITS:</BarLabel>
        <BarButton
          :active="model.allDemoUnitsActive"
          title="Toggle all unit blueprints on/off"
          @click="model.toggleAllDemoUnits"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            v-for="ut in model.demoUnitBlueprintIds"
            :key="ut"
            :active="model.currentAllowedUnitsSet.has(ut)"
            :title="`Toggle ${ut} units in demo battle`"
            @click="model.toggleDemoUnitBlueprintId(ut)"
          >{{ getUnitDisplayShortName(ut) }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>BUILDINGS:</BarLabel>
        <BarButton
          :active="model.allDemoBuildingsActive"
          title="Toggle all building blueprints on/off"
          @click="model.toggleAllDemoBuildings"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            v-for="bt in model.demoBuildingBlueprintIds"
            :key="bt"
            :active="model.currentAllowedBuildingsSet.has(bt)"
            :title="`Toggle ${bt} in demo battle`"
            @click="model.toggleDemoBuildingBlueprintId(bt)"
          >{{ getBuildingDisplayShortName(bt) }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>TOWERS:</BarLabel>
        <BarButton
          :active="model.allDemoTowersActive"
          title="Toggle all tower blueprints on/off"
          @click="model.toggleAllDemoTowers"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            v-for="tt in model.demoTowerBlueprintIds"
            :key="tt"
            :active="model.currentAllowedTowersSet.has(tt)"
            :title="`Toggle ${tt} in demo battle`"
            @click="model.toggleDemoTowerBlueprintId(tt)"
          >{{ getTowerDisplayShortName(tt) }}</BarButton>
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
            v-for="opt in BATTLE_CONFIG.centerMagnitude.options"
            :key="opt"
            :active="model.centerMagnitude === opt"
            :title="`Set the central ripple altitude to ${opt}`"
            @click="model.applyCenterMagnitude(opt)"
          >{{ opt.toLocaleString() }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>DIVIDERS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.dividersMagnitude.options"
            :key="opt"
            :active="model.dividersMagnitude === opt"
            :title="`Set the team-separator ridge altitude to ${opt}`"
            @click="model.applyDividersMagnitude(opt)"
          >{{ opt.toLocaleString() }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>PERIMETER:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.perimeterMagnitude.options"
            :key="opt"
            :active="model.perimeterMagnitude === opt"
            :title="`Set the map perimeter ring altitude to ${opt}`"
            @click="model.applyPerimeterMagnitude(opt)"
          >{{ opt.toLocaleString() }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>D-PLATEAU:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.terrainDTerrain.options"
            :key="opt"
            :active="model.terrainDTerrain === opt"
            :title="opt === 0
              ? 'NONE — disable plateau terracing'
              : `Vertical spacing between plateau levels: ${opt}`"
            @click="model.applyTerrainDTerrain(opt)"
          >{{ opt === 0 ? 'NONE' : opt.toLocaleString() }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>PLATEAU WALL:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.plateauWallSlopeDegrees.options"
            :key="opt"
            :active="model.plateauWallSlopeDegrees === opt"
            :title="`D-PLATEAU transition slope angle from horizontal: ${opt} degrees`"
            @click="model.applyPlateauWallSlopeDegrees(opt)"
          >{{ opt }} DEG</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>D-DEPOSIT:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.metalDepositStep.options"
            :key="opt"
            :active="model.metalDepositStep === opt"
            :title="`Vertical step between metal-extractor pad altitudes: ${opt}`"
            @click="model.applyMetalDepositStep(opt)"
          >{{ opt.toLocaleString() }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup v-if="!model.gameStarted">
        <BarDivider />
        <BarLabel>TERRAIN DETAIL:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.terrainDetail.options"
            :key="opt"
            :active="model.terrainDetail === opt"
            :title="opt === 0
              ? 'OFF — one triangle per land cell'
              : `Fine-triangle subdivisions per land cell: ${opt}`"
            @click="model.applyTerrainDetail(opt)"
          >{{ opt === 0 ? 'OFF' : opt.toLocaleString() }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>TEX SMOOTH:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.terrainTextureSmoothing.options"
            :key="opt"
            :active="model.terrainTextureSmoothing === opt"
            :title="opt === 0
              ? 'Texture mask smoothing off — use only local triangle slope'
              : opt === 1
                ? 'Texture mask smoothing radius: current/default'
                : `Texture mask smoothing radius level ${opt}`"
            @click="model.applyTerrainTextureSmoothing(opt)"
          >{{ opt }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>LIGHT SMOOTH:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.terrainLightSmoothing.options"
            :key="opt"
            :active="model.terrainLightSmoothing === opt"
            :title="opt === 0
              ? 'Lighting normal smoothing off — current sampled terrain normal'
              : `Lighting normal smoothing radius level ${opt}`"
            @click="model.applyTerrainLightSmoothing(opt)"
          >{{ opt }}</BarButton>
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
        <BarLabel>FORCE FIELDS:</BarLabel>
        <BarButton
          :active="model.currentForceFieldsVisible"
          title="Show or hide rendered force-field surfaces and impact flashes"
          @click="model.setForceFieldsVisible(!model.currentForceFieldsVisible)"
        >{{ model.currentForceFieldsVisible ? 'VISIBLE' : 'INVISIBLE' }}</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>TARGETING:</BarLabel>
        <BarButton
          :active="model.currentShieldsObstructSight"
          title="Shield-aware targeting rejects locks when a straight line-of-sight crosses an active force field"
          @click="model.setShieldsObstructSight(!model.currentShieldsObstructSight)"
        >{{ model.currentShieldsObstructSight ? 'SHIELD-AWARE' : 'NAIVE' }}</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>CONVERTER TAX:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in BATTLE_CONFIG.converterTax.options"
            :key="opt"
            :active="Math.abs(model.currentConverterTax - opt) < 1e-6"
            :title="`Tax applied to resource converters: ${opt.toFixed(1)}`"
            @click="model.setConverterTax(opt)"
          >{{ opt.toFixed(1) }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Simulation EMA for units touching ground. SNAP uses the raw terrain triangle normal; FAST/MED/SLOW blend the unit's stored ground normal toward the new contact normal before chassis tilt takes the new slope angle.">UNITS TOUCHING GROUND NORMAL EMA:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="mode in SERVER_CONFIG.unitGroundNormalEma.options"
            :key="mode"
            :active="model.serverUnitGroundNormalEmaMode === mode"
            :title="`Set units-touching-ground normal EMA to ${UNIT_GROUND_NORMAL_EMA_LABEL[mode]}.`"
            @click="model.setUnitGroundNormalEmaModeValue(mode)"
          >{{ UNIT_GROUND_NORMAL_EMA_LABEL[mode] }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarButton
          :active="model.currentFogOfWarEnabled"
          title="Enable authoritative player vision, radar coverage, and fog-of-war filtering"
          @click="model.setFogOfWarEnabled(!model.currentFogOfWarEnabled)"
        >FOG OF WAR</BarButton>
        <BarDivider />
        <BarButton
          :active="model.currentSlopePathMode === 'symmetric'"
          title="Ground pathfinding slope policy (demo battle). DIRECTIONAL: units may descend/fall any slope, only uphill is gated by climb ability. SYMMETRIC: a face too steep to climb blocks travel both up and down."
          @click="model.setSlopePathMode(model.currentSlopePathMode === 'symmetric' ? 'directional' : 'symmetric')"
        >SLOPE PATH: {{ model.currentSlopePathMode === 'symmetric' ? 'SYMMETRIC' : 'DIRECTIONAL' }}</BarButton>
        <BarDivider />
      </BarControlGroup>
    </div>
  </div>
</template>
