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
  getAirLiftProbeDebug,
  getBeamSnapToTurret,
  getBuildGridDebug,
  getCameraFollowMode,
  getCameraFovDegrees,
  getCameraSmoothMode,
  getClientConfig,
  getClientUnitGroundNormalEmaMode,
  getDragPanEnabled,
  getElevationMap,
  getFogClouds,
  getMaterialExplosions,
  getMovementPosEmaMode,
  getMovementVelEmaMode,
  getPathingMap,
  getPathingDebugUnit,
  getPredictionMode,
  getRotationPosEmaMode,
  getRotationVelEmaMode,
  getEdgeScrollEnabled,
  getBurnMarks,
  getLodMode,
  getLegsRadiusToggle,
  getLocomotionMarks,
  getMasterVolume,
  getMetalMap,
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
  getWallTriangleDebug,
  getUnitRadiusToggle,
  getWaypointDetail,
  getEntityHudToggle,
  getSelectionHudMode,
  setAudioScope,
  setAudioSmoothing,
  setAirLiftProbeDebug,
  setBeamSnapToTurret,
  setBuildGridDebug,
  setCameraFollowMode,
  setCameraFovDegrees,
  setCameraSmoothMode,
  setClientMode,
  setClientUnitGroundNormalEmaMode,
  setDragPanEnabled,
  setElevationMap,
  setFogClouds,
  setMaterialExplosions,
  setMovementPosEmaMode,
  setMovementVelEmaMode,
  setPathingMap,
  setPathingDebugUnit,
  setPredictionMode,
  setRotationPosEmaMode,
  setRotationVelEmaMode,
  setEdgeScrollEnabled,
  setBurnMarks,
  setLodMode,
  setLegsRadiusToggle,
  setLocomotionMarks,
  setMasterVolume,
  setMetalMap,
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
  setWallTriangleDebug,
  setUnitRadiusToggle,
  setWaypointDetail,
  setEntityHudToggle,
  setSelectionHudMode,
  type CameraSmoothMode,
  type CameraFollowMode,
  type ClientMode,
  type LodMode,
} from '../clientBarConfig';
import { audioManager } from '../game/audio/AudioManager';
import { musicPlayer } from '../game/audio/MusicPlayer';
import {
  DEFAULT_COMMAND_HOTKEY_PRESET,
  getActiveCommandHotkeyPresetId,
  setActiveCommandHotkeyPresetId,
  type CommandHotkeyPresetId,
} from '../game/input/commandHotkeys';
import { DEFAULT_BALLS_PER_RESOURCE_PER_SECOND } from '../resourceConfig';
import type {
  AudioScope,
  CameraFovDegrees,
  DriftChannelMode,
  DriftMode,
  EntityHudElement,
  EntityHudToggles,
  EntityHudType,
  MasterVolumePercent,
  PositionDriftChannelMode,
  PredictionMode,
  ProjRangeType,
  RangeType,
  SelectionHudMode,
  SoundCategory,
  UnitRadiusType,
  WaypointDetail,
  PathingDebugUnitId,
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
  const masterVolume = ref<MasterVolumePercent>(getMasterVolume());
  const audioSmoothing = ref<boolean>(getAudioSmoothing());
  const burnMarks = ref<boolean>(getBurnMarks());
  const locomotionMarks = ref<boolean>(getLocomotionMarks());
  const smokeTrails = ref<boolean>(getSmokeTrails());
  const smokeSoftEdges = ref<boolean>(getSmokeSoftEdges());
  const fogClouds = ref<boolean>(getFogClouds());
  const materialExplosions = ref<boolean>(getMaterialExplosions());
  const beamSnapToTurret = ref<boolean>(getBeamSnapToTurret());
  const resourceBallDensity = ref<number>(getResourceBallDensity());
  const triangleDebug = ref<boolean>(getTriangleDebug());
  const wallTriangleDebug = ref<boolean>(getWallTriangleDebug());
  const buildGridDebug = ref<boolean>(getBuildGridDebug());
  const airLiftProbeDebug = ref<boolean>(getAirLiftProbeDebug());
  const metalMap = ref<boolean>(getMetalMap());
  const elevationMap = ref<boolean>(getElevationMap());
  const pathingMap = ref<boolean>(getPathingMap());
  const pathingDebugUnit = ref<PathingDebugUnitId>(getPathingDebugUnit());
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
    other: getUnitRadiusToggle('other'),
    hitbox: getUnitRadiusToggle('hitbox'),
    collision: getUnitRadiusToggle('collision'),
    shotArmingRadius: getUnitRadiusToggle('shotArmingRadius'),
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
  const commandHotkeyPreset = ref<CommandHotkeyPresetId>(getActiveCommandHotkeyPresetId());
  const commandHotkeyRevision = ref(0);
  const legsRadiusToggle = ref(getLegsRadiusToggle());
  const lodMode = ref<LodMode>(getLodMode());
  const cameraSmoothMode = ref<CameraSmoothMode>(getCameraSmoothMode());
  const cameraFollowMode = ref<CameraFollowMode>(getCameraFollowMode());
  const cameraFovDegrees = ref<CameraFovDegrees>(getCameraFovDegrees());

  function applyAudioRuntimeState(): void {
    audioManager.setMasterVolume(masterVolume.value / 100);
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
    masterVolume.value = getMasterVolume();
    audioSmoothing.value = getAudioSmoothing();
    burnMarks.value = getBurnMarks();
    locomotionMarks.value = getLocomotionMarks();
    smokeTrails.value = getSmokeTrails();
    smokeSoftEdges.value = getSmokeSoftEdges();
    fogClouds.value = getFogClouds();
    materialExplosions.value = getMaterialExplosions();
    beamSnapToTurret.value = getBeamSnapToTurret();
    resourceBallDensity.value = getResourceBallDensity();
    triangleDebug.value = getTriangleDebug();
    wallTriangleDebug.value = getWallTriangleDebug();
    buildGridDebug.value = getBuildGridDebug();
    airLiftProbeDebug.value = getAirLiftProbeDebug();
    metalMap.value = getMetalMap();
    elevationMap.value = getElevationMap();
    pathingMap.value = getPathingMap();
    pathingDebugUnit.value = getPathingDebugUnit();
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
    commandHotkeyPreset.value = getActiveCommandHotkeyPresetId();
    for (const cat of SOUND_CATEGORIES) soundToggles[cat] = getSoundToggle(cat);
    for (const rt of RANGE_TYPES) rangeToggles[rt] = getRangeToggle(rt);
    for (const prt of PROJ_RANGE_TYPES) projRangeToggles[prt] = getProjRangeToggle(prt);
    for (const urt of UNIT_RADIUS_TYPES) unitRadiusToggles[urt] = getUnitRadiusToggle(urt);
    legsRadiusToggle.value = getLegsRadiusToggle();
    lodMode.value = getLodMode();
    cameraSmoothMode.value = getCameraSmoothMode();
    cameraFollowMode.value = getCameraFollowMode();
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

  function changeMasterVolume(volume: MasterVolumePercent): void {
    setMasterVolume(volume);
    masterVolume.value = volume;
    audioManager.setMasterVolume(volume / 100);
  }

  function toggleRange(type: RangeType): void {
    const newValue = !rangeToggles[type];
    setRangeToggle(type, newValue);
    rangeToggles[type] = newValue;
  }

  function cycleAttackRangeDisplay(direction: 1 | -1): void {
    const maxBitmap = 2 ** RANGE_TYPES.length;
    let bitmap = 0;
    RANGE_TYPES.forEach((type, index) => {
      if (rangeToggles[type]) bitmap += 2 ** index;
    });
    const nextBitmap = (bitmap + direction + maxBitmap) % maxBitmap;
    RANGE_TYPES.forEach((type, index) => {
      const show = (nextBitmap & (1 << index)) !== 0;
      setRangeToggle(type, show);
      rangeToggles[type] = show;
    });
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

  function changeLodMode(mode: LodMode): void {
    setLodMode(mode);
    lodMode.value = mode;
  }

  function setCameraMode(mode: CameraSmoothMode): void {
    setCameraSmoothMode(mode);
    cameraSmoothMode.value = mode;
  }

  function setCameraFollow(mode: CameraFollowMode): void {
    setCameraFollowMode(mode);
    cameraFollowMode.value = mode;
  }

  function changeCameraFovDegrees(fov: CameraFovDegrees): void {
    setCameraFovDegrees(fov);
    cameraFovDegrees.value = getCameraFovDegrees();
    applyCameraFovDegrees(cameraFovDegrees.value);
  }

  function changeCameraFovBy(deltaDegrees: number): void {
    const nextFov = cameraFovDegrees.value + deltaDegrees;
    changeCameraFovDegrees(nextFov);
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

  function toggleFogClouds(): void {
    const newValue = !fogClouds.value;
    setFogClouds(newValue);
    fogClouds.value = newValue;
  }

  function toggleMaterialExplosions(): void {
    const newValue = !materialExplosions.value;
    setMaterialExplosions(newValue);
    materialExplosions.value = newValue;
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

  function toggleWallTriangleDebug(): void {
    const newValue = !wallTriangleDebug.value;
    setWallTriangleDebug(newValue);
    wallTriangleDebug.value = newValue;
  }

  function toggleBuildGridDebug(): void {
    const newValue = !buildGridDebug.value;
    setBuildGridDebug(newValue);
    buildGridDebug.value = newValue;
  }

  function toggleAirLiftProbeDebug(): void {
    const newValue = !airLiftProbeDebug.value;
    setAirLiftProbeDebug(newValue);
    airLiftProbeDebug.value = newValue;
  }

  function toggleMetalMap(): void {
    const newValue = !metalMap.value;
    setMetalMap(newValue);
    metalMap.value = newValue;
  }

  function toggleElevationMap(): void {
    const newValue = !elevationMap.value;
    setElevationMap(newValue);
    elevationMap.value = newValue;
  }

  function togglePathingMap(): void {
    const newValue = !pathingMap.value;
    setPathingMap(newValue);
    pathingMap.value = newValue;
  }

  function changePathingDebugUnit(unitBlueprintId: PathingDebugUnitId): void {
    setPathingDebugUnit(unitBlueprintId);
    pathingDebugUnit.value = getPathingDebugUnit();
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

  function changeCommandHotkeyPreset(presetId: CommandHotkeyPresetId): void {
    setActiveCommandHotkeyPresetId(presetId);
    commandHotkeyPreset.value = presetId;
    commandHotkeyRevision.value += 1;
  }

  function refreshCommandHotkeys(): void {
    commandHotkeyRevision.value += 1;
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
    changeMasterVolume(cd.masterVolume.default);
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
    setFogClouds(cd.fogClouds.default);
    fogClouds.value = cd.fogClouds.default;
    setMaterialExplosions(cd.materialExplosions.default);
    materialExplosions.value = cd.materialExplosions.default;
    setBeamSnapToTurret(cd.beamSnapToTurret.default);
    beamSnapToTurret.value = cd.beamSnapToTurret.default;
    changeResourceBallDensity(DEFAULT_BALLS_PER_RESOURCE_PER_SECOND);
    setTriangleDebug(cd.triangleDebug.default);
    triangleDebug.value = cd.triangleDebug.default;
    setWallTriangleDebug(cd.wallTriangleDebug.default);
    wallTriangleDebug.value = cd.wallTriangleDebug.default;
    setBuildGridDebug(cd.buildGridDebug.default);
    buildGridDebug.value = cd.buildGridDebug.default;
    setAirLiftProbeDebug(cd.airLiftProbeDebug.default);
    airLiftProbeDebug.value = cd.airLiftProbeDebug.default;
    setMetalMap(cd.metalMap.default);
    metalMap.value = cd.metalMap.default;
    setElevationMap(cd.elevationMap.default);
    elevationMap.value = cd.elevationMap.default;
    setPathingMap(cd.pathingMap.default);
    pathingMap.value = cd.pathingMap.default;
    changePathingDebugUnit(cd.pathingDebugUnit.default);
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
    changeCommandHotkeyPreset(DEFAULT_COMMAND_HOTKEY_PRESET);
    if (legsRadiusToggle.value !== cd.legsRadius.default) toggleLegsRadius();
    setCameraMode(cd.cameraSmooth.default);
    setCameraFollow(cd.cameraFollow.default);
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
    masterVolume,
    audioSmoothing,
    burnMarks,
    locomotionMarks,
    smokeTrails,
    smokeSoftEdges,
    fogClouds,
    materialExplosions,
    beamSnapToTurret,
    resourceBallDensity,
    triangleDebug,
    wallTriangleDebug,
    buildGridDebug,
    airLiftProbeDebug,
    metalMap,
    elevationMap,
    pathingMap,
    pathingDebugUnit,
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
    commandHotkeyPreset,
    commandHotkeyRevision,
    entityHudTypes: ENTITY_HUD_TYPES,
    entityHudElements: ENTITY_HUD_ELEMENTS,
    soundToggles,
    rangeToggles,
    projRangeToggles,
    unitRadiusToggles,
    legsRadiusToggle,
    lodMode,
    cameraSmoothMode,
    cameraFollowMode,
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
    changeMasterVolume,
    toggleRange,
    cycleAttackRangeDisplay,
    toggleProjRange,
    toggleUnitRadius,
    toggleLegsRadius,
    changeLodMode,
    setCameraMode,
    setCameraFollow,
    changeCameraFovDegrees,
    changeCameraFovBy,
    toggleAllRanges,
    toggleAllProjRanges,
    toggleAllUnitRadii,
    toggleAudioSmoothing,
    toggleBurnMarks,
    toggleLocomotionMarks,
    toggleSmokeTrails,
    toggleSmokeSoftEdges,
    toggleFogClouds,
    toggleMaterialExplosions,
    toggleBeamSnapToTurret,
    changeResourceBallDensity,
    toggleTriangleDebug,
    toggleWallTriangleDebug,
    toggleBuildGridDebug,
    toggleAirLiftProbeDebug,
    toggleMetalMap,
    toggleElevationMap,
    togglePathingMap,
    changePathingDebugUnit,
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
    changeCommandHotkeyPreset,
    refreshCommandHotkeys,
    toggleEdgeScroll,
    toggleDragPan,
    toggleAllPan,
    toggleAllSounds,
    toggleSoundCategory,
  };
}
