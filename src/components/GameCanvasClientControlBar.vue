<script setup lang="ts">
import { CLIENT_CONFIG, LOD_SIGNALS_ENABLED } from '../clientBarConfig';
import { GOOD_TPS } from '../lodConfig';
import BarButton from './BarButton.vue';
import BarButtonGroup from './BarButtonGroup.vue';
import BarControlGroup from './BarControlGroup.vue';
import BarDivider from './BarDivider.vue';
import BarLabel from './BarLabel.vue';
import type { GameCanvasClientControlBarModel } from './gameCanvasControlBarModels';
import { fmt4, msBarStyle, statBarStyle } from './uiUtils';

defineProps<{
  model: GameCanvasClientControlBarModel;
}>();
</script>

<template>
  <div class="control-bar" :style="model.barStyle">
    <div class="bar-info">
      <BarButton
        :active="true"
        class="bar-label"
        title="Click to reset client settings to defaults"
        @click="model.resetClientDefaults"
      >
        <span class="bar-label-text">PLAYER CLIENT</span
        ><span class="bar-label-hover">DEFAULTS</span>
      </BarButton>
      <BarButton
        :active="model.playerClientEnabled"
        class="client-power-button"
        :title="model.playerClientEnabled ? 'Turn PLAYER CLIENT game rendering off' : 'Turn PLAYER CLIENT game rendering on'"
        @click="model.togglePlayerClientEnabled"
      >{{ model.playerClientEnabled ? 'ON' : 'OFF' }}</BarButton>
    </div>
    <div class="bar-controls">
      <BarControlGroup v-if="model.displayedClientTime">
        <BarDivider />
        <span
          class="time-display"
          title="Host-propagated client wall-clock time"
          >{{ model.displayedClientTime }}</span
        >
      </BarControlGroup>
      <BarControlGroup v-if="model.displayedClientIp">
        <BarDivider />
        <span
          class="ip-display"
          title="Host-propagated public IP address"
          >{{ model.displayedClientIp }}</span
        >
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>GRID:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.gridOverlay.options"
            :key="opt.value"
            :active="model.gridOverlay === opt.value"
            title="Territory capture overlay intensity"
            @click="model.changeGridOverlay(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>WAYPOINTS:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.waypointDetail.options"
            :key="opt.value"
            :active="model.waypointDetail === opt.value"
            title="Waypoint visualization - SIMPLE shows only your click points; DETAILED shows the planner's intermediates too"
            @click="model.changeWaypointDetail(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Client CPU - simulation prediction, input, HUD updates. Raw logicMs avg/hi in milliseconds per frame.">CPU:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.logicMsAvg) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.logicMsAvg)"></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.logicMsHi) }}</span>
              <span class="fps-label">hi</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.logicMsHi)"></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel :title="`Client GPU - source: ${model.gpuSourceLabel}. Raw renderMs avg/hi ${fmt4(model.renderMsAvg)} / ${fmt4(model.renderMsHi)} ms. Timer-query (when supported) shows the actual GPU-side execution time in milliseconds; otherwise shows renderer.render() wall-clock which is mostly CPU draw-call submission.`">GPU:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.displayGpuMs) }}</span>
              <span class="fps-label">
                {{ model.gpuTimerSupported ? 'hw' : 'cpu' }}
              </span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.displayGpuMs)"></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.renderMsHi) }}</span>
              <span class="fps-label">hi</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.renderMsHi)"></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Total frame time - CPU + GPU wall-clock per frame (ms)">FRAME:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.frameMsAvg) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.frameMsAvg)"></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.frameMsHi) }}</span>
              <span class="fps-label">hi</span>
            </div>
            <div class="stat-bar-track">
              <div class="stat-bar-fill" :style="msBarStyle(model.frameMsHi)"></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup v-if="model.longtaskSupported">
        <BarDivider />
        <BarLabel title="Long-task blocked time from PerformanceObserver - ms per second of wall-clock time lost to main-thread tasks >=50 ms. 0 = smooth; 200+ = heavy main-thread contention. Not available in Safari.">LONG:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.longtaskMsPerSec) }}</span>
              <span class="fps-label">ms/s</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="msBarStyle(model.longtaskMsPerSec, 200)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="PLAYER CLIENT update-loop ticks per second. This includes prediction/input/render prep cadence and is the client-side TPS signal for LOD.">R-TPS:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.renderTpsAvg) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="statBarStyle(model.renderTpsAvg, GOOD_TPS)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.renderTpsWorst) }}</span>
              <span class="fps-label">low</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="statBarStyle(model.renderTpsWorst, GOOD_TPS)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <div class="fps-stats">
          <BarLabel title="Camera altitude (world units, distance from the ground plane). Smaller = closer to surface. Wheel clamp rides on altitude too - at the floor / ceiling you're at the actual physical limit, no more 'stuck' states.">ZOOM:</BarLabel>
          <span class="fps-value">{{ fmt4(model.currentZoom) }}</span>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Snapshots received per second from server">SPS:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.snapAvgRate) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  statBarStyle(
                    model.snapAvgRate,
                    model.displaySnapshotRate === 'none'
                      ? 60
                      : model.displaySnapshotRate,
                  )
                "
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.snapWorstRate) }}</span>
              <span class="fps-label">low</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="
                  statBarStyle(
                    model.snapWorstRate,
                    model.displaySnapshotRate === 'none'
                      ? 60
                      : model.displaySnapshotRate,
                  )
                "
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Full keyframe snapshots received per second (state.isDelta === false). Driven by the host's keyframe ratio.">FSPS:</BarLabel>
        <div class="stat-bar-group">
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.fullSnapAvgRate) }}</span>
              <span class="fps-label">avg</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="statBarStyle(model.fullSnapAvgRate, model.fullSnapBarTarget)"
              ></div>
            </div>
          </div>
          <div class="stat-bar">
            <div class="stat-bar-top">
              <span class="fps-value">{{ fmt4(model.fullSnapWorstRate) }}</span>
              <span class="fps-label">low</span>
            </div>
            <div class="stat-bar-track">
              <div
                class="stat-bar-fill"
                :style="statBarStyle(model.fullSnapWorstRate, model.fullSnapBarTarget)"
              ></div>
            </div>
          </div>
        </div>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>EVENTS:</BarLabel>
        <BarButton
          :active="model.audioSmoothing"
          title="Smooth one-shot events and turret projectile spawns across snapshot intervals"
          @click="model.toggleAudioSmoothing"
        >SMOOTH</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>MARKS:</BarLabel>
        <BarButton
          :active="model.burnMarks"
          title="Draw beam, laser, and dgun scorch trails on the ground"
          @click="model.toggleBurnMarks"
        >BURN</BarButton>
        <BarButton
          :active="model.locomotionMarks"
          title="Draw wheel, tread, and footstep prints from unit movement"
          @click="model.toggleLocomotionMarks"
        >LOCO</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>BEAMS:</BarLabel>
        <BarButton
          :active="model.beamSnapToTurret"
          title="Snap beam origins to live rendered turret centers"
          @click="model.toggleBeamSnapToTurret"
        >TURRET</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Client prediction physics order: POS snaps to snapshot position only; VEL also integrates server-reported velocity each frame; ACC integrates the full F=ma chain (position from velocity AND velocity from acceleration).">PREDICT:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.predictionMode.options"
            :key="opt.value"
            :active="model.predictionMode === opt.value"
            :title="`Prediction physics: ${opt.label}.`"
            @click="model.changePredictionMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>DRIFT:</BarLabel>
        <BarButtonGroup>
          <BarButton
            :active="model.driftMode === 'snap'"
            title="Snap instantly to new server state"
            @click="model.changeDriftMode('snap')"
          >SNAP</BarButton>
          <BarButton
            :active="model.driftMode === 'fast'"
            title="Fast interpolation to server state"
            @click="model.changeDriftMode('fast')"
          >FAST</BarButton>
          <BarButton
            :active="model.driftMode === 'mid'"
            title="Medium interpolation to server state"
            @click="model.changeDriftMode('mid')"
          >MID</BarButton>
          <BarButton
            :active="model.driftMode === 'slow'"
            title="Slow interpolation to server state"
            @click="model.changeDriftMode('slow')"
          >SLOW</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Per-frame chassis-tilt EMA on the client. Layered on top of the HOST SERVER TILT EMA - sim smooths first, then this knob smooths further at render cadence.">TILT EMA:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.tiltEma.options"
            :key="opt.value"
            :active="model.clientTiltEmaMode === opt.value"
            :title="`Set client-side chassis-tilt EMA to ${opt.label}.`"
            @click="model.changeClientTiltEmaMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>PAN:</BarLabel>
        <BarButton
          :active="model.allPanActive"
          title="Toggle all camera pan methods on/off"
          @click="model.toggleAllPan"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            :active="model.dragPanEnabled"
            title="Middle-click drag to pan camera"
            @click="model.toggleDragPan"
          >DRAG</BarButton>
          <BarButton
            :active="model.edgeScrollEnabled"
            title="Edge scroll - move camera when mouse near viewport border"
            @click="model.toggleEdgeScroll"
          >EDGE</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>LOD:</BarLabel>
        <BarButton
          :active="model.graphicsQuality === 'auto' && !model.clientAnySolo"
          :active-level="model.graphicsQuality === 'auto' && model.clientAnySolo"
          title="Auto-adjust graphics quality from the lowest active client signal"
          @click="model.changeGraphicsQuality('auto')"
        >AUTO</BarButton>
        <BarButtonGroup>
          <BarButton
            v-if="LOD_SIGNALS_ENABLED.zoom"
            :active="model.graphicsQuality === 'auto' && model.clientSignalStates.zoom === 'solo'"
            :active-level="
              model.graphicsQuality === 'auto'
                && model.clientSignalStates.zoom === 'active'
                && !model.clientAnySolo
            "
            :title="`Zoom signal - click to cycle off / active / solo. Currently ${model.clientSignalStates.zoom}.`"
            @click="model.cycleClientSignal('zoom')"
          >ZOOM</BarButton>
          <BarButton
            v-if="LOD_SIGNALS_ENABLED.serverTps"
            :active="model.graphicsQuality === 'auto' && model.clientSignalStates.serverTps === 'solo'"
            :active-level="
              model.graphicsQuality === 'auto'
                && model.clientSignalStates.serverTps === 'active'
                && !model.clientAnySolo
                && model.showServerControls
            "
            :title="`Server TPS signal - click to cycle off / active / solo. Currently ${model.clientSignalStates.serverTps}.`"
            @click="model.cycleClientSignal('serverTps')"
          >S-TPS</BarButton>
          <BarButton
            v-if="LOD_SIGNALS_ENABLED.renderTps"
            :active="model.graphicsQuality === 'auto' && model.clientSignalStates.renderTps === 'solo'"
            :active-level="
              model.graphicsQuality === 'auto'
                && model.clientSignalStates.renderTps === 'active'
                && !model.clientAnySolo
            "
            :title="`Render TPS signal - click to cycle off / active / solo. Currently ${model.clientSignalStates.renderTps}.`"
            @click="model.cycleClientSignal('renderTps')"
          >R-TPS</BarButton>
          <BarButton
            v-if="LOD_SIGNALS_ENABLED.units"
            :active="model.graphicsQuality === 'auto' && model.clientSignalStates.units === 'solo'"
            :active-level="
              model.graphicsQuality === 'auto'
                && model.clientSignalStates.units === 'active'
                && !model.clientAnySolo
            "
            :title="`World fullness signal - click to cycle off / active / solo. Currently ${model.clientSignalStates.units}.`"
            @click="model.cycleClientSignal('units')"
          >UNITS</BarButton>
        </BarButtonGroup>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.graphics.options"
            :key="opt.value"
            :active="model.graphicsQuality === opt.value"
            :active-level="
              model.effectiveQuality === opt.value &&
              model.graphicsQuality !== opt.value
            "
            :title="`${opt.value} graphics quality`"
            @click="model.changeGraphicsQuality(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
        <BarButton
          :active="model.baseLodMode"
          title="BASE - when ON, the chosen MIN/LOW/MED/HI/MAX tier applies UNIFORMLY to every entity (camera-sphere distance resolution disabled). When OFF, tiers cap a per-entity object-tier resolved from camera distance, so close units render richer than far units."
          @click="model.toggleBaseLodMode"
        >BASE</BarButton>
        <BarButton
          :active="model.lodShellRings"
          title="Show object-LOD shell intersections on the terrain around the camera"
          @click="model.toggleLodShellRings"
        >RINGS</BarButton>
        <BarButton
          :active="model.lodGridBorders"
          title="Show object-LOD spatial grid tiles as 2D ground-plane outlines"
          @click="model.toggleLodGridBorders"
        >CELLS</BarButton>
        <BarButton
          :active="model.triangleDebug"
          title="TRIS - debug-color every terrain/mana mesh triangle so triangle reduction and flat-tile optimization are visually obvious"
          @click="model.toggleTriangleDebug"
        >TRIS</BarButton>
        <BarButton
          :active="model.buildGridDebug"
          title="BUILD - show every fine build-placement cell using the same green/red/blue colors as the building ghost"
          @click="model.toggleBuildGridDebug"
        >BUILD</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>RENDER:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.render.options"
            :key="opt.value"
            :active="model.renderMode === opt.value"
            :title="
              opt.value === 'window'
                ? 'Render only visible window'
                : opt.value === 'padded'
                  ? 'Render window plus padding'
                  : 'Render entire map'
            "
            @click="model.changeRenderMode(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>AUDIO:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.audio.options"
            :key="opt.value"
            :active="model.audioScope === opt.value"
            :title="
              opt.value === 'window'
                ? 'Play audio from visible area'
                : opt.value === 'padded'
                  ? 'Play audio from visible area plus padding'
                  : 'Play audio from entire map'
            "
            @click="model.changeAudioScope(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>SOUNDS:</BarLabel>
        <BarButton
          :active="model.allSoundsActive"
          title="Toggle all sound categories on/off"
          @click="model.toggleAllSounds"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            v-for="cat in model.sfxCategories"
            :key="cat"
            :active="model.soundToggles[cat]"
            :title="model.soundTooltips[cat]"
            @click="model.toggleSoundCategory(cat)"
          >{{ model.soundLabels[cat] }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>MUSIC:</BarLabel>
        <BarButton
          :active="model.soundToggles.music"
          :title="model.soundTooltips.music"
          @click="model.toggleSoundCategory('music')"
        >{{ model.soundToggles.music ? 'ON' : 'OFF' }}</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>TURR CIR:</BarLabel>
        <BarButton
          :active="model.allRangesActive"
          title="Toggle every 2D turret/build circle viz on/off"
          @click="model.toggleAllRanges"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            :active="model.rangeToggles.trackAcquire"
            title="Show tracking acquire circle (2D ground-plane start tracking target range)"
            @click="model.toggleRange('trackAcquire')"
          >T.A</BarButton>
          <BarButton
            :active="model.rangeToggles.trackRelease"
            title="Show tracking release circle (2D ground-plane lose target range)"
            @click="model.toggleRange('trackRelease')"
          >T.R</BarButton>
          <BarButton
            :active="model.rangeToggles.engageAcquire"
            title="Show engage acquire circle (2D ground-plane start firing range)"
            @click="model.toggleRange('engageAcquire')"
          >E.A</BarButton>
          <BarButton
            :active="model.rangeToggles.engageRelease"
            title="Show engage release circle (2D ground-plane stop firing range)"
            @click="model.toggleRange('engageRelease')"
          >E.R</BarButton>
          <BarButton
            :active="model.rangeToggles.engageMinAcquire"
            title="Show minimum engage acquire circle (2D inner dead-zone start firing boundary)"
            @click="model.toggleRange('engageMinAcquire')"
          >M.A</BarButton>
          <BarButton
            :active="model.rangeToggles.engageMinRelease"
            title="Show minimum engage release circle (2D inner dead-zone stop firing boundary)"
            @click="model.toggleRange('engageMinRelease')"
          >M.R</BarButton>
          <BarButton
            :active="model.rangeToggles.build"
            title="Show build circle (2D ground-plane builder range)"
            @click="model.toggleRange('build')"
          >BLD</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>SHOT SPH:</BarLabel>
        <BarButton
          :active="model.allProjRangesActive"
          title="Toggle every 3D projectile sphere viz on/off"
          @click="model.toggleAllProjRanges"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            :active="model.projRangeToggles.collision"
            title="Show projectile collision sphere (3D hit volume)"
            @click="model.toggleProjRange('collision')"
          >COL</BarButton>
          <BarButton
            :active="model.projRangeToggles.explosion"
            title="Show projectile explosion sphere (3D splash volume)"
            @click="model.toggleProjRange('explosion')"
          >EXP</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>UNIT SPH:</BarLabel>
        <BarButton
          :active="model.allUnitRadiiActive"
          title="Toggle every 3D unit sphere viz on/off"
          @click="model.toggleAllUnitRadii"
        >ALL</BarButton>
        <BarButtonGroup>
          <BarButton
            :active="model.unitRadiusToggles.visual"
            title="Show unit body sphere (unit.radius.body - visible chassis size)"
            @click="model.toggleUnitRadius('visual')"
          >BODY</BarButton>
          <BarButton
            :active="model.unitRadiusToggles.shot"
            title="Show unit shot sphere (radius.shot - projectile/beam hit detection)"
            @click="model.toggleUnitRadius('shot')"
          >SHOT</BarButton>
          <BarButton
            :active="model.unitRadiusToggles.push"
            title="Show unit push sphere (radius.push - unit-unit push physics, ground-click selection fallback)"
            @click="model.toggleUnitRadius('push')"
          >PUSH</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>LEGS:</BarLabel>
        <BarButton
          :active="model.legsRadiusToggle"
          title="Show each leg's rest circle (chassis-local - the foot wanders inside this radius before snapping to the opposite edge)"
          @click="model.toggleLegsRadius"
        >RAD</BarButton>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel title="Main 3D camera vertical field-of-view in degrees. Lower is narrower/telephoto; higher is wider-angle.">FOV:</BarLabel>
        <BarButtonGroup>
          <BarButton
            v-for="opt in CLIENT_CONFIG.cameraFov.options"
            :key="opt.value"
            :active="model.cameraFovDegrees === opt.value"
            :title="`Set camera field-of-view to ${opt.value} degrees`"
            @click="model.changeCameraFovDegrees(opt.value)"
          >{{ opt.label }}</BarButton>
        </BarButtonGroup>
      </BarControlGroup>
      <BarControlGroup>
        <BarDivider />
        <BarLabel>CAMERA:</BarLabel>
        <BarButtonGroup>
          <BarButton
            :active="model.cameraSmoothMode === 'snap'"
            title="Zoom and pan apply instantly - original behavior, no animation"
            @click="model.setCameraMode('snap')"
          >SNAP</BarButton>
          <BarButton
            :active="model.cameraSmoothMode === 'fast'"
            title="Zoom and pan ease with EMA tau around 50 ms - quick settle"
            @click="model.setCameraMode('fast')"
          >FAST</BarButton>
          <BarButton
            :active="model.cameraSmoothMode === 'mid'"
            title="Zoom and pan ease with EMA tau around 120 ms - default-feeling smoothness"
            @click="model.setCameraMode('mid')"
          >MID</BarButton>
          <BarButton
            :active="model.cameraSmoothMode === 'slow'"
            title="Zoom and pan ease with EMA tau around 400 ms - deliberate, weighty feel"
            @click="model.setCameraMode('slow')"
          >SLOW</BarButton>
        </BarButtonGroup>
        <BarDivider />
      </BarControlGroup>
    </div>
  </div>
</template>
