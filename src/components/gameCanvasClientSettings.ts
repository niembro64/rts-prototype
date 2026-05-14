import { computed, reactive, ref } from 'vue';
import {
  CLIENT_CONFIG,
  LOD_SIGNALS_ENABLED,
  RANGE_TYPES,
  PROJ_RANGE_TYPES,
  UNIT_RADIUS_TYPES,
  SOUND_CATEGORIES,
  cycleLodSignalState,
  getAudioScope,
  getAudioSmoothing,
  getBaseLodMode,
  getBeamSnapToTurret,
  getBuildGridDebug,
  getCameraFovDegrees,
  getCameraSmoothMode,
  getClientTiltEmaMode,
  getDragPanEnabled,
  getDriftMode,
  getPredictionMode,
  getEdgeScrollEnabled,
  getGraphicsQuality,
  getBurnMarks,
  getGridOverlay,
  getLegsRadiusToggle,
  getLocomotionMarks,
  getLodGridBorders,
  getLodShellRings,
  getLodSignalStates,
  getProjRangeToggle,
  getRangeToggle,
  getRenderMode,
  getSoundToggle,
  getTriangleDebug,
  getUnitRadiusToggle,
  getWaypointDetail,
  resetLodSignalStates,
  setAudioScope,
  setAudioSmoothing,
  setBaseLodMode,
  setBeamSnapToTurret,
  setBuildGridDebug,
  setCameraFovDegrees,
  setCameraSmoothMode,
  setClientTiltEmaMode,
  setDragPanEnabled,
  setDriftMode,
  setPredictionMode,
  setEdgeScrollEnabled,
  setGraphicsQuality,
  setBurnMarks,
  setGridOverlay,
  setLegsRadiusToggle,
  setLocomotionMarks,
  setLodGridBorders,
  setLodShellRings,
  setProjRangeToggle,
  setRangeToggle,
  setRenderMode,
  setSoundToggle,
  setTriangleDebug,
  setUnitRadiusToggle,
  setWaypointDetail,
  type CameraSmoothMode,
} from '../clientBarConfig';
import { audioManager } from '../game/audio/AudioManager';
import { musicPlayer } from '../game/audio/MusicPlayer';
import type {
  AudioScope,
  CameraFovDegrees,
  DriftMode,
  PredictionMode,
  GridOverlay,
  ProjRangeType,
  RangeType,
  SoundCategory,
  UnitRadiusType,
  WaypointDetail,
} from '../types/client';
import type { GraphicsQuality, RenderMode } from '../types/graphics';

type UseGameCanvasClientSettingsOptions = {
  applyCameraFovDegrees: (fov: CameraFovDegrees) => void;
  /** Push the current PREDICT mode to the active GameConnection so
   *  the server can gate snapshot bandwidth per-recipient. Optional
   *  no-op for tests / standalone callers. */
  applyPredictionMode?: (mode: PredictionMode) => void;
};

export function useGameCanvasClientSettings({
  applyCameraFovDegrees,
  applyPredictionMode,
}: UseGameCanvasClientSettingsOptions) {
  const graphicsQuality = ref<GraphicsQuality>(getGraphicsQuality());
  const clientSignalStates = ref({ ...getLodSignalStates() });
  const clientAnySolo = computed(() =>
    (LOD_SIGNALS_ENABLED.zoom && clientSignalStates.value.zoom === 'solo') ||
    (LOD_SIGNALS_ENABLED.serverTps && clientSignalStates.value.serverTps === 'solo') ||
    (LOD_SIGNALS_ENABLED.renderTps && clientSignalStates.value.renderTps === 'solo') ||
    (LOD_SIGNALS_ENABLED.units && clientSignalStates.value.units === 'solo'),
  );
  const renderMode = ref<RenderMode>(getRenderMode());
  const audioScope = ref<AudioScope>(getAudioScope());
  const audioSmoothing = ref<boolean>(getAudioSmoothing());
  const burnMarks = ref<boolean>(getBurnMarks());
  const locomotionMarks = ref<boolean>(getLocomotionMarks());
  const beamSnapToTurret = ref<boolean>(getBeamSnapToTurret());
  const lodShellRings = ref<boolean>(getLodShellRings());
  const lodGridBorders = ref<boolean>(getLodGridBorders());
  const triangleDebug = ref<boolean>(getTriangleDebug());
  const buildGridDebug = ref<boolean>(getBuildGridDebug());
  const baseLodMode = ref<boolean>(getBaseLodMode());
  const driftMode = ref<DriftMode>(getDriftMode());
  const predictionMode = ref<PredictionMode>(getPredictionMode());
  const clientTiltEmaMode = ref<DriftMode>(getClientTiltEmaMode());
  const edgeScrollEnabled = ref(getEdgeScrollEnabled());
  const dragPanEnabled = ref(getDragPanEnabled());
  const gridOverlay = ref<GridOverlay>(getGridOverlay());
  const waypointDetail = ref<WaypointDetail>(getWaypointDetail());
  const soundToggles = reactive<Record<SoundCategory, boolean>>({
    fire: getSoundToggle('fire'),
    hit: getSoundToggle('hit'),
    dead: getSoundToggle('dead'),
    beam: getSoundToggle('beam'),
    field: getSoundToggle('field'),
    music: getSoundToggle('music'),
  });
  audioManager.setMuted(audioScope.value === 'off');
  // OTHER-1: push the persisted per-category state into AudioManager
  // so the SOUNDS: buttons gate actual playback. Music goes through
  // musicPlayer below; AudioManager ignores it.
  for (const cat of SOUND_CATEGORIES) {
    audioManager.setCategoryEnabled(cat, soundToggles[cat]);
  }
  if (!soundToggles.music) musicPlayer.stop();
  const rangeToggles = reactive<Record<RangeType, boolean>>({
    trackAcquire: getRangeToggle('trackAcquire'),
    trackRelease: getRangeToggle('trackRelease'),
    engageAcquire: getRangeToggle('engageAcquire'),
    engageRelease: getRangeToggle('engageRelease'),
    engageMinAcquire: getRangeToggle('engageMinAcquire'),
    engageMinRelease: getRangeToggle('engageMinRelease'),
    build: getRangeToggle('build'),
  });
  const projRangeToggles = reactive<Record<ProjRangeType, boolean>>({
    collision: getProjRangeToggle('collision'),
    explosion: getProjRangeToggle('explosion'),
  });
  const unitRadiusToggles = reactive<Record<UnitRadiusType, boolean>>({
    visual: getUnitRadiusToggle('visual'),
    shot: getUnitRadiusToggle('shot'),
    push: getUnitRadiusToggle('push'),
  });
  const legsRadiusToggle = ref(getLegsRadiusToggle());
  const cameraSmoothMode = ref<CameraSmoothMode>(getCameraSmoothMode());
  const cameraFovDegrees = ref<CameraFovDegrees>(getCameraFovDegrees());

  function changeGraphicsQuality(quality: GraphicsQuality): void {
    setGraphicsQuality(quality);
    graphicsQuality.value = quality;
  }

  function cycleClientSignal(signal: 'zoom' | 'serverTps' | 'renderTps' | 'units'): void {
    cycleLodSignalState(signal);
    clientSignalStates.value = { ...getLodSignalStates() };
  }

  function changeRenderMode(mode: RenderMode): void {
    setRenderMode(mode);
    renderMode.value = mode;
  }

  function changeAudioScope(scope: AudioScope): void {
    setAudioScope(scope);
    audioScope.value = scope;
    audioManager.setMuted(scope === 'off');
  }

  function toggleRange(type: RangeType): void {
    const newValue = !rangeToggles[type];
    setRangeToggle(type, newValue);
    rangeToggles[type] = newValue;
  }

  function toggleProjRange(type: ProjRangeType): void {
    const newValue = !projRangeToggles[type];
    setProjRangeToggle(type, newValue);
    projRangeToggles[type] = newValue;
  }

  function toggleUnitRadius(type: UnitRadiusType): void {
    const newValue = !unitRadiusToggles[type];
    setUnitRadiusToggle(type, newValue);
    unitRadiusToggles[type] = newValue;
  }

  function toggleLegsRadius(): void {
    const newValue = !legsRadiusToggle.value;
    setLegsRadiusToggle(newValue);
    legsRadiusToggle.value = newValue;
  }

  function setCameraMode(mode: CameraSmoothMode): void {
    setCameraSmoothMode(mode);
    cameraSmoothMode.value = mode;
  }

  function changeCameraFovDegrees(fov: CameraFovDegrees): void {
    setCameraFovDegrees(fov);
    cameraFovDegrees.value = fov;
    applyCameraFovDegrees(fov);
  }

  const allRangesActive = computed(() =>
    RANGE_TYPES.every((rt) => rangeToggles[rt]),
  );
  const allProjRangesActive = computed(() =>
    PROJ_RANGE_TYPES.every((prt) => projRangeToggles[prt]),
  );
  const allUnitRadiiActive = computed(() =>
    UNIT_RADIUS_TYPES.every((urt) => unitRadiusToggles[urt]),
  );

  function toggleAllRanges(): void {
    const enable = !allRangesActive.value;
    for (const rt of RANGE_TYPES) {
      setRangeToggle(rt, enable);
      rangeToggles[rt] = enable;
    }
  }

  function toggleAllProjRanges(): void {
    const enable = !allProjRangesActive.value;
    for (const prt of PROJ_RANGE_TYPES) {
      setProjRangeToggle(prt, enable);
      projRangeToggles[prt] = enable;
    }
  }

  function toggleAllUnitRadii(): void {
    const enable = !allUnitRadiiActive.value;
    for (const urt of UNIT_RADIUS_TYPES) {
      setUnitRadiusToggle(urt, enable);
      unitRadiusToggles[urt] = enable;
    }
  }

  function toggleAudioSmoothing(): void {
    const newValue = !audioSmoothing.value;
    setAudioSmoothing(newValue);
    audioSmoothing.value = newValue;
  }

  function toggleBurnMarks(): void {
    const newValue = !burnMarks.value;
    setBurnMarks(newValue);
    burnMarks.value = newValue;
  }

  function toggleLocomotionMarks(): void {
    const newValue = !locomotionMarks.value;
    setLocomotionMarks(newValue);
    locomotionMarks.value = newValue;
  }

  function toggleBeamSnapToTurret(): void {
    const newValue = !beamSnapToTurret.value;
    setBeamSnapToTurret(newValue);
    beamSnapToTurret.value = newValue;
  }

  function toggleLodShellRings(): void {
    const newValue = !lodShellRings.value;
    setLodShellRings(newValue);
    lodShellRings.value = newValue;
  }

  function toggleLodGridBorders(): void {
    const newValue = !lodGridBorders.value;
    setLodGridBorders(newValue);
    lodGridBorders.value = newValue;
  }

  function toggleTriangleDebug(): void {
    const newValue = !triangleDebug.value;
    setTriangleDebug(newValue);
    triangleDebug.value = newValue;
  }

  function toggleBuildGridDebug(): void {
    const newValue = !buildGridDebug.value;
    setBuildGridDebug(newValue);
    buildGridDebug.value = newValue;
  }

  function toggleBaseLodMode(): void {
    const newValue = !baseLodMode.value;
    setBaseLodMode(newValue);
    baseLodMode.value = newValue;
  }

  function changeDriftMode(mode: DriftMode): void {
    setDriftMode(mode);
    driftMode.value = mode;
  }

  function changePredictionMode(mode: PredictionMode): void {
    setPredictionMode(mode);
    predictionMode.value = mode;
    applyPredictionMode?.(mode);
  }

  function changeClientTiltEmaMode(mode: DriftMode): void {
    setClientTiltEmaMode(mode);
    clientTiltEmaMode.value = mode;
  }

  function changeGridOverlay(mode: GridOverlay): void {
    setGridOverlay(mode);
    gridOverlay.value = mode;
  }

  function changeWaypointDetail(mode: WaypointDetail): void {
    setWaypointDetail(mode);
    waypointDetail.value = mode;
  }

  function toggleEdgeScroll(): void {
    const newValue = !edgeScrollEnabled.value;
    setEdgeScrollEnabled(newValue);
    edgeScrollEnabled.value = newValue;
  }

  function toggleDragPan(): void {
    const newValue = !dragPanEnabled.value;
    setDragPanEnabled(newValue);
    dragPanEnabled.value = newValue;
  }

  const allPanActive = computed(
    () => edgeScrollEnabled.value && dragPanEnabled.value,
  );

  function toggleAllPan(): void {
    const enable = !allPanActive.value;
    if (edgeScrollEnabled.value !== enable) toggleEdgeScroll();
    if (dragPanEnabled.value !== enable) toggleDragPan();
  }

  const SFX_CATEGORIES = SOUND_CATEGORIES.filter((c) => c !== 'music');

  const allSoundsActive = computed(() =>
    SFX_CATEGORIES.every((cat) => soundToggles[cat]),
  );

  function toggleAllSounds(): void {
    const enable = !allSoundsActive.value;
    for (const cat of SFX_CATEGORIES) {
      if (soundToggles[cat] !== enable) toggleSoundCategory(cat);
    }
  }

  function toggleSoundCategory(category: SoundCategory): void {
    const newValue = !soundToggles[category];
    setSoundToggle(category, newValue);
    soundToggles[category] = newValue;
    // OTHER-1: route the change through AudioManager so all play
    // methods gate on the new state (and any continuous sounds in
    // beam / field stop immediately when the user clicks OFF). Music
    // bypasses AudioManager — musicPlayer.start / stop drives it.
    audioManager.setCategoryEnabled(category, newValue);
    if (category === 'music') {
      if (newValue) musicPlayer.start();
      else musicPlayer.stop();
    }
  }

  function resetClientDefaults(): void {
    const cd = CLIENT_CONFIG;
    changeGraphicsQuality(cd.graphics.default);
    changeRenderMode(cd.render.default);
    changeAudioScope(cd.audio.default);
    setAudioSmoothing(cd.audioSmoothing.default);
    audioSmoothing.value = cd.audioSmoothing.default;
    setBurnMarks(cd.burnMarks.default);
    burnMarks.value = cd.burnMarks.default;
    setLocomotionMarks(cd.locomotionMarks.default);
    locomotionMarks.value = cd.locomotionMarks.default;
    setBeamSnapToTurret(cd.beamSnapToTurret.default);
    beamSnapToTurret.value = cd.beamSnapToTurret.default;
    setLodShellRings(cd.lodShellRings.default);
    lodShellRings.value = cd.lodShellRings.default;
    setLodGridBorders(cd.lodGridBorders.default);
    lodGridBorders.value = cd.lodGridBorders.default;
    setTriangleDebug(cd.triangleDebug.default);
    triangleDebug.value = cd.triangleDebug.default;
    setBuildGridDebug(cd.buildGridDebug.default);
    buildGridDebug.value = cd.buildGridDebug.default;
    setBaseLodMode(cd.baseLodMode.default);
    baseLodMode.value = cd.baseLodMode.default;
    setDriftMode(cd.driftMode.default);
    driftMode.value = cd.driftMode.default;
    setPredictionMode(cd.predictionMode.default);
    predictionMode.value = cd.predictionMode.default;
    applyPredictionMode?.(cd.predictionMode.default);
    setClientTiltEmaMode(cd.tiltEma.default);
    clientTiltEmaMode.value = cd.tiltEma.default;
    if (edgeScrollEnabled.value !== cd.edgeScroll.default) toggleEdgeScroll();
    if (dragPanEnabled.value !== cd.dragPan.default) toggleDragPan();
    for (const rt of RANGE_TYPES) {
      if (rangeToggles[rt] !== cd.rangeToggles.default) toggleRange(rt);
    }
    for (const prt of PROJ_RANGE_TYPES) {
      if (projRangeToggles[prt] !== cd.projRangeToggles.default) {
        toggleProjRange(prt);
      }
    }
    for (const urt of UNIT_RADIUS_TYPES) {
      if (unitRadiusToggles[urt] !== cd.unitRadiusToggles.default) {
        toggleUnitRadius(urt);
      }
    }
    for (const cat of SOUND_CATEGORIES) {
      if (soundToggles[cat] !== cd.sounds.default[cat]) {
        toggleSoundCategory(cat);
      }
    }
    gridOverlay.value = cd.gridOverlay.default;
    setGridOverlay(cd.gridOverlay.default);
    waypointDetail.value = cd.waypointDetail.default;
    setWaypointDetail(cd.waypointDetail.default);
    if (legsRadiusToggle.value !== cd.legsRadius.default) toggleLegsRadius();
    setCameraMode(cd.cameraSmooth.default);
    changeCameraFovDegrees(cd.cameraFov.default);
    resetLodSignalStates();
    clientSignalStates.value = { ...getLodSignalStates() };
  }

  const SOUND_LABELS: Record<SoundCategory, string> = {
    fire: 'FIRE',
    hit: 'HIT',
    dead: 'DEAD',
    beam: 'BEAM',
    field: 'FIELD',
    music: 'MUSIC',
  };

  const SOUND_TOOLTIPS: Record<SoundCategory, string> = {
    fire: 'Weapon fire sounds',
    hit: 'Projectile hit sounds',
    dead: 'Unit death sounds',
    beam: 'Continuous beam sounds',
    field: 'Continuous force field sounds',
    music: 'Background music (procedural or MIDI)',
  };

  return {
    graphicsQuality,
    clientSignalStates,
    clientAnySolo,
    renderMode,
    audioScope,
    audioSmoothing,
    burnMarks,
    locomotionMarks,
    beamSnapToTurret,
    lodShellRings,
    lodGridBorders,
    triangleDebug,
    buildGridDebug,
    baseLodMode,
    driftMode,
    predictionMode,
    clientTiltEmaMode,
    edgeScrollEnabled,
    dragPanEnabled,
    gridOverlay,
    waypointDetail,
    soundToggles,
    rangeToggles,
    projRangeToggles,
    unitRadiusToggles,
    legsRadiusToggle,
    cameraSmoothMode,
    cameraFovDegrees,
    allRangesActive,
    allProjRangesActive,
    allUnitRadiiActive,
    allPanActive,
    SFX_CATEGORIES,
    allSoundsActive,
    SOUND_LABELS,
    SOUND_TOOLTIPS,
    resetClientDefaults,
    changeGraphicsQuality,
    cycleClientSignal,
    changeRenderMode,
    changeAudioScope,
    toggleRange,
    toggleProjRange,
    toggleUnitRadius,
    toggleLegsRadius,
    setCameraMode,
    changeCameraFovDegrees,
    toggleAllRanges,
    toggleAllProjRanges,
    toggleAllUnitRadii,
    toggleAudioSmoothing,
    toggleBurnMarks,
    toggleLocomotionMarks,
    toggleBeamSnapToTurret,
    toggleLodShellRings,
    toggleLodGridBorders,
    toggleTriangleDebug,
    toggleBuildGridDebug,
    toggleBaseLodMode,
    changeDriftMode,
    changePredictionMode,
    changeClientTiltEmaMode,
    changeGridOverlay,
    changeWaypointDetail,
    toggleEdgeScroll,
    toggleDragPan,
    toggleAllPan,
    toggleAllSounds,
    toggleSoundCategory,
  };
}
