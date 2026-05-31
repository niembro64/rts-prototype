import { computed, reactive, ref, watch, type Ref } from 'vue';
import {
  RANGE_TYPES,
  PROJ_RANGE_TYPES,
  UNIT_RADIUS_TYPES,
  SOUND_CATEGORIES,
  ENTITY_HUD_TYPES,
  ENTITY_HUD_ELEMENTS,
  getAudioScope,
  getAudioSmoothing,
  getBeamSnapToTurret,
  getBuildGridDebug,
  getCameraFovDegrees,
  getCameraSmoothMode,
  getClientConfig,
  getClientUnitGroundNormalEmaMode,
  getDragPanEnabled,
  getMovementPosEmaMode,
  getMovementVelEmaMode,
  getPredictionMode,
  getRotationPosEmaMode,
  getRotationVelEmaMode,
  getEdgeScrollEnabled,
  getBurnMarks,
  getLegsRadiusToggle,
  getLocomotionMarks,
  getRadarBoundary,
  getSmokeTrails,
  getSmokeSoftEdges,
  getSightBoundary,
  getProjRangeToggle,
  getRangeToggle,
  getRenderMode,
  getResourceBallDensity,
  getSoundToggle,
  getTriangleDebug,
  getUnitRadiusToggle,
  getWaypointDetail,
  getEntityHudToggle,
  getSelectionHudMode,
  setAudioScope,
  setAudioSmoothing,
  setBeamSnapToTurret,
  setBuildGridDebug,
  setCameraFovDegrees,
  setCameraSmoothMode,
  setClientMode,
  setClientUnitGroundNormalEmaMode,
  setDragPanEnabled,
  setMovementPosEmaMode,
  setMovementVelEmaMode,
  setPredictionMode,
  setRotationPosEmaMode,
  setRotationVelEmaMode,
  setEdgeScrollEnabled,
  setBurnMarks,
  setLegsRadiusToggle,
  setLocomotionMarks,
  setRadarBoundary,
  setSmokeTrails,
  setSmokeSoftEdges,
  setSightBoundary,
  setProjRangeToggle,
  setRangeToggle,
  setRenderMode,
  setResourceBallDensity,
  setSoundToggle,
  setTriangleDebug,
  setUnitRadiusToggle,
  setWaypointDetail,
  setEntityHudToggle,
  setSelectionHudMode,
  type CameraSmoothMode,
  type ClientMode,
} from '../clientBarConfig';
import { audioManager } from '../game/audio/AudioManager';
import { musicPlayer } from '../game/audio/MusicPlayer';
import { DEFAULT_BALLS_PER_RESOURCE_PER_SECOND } from '../resourceConfig';
import type {
  AudioScope,
  CameraFovDegrees,
  DriftChannelMode,
  DriftMode,
  EntityHudElement,
  EntityHudToggles,
  EntityHudType,
  PositionDriftChannelMode,
  PredictionMode,
  ProjRangeType,
  RangeType,
  SelectionHudMode,
  SoundCategory,
  UnitRadiusType,
  WaypointDetail,
} from '../types/client';
import type { RenderMode } from '../types/graphics';

type UseGameCanvasClientSettingsOptions = {
  currentClientMode: Readonly<Ref<ClientMode>>;
  applyCameraFovDegrees: (fov: CameraFovDegrees) => void;
};

export function useGameCanvasClientSettings({
  currentClientMode,
  applyCameraFovDegrees,
}: UseGameCanvasClientSettingsOptions) {
  setClientMode(currentClientMode.value);
  const renderMode = ref<RenderMode>(getRenderMode());
  const audioScope = ref<AudioScope>(getAudioScope());
  const audioSmoothing = ref<boolean>(getAudioSmoothing());
  const burnMarks = ref<boolean>(getBurnMarks());
  const locomotionMarks = ref<boolean>(getLocomotionMarks());
  const smokeTrails = ref<boolean>(getSmokeTrails());
  const smokeSoftEdges = ref<boolean>(getSmokeSoftEdges());
  const beamSnapToTurret = ref<boolean>(getBeamSnapToTurret());
  const resourceBallDensity = ref<number>(getResourceBallDensity());
  const triangleDebug = ref<boolean>(getTriangleDebug());
  const buildGridDebug = ref<boolean>(getBuildGridDebug());
  const sightBoundary = ref<boolean>(getSightBoundary());
  const radarBoundary = ref<boolean>(getRadarBoundary());
  const movementPosEma = ref<PositionDriftChannelMode>(getMovementPosEmaMode());
  const movementVelEma = ref<DriftChannelMode>(getMovementVelEmaMode());
  const rotationPosEma = ref<PositionDriftChannelMode>(getRotationPosEmaMode());
  const rotationVelEma = ref<DriftChannelMode>(getRotationVelEmaMode());
  const predictionMode = ref<PredictionMode>(getPredictionMode());
  const clientUnitGroundNormalEmaMode = ref<DriftMode>(getClientUnitGroundNormalEmaMode());
  const edgeScrollEnabled = ref(getEdgeScrollEnabled());
  const dragPanEnabled = ref(getDragPanEnabled());
  const waypointDetail = ref<WaypointDetail>(getWaypointDetail());
  const soundToggles = reactive<Record<SoundCategory, boolean>>({
    fire: getSoundToggle('fire'),
    hit: getSoundToggle('hit'),
    dead: getSoundToggle('dead'),
    beam: getSoundToggle('beam'),
    field: getSoundToggle('field'),
    music: getSoundToggle('music'),
  });
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
    hitbox: getUnitRadiusToggle('hitbox'),
    collision: getUnitRadiusToggle('collision'),
  });
  function seedEntityHud(): EntityHudToggles {
    const out = {} as EntityHudToggles;
    for (const type of ENTITY_HUD_TYPES) {
      out[type] = {} as Record<EntityHudElement, boolean>;
      for (const element of ENTITY_HUD_ELEMENTS) {
        out[type][element] = getEntityHudToggle(type, element);
      }
    }
    return out;
  }
  const entityHud = reactive<EntityHudToggles>(seedEntityHud());
  const selectionHudMode = ref<SelectionHudMode>(getSelectionHudMode());
  const legsRadiusToggle = ref(getLegsRadiusToggle());
  const cameraSmoothMode = ref<CameraSmoothMode>(getCameraSmoothMode());
  const cameraFovDegrees = ref<CameraFovDegrees>(getCameraFovDegrees());

  function applyAudioRuntimeState(): void {
    audioManager.setMuted(audioScope.value === 'off');
    // OTHER-1: push the persisted per-category state into AudioManager
    // so the SOUNDS: buttons gate actual playback. Music goes through
    // musicPlayer below; AudioManager ignores it.
    for (const cat of SOUND_CATEGORIES) {
      audioManager.setCategoryEnabled(cat, soundToggles[cat]);
    }
    if (!soundToggles.music) musicPlayer.stop();
  }

  function syncRefsFromClientConfig(): void {
    renderMode.value = getRenderMode();
    audioScope.value = getAudioScope();
    audioSmoothing.value = getAudioSmoothing();
    burnMarks.value = getBurnMarks();
    locomotionMarks.value = getLocomotionMarks();
    smokeTrails.value = getSmokeTrails();
    smokeSoftEdges.value = getSmokeSoftEdges();
    beamSnapToTurret.value = getBeamSnapToTurret();
    resourceBallDensity.value = getResourceBallDensity();
    triangleDebug.value = getTriangleDebug();
    buildGridDebug.value = getBuildGridDebug();
    sightBoundary.value = getSightBoundary();
    radarBoundary.value = getRadarBoundary();
    movementPosEma.value = getMovementPosEmaMode();
    movementVelEma.value = getMovementVelEmaMode();
    rotationPosEma.value = getRotationPosEmaMode();
    rotationVelEma.value = getRotationVelEmaMode();
    predictionMode.value = getPredictionMode();
    clientUnitGroundNormalEmaMode.value = getClientUnitGroundNormalEmaMode();
    edgeScrollEnabled.value = getEdgeScrollEnabled();
    dragPanEnabled.value = getDragPanEnabled();
    waypointDetail.value = getWaypointDetail();
    for (const type of ENTITY_HUD_TYPES) {
      for (const element of ENTITY_HUD_ELEMENTS) {
        entityHud[type][element] = getEntityHudToggle(type, element);
      }
    }
    selectionHudMode.value = getSelectionHudMode();
    for (const cat of SOUND_CATEGORIES) soundToggles[cat] = getSoundToggle(cat);
    for (const rt of RANGE_TYPES) rangeToggles[rt] = getRangeToggle(rt);
    for (const prt of PROJ_RANGE_TYPES) projRangeToggles[prt] = getProjRangeToggle(prt);
    for (const urt of UNIT_RADIUS_TYPES) unitRadiusToggles[urt] = getUnitRadiusToggle(urt);
    legsRadiusToggle.value = getLegsRadiusToggle();
    cameraSmoothMode.value = getCameraSmoothMode();
    cameraFovDegrees.value = getCameraFovDegrees();
    applyAudioRuntimeState();
    applyCameraFovDegrees(cameraFovDegrees.value);
  }

  applyAudioRuntimeState();

  watch(currentClientMode, (mode) => {
    setClientMode(mode);
    syncRefsFromClientConfig();
  });

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

  function toggleSmokeTrails(): void {
    const newValue = !smokeTrails.value;
    setSmokeTrails(newValue);
    smokeTrails.value = newValue;
  }

  function toggleSmokeSoftEdges(): void {
    const newValue = !smokeSoftEdges.value;
    setSmokeSoftEdges(newValue);
    smokeSoftEdges.value = newValue;
  }

  function toggleBeamSnapToTurret(): void {
    const newValue = !beamSnapToTurret.value;
    setBeamSnapToTurret(newValue);
    beamSnapToTurret.value = newValue;
  }

  function changeResourceBallDensity(value: number): void {
    setResourceBallDensity(value);
    resourceBallDensity.value = getResourceBallDensity();
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

  function toggleSightBoundary(): void {
    const newValue = !sightBoundary.value;
    setSightBoundary(newValue);
    sightBoundary.value = newValue;
  }

  function toggleRadarBoundary(): void {
    const newValue = !radarBoundary.value;
    setRadarBoundary(newValue);
    radarBoundary.value = newValue;
  }

  function changeMovementPosEma(mode: PositionDriftChannelMode): void {
    setMovementPosEmaMode(mode);
    movementPosEma.value = mode;
  }

  function changeMovementVelEma(mode: DriftChannelMode): void {
    setMovementVelEmaMode(mode);
    movementVelEma.value = mode;
  }

  function changeRotationPosEma(mode: PositionDriftChannelMode): void {
    setRotationPosEmaMode(mode);
    rotationPosEma.value = mode;
  }

  function changeRotationVelEma(mode: DriftChannelMode): void {
    setRotationVelEmaMode(mode);
    rotationVelEma.value = mode;
  }

  function changePredictionMode(mode: PredictionMode): void {
    setPredictionMode(mode);
    predictionMode.value = mode;
  }

  function changeClientUnitGroundNormalEmaMode(mode: DriftMode): void {
    setClientUnitGroundNormalEmaMode(mode);
    clientUnitGroundNormalEmaMode.value = mode;
  }

  function changeWaypointDetail(mode: WaypointDetail): void {
    setWaypointDetail(mode);
    waypointDetail.value = mode;
  }

  function toggleEntityHud(type: EntityHudType, element: EntityHudElement): void {
    const newValue = !entityHud[type][element];
    setEntityHudToggle(type, element, newValue);
    entityHud[type][element] = newValue;
  }

  function changeSelectionHudMode(mode: SelectionHudMode): void {
    setSelectionHudMode(mode);
    selectionHudMode.value = mode;
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
    const cd = getClientConfig(currentClientMode.value);
    changeRenderMode(cd.render.default);
    changeAudioScope(cd.audio.default);
    setAudioSmoothing(cd.audioSmoothing.default);
    audioSmoothing.value = cd.audioSmoothing.default;
    setBurnMarks(cd.burnMarks.default);
    burnMarks.value = cd.burnMarks.default;
    setLocomotionMarks(cd.locomotionMarks.default);
    locomotionMarks.value = cd.locomotionMarks.default;
    setSmokeTrails(cd.smokeTrails.default);
    smokeTrails.value = cd.smokeTrails.default;
    setSmokeSoftEdges(cd.smokeSoftEdges.default);
    smokeSoftEdges.value = cd.smokeSoftEdges.default;
    setBeamSnapToTurret(cd.beamSnapToTurret.default);
    beamSnapToTurret.value = cd.beamSnapToTurret.default;
    changeResourceBallDensity(DEFAULT_BALLS_PER_RESOURCE_PER_SECOND);
    setTriangleDebug(cd.triangleDebug.default);
    triangleDebug.value = cd.triangleDebug.default;
    setBuildGridDebug(cd.buildGridDebug.default);
    buildGridDebug.value = cd.buildGridDebug.default;
    setSightBoundary(cd.sightBoundary.default);
    sightBoundary.value = cd.sightBoundary.default;
    setRadarBoundary(cd.radarBoundary.default);
    radarBoundary.value = cd.radarBoundary.default;
    setMovementPosEmaMode(cd.movementPosEma.default);
    movementPosEma.value = cd.movementPosEma.default;
    setMovementVelEmaMode(cd.movementVelEma.default);
    movementVelEma.value = cd.movementVelEma.default;
    setRotationPosEmaMode(cd.rotationPosEma.default);
    rotationPosEma.value = cd.rotationPosEma.default;
    setRotationVelEmaMode(cd.rotationVelEma.default);
    rotationVelEma.value = cd.rotationVelEma.default;
    setPredictionMode(cd.predictionMode.default);
    predictionMode.value = cd.predictionMode.default;
    setClientUnitGroundNormalEmaMode(cd.unitGroundNormalEma.default);
    clientUnitGroundNormalEmaMode.value = cd.unitGroundNormalEma.default;
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
    waypointDetail.value = cd.waypointDetail.default;
    setWaypointDetail(cd.waypointDetail.default);
    for (const type of ENTITY_HUD_TYPES) {
      for (const element of ENTITY_HUD_ELEMENTS) {
        const def = cd.entityHud.default[type][element];
        if (entityHud[type][element] !== def) toggleEntityHud(type, element);
      }
    }
    changeSelectionHudMode(cd.selectionHudMode.default);
    if (legsRadiusToggle.value !== cd.legsRadius.default) toggleLegsRadius();
    setCameraMode(cd.cameraSmooth.default);
    changeCameraFovDegrees(cd.cameraFov.default);
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
    field: 'Continuous shield sounds',
    music: 'Background music (procedural or MIDI)',
  };

  return {
    renderMode,
    audioScope,
    audioSmoothing,
    burnMarks,
    locomotionMarks,
    smokeTrails,
    smokeSoftEdges,
    beamSnapToTurret,
    resourceBallDensity,
    triangleDebug,
    buildGridDebug,
    sightBoundary,
    radarBoundary,
    movementPosEma,
    movementVelEma,
    rotationPosEma,
    rotationVelEma,
    predictionMode,
    clientUnitGroundNormalEmaMode,
    edgeScrollEnabled,
    dragPanEnabled,
    waypointDetail,
    entityHud,
    selectionHudMode,
    entityHudTypes: ENTITY_HUD_TYPES,
    entityHudElements: ENTITY_HUD_ELEMENTS,
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
    toggleSmokeTrails,
    toggleSmokeSoftEdges,
    toggleBeamSnapToTurret,
    changeResourceBallDensity,
    toggleTriangleDebug,
    toggleBuildGridDebug,
    toggleSightBoundary,
    toggleRadarBoundary,
    changeMovementPosEma,
    changeMovementVelEma,
    changeRotationPosEma,
    changeRotationVelEma,
    changePredictionMode,
    changeClientUnitGroundNormalEmaMode,
    changeWaypointDetail,
    toggleEntityHud,
    changeSelectionHudMode,
    toggleEdgeScroll,
    toggleDragPan,
    toggleAllPan,
    toggleAllSounds,
    toggleSoundCategory,
  };
}
