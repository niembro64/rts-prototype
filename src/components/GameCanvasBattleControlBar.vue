<script setup lang="ts">
import { BATTLE_CONFIG } from '../battleBarConfig';
import { SERVER_CONFIG } from '../serverBarConfig';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import {
  getUnitDisplayShortName,
  getBuildingDisplayShortName,
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
            :title="`Signed metal-extractor pad altitude step: ${opt} (negative lowers authored levels)`"
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
        <BarLabel
          :title="model.localPlayerShieldAwareTargeting
            ? 'SHIELD-AWARE: your Shield-Aware Targeting Tech building upgrades every one of your entities to reject locks whose line of sight crosses an active force field'
            : 'NAIVE: your turrets lock straight through force fields. Build a Shield-Aware Targeting Tech building to upgrade all of your entities.'"
        >TARGETING: {{ model.localPlayerShieldAwareTargeting ? 'SHIELD-AWARE' : 'NAIVE' }}</BarLabel>
        <BarDivider />
        <BarLabel
          :title="model.localPlayerShieldsPowered
            ? 'POWERED: at least one of your team\'s Shield Generators is built and switched ON, so every shield your team owns is raised'
            : 'OFFLINE: your team has no Shield Generator built and switched ON. Shielded units and buildings still build normally, they just stand unshielded until one comes online.'"
        >SHIELDS: {{ model.localPlayerShieldsPowered ? 'POWERED' : 'OFFLINE' }}</BarLabel>
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
        <BarLabel title="World materials. METAL treats the whole map as metal ore — the deposits still shape the land, but there are no separate deposit crowns and extractors pay out anywhere. LAVA replaces the sea with molten rock that burns anything touching it. Either one leaves the world barren: no trees, grass, or seaweed.">WORLD:</BarLabel>
        <BarButton
          :active="model.currentTerrainSurfaceMode === 'metal'"
          title="ON makes the entire map one polished ore body: same terrain shaping, no deposit crowns, every build cell pays metal. OFF is the authored world with discrete metal deposits."
          @click="model.setTerrainSurfaceMode(model.currentTerrainSurfaceMode === 'metal' ? 'normal' : 'metal')"
        >METAL</BarButton>
        <BarButton
          :active="model.currentLiquidSurfaceMode === 'lava'"
          title="ON fills the map below the water level with opaque molten rock that drains health very fast from anything touching its surface. OFF is the authored sea."
          @click="model.setLiquidSurfaceMode(model.currentLiquidSurfaceMode === 'lava' ? 'water' : 'lava')"
        >LAVA</BarButton>
        <BarDivider />
        <BarLabel title="All cells must fit the unit's medium-specific force envelope. This chooses whether the inter-cell climb gate applies uphill only or in both directions.">CLIMB GATE:</BarLabel>
        <BarButton
          :active="model.currentSlopePathMode === 'symmetric'"
          title="Terrain-edge climb policy. UPHILL ONLY preserves controlled descent between valid cells. BOTH DIRECTIONS requires the same climb authority uphill and downhill."
          @click="model.setSlopePathMode(model.currentSlopePathMode === 'symmetric' ? 'directional' : 'symmetric')"
        >{{ model.currentSlopePathMode === 'symmetric' ? 'BOTH DIRECTIONS' : 'UPHILL ONLY' }}</BarButton>
        <BarDivider />
        <BarButton
          :active="model.currentSlowDownAtFinalWaypoint"
          title="Toggle velocity-aware braking as units approach the final waypoint of their final order. Off keeps full thrust through the destination; corner-speed shaping is unchanged."
          @click="model.setSlowDownAtFinalWaypoint(!model.currentSlowDownAtFinalWaypoint)"
        >FINAL WAYPOINT SLOWDOWN</BarButton>
        <BarDivider />
      </BarControlGroup>
    </div>
  </div>
</template>
