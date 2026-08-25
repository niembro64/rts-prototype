import { computed, reactive, ref, watch, type Ref } from 'vue';
import {
  RANGE_TYPES,
  VOLUME_TYPES,
  SOUND_CATEGORIES,
  ENTITY_HUD_TYPES,
  ENTITY_HUD_ELEMENTS,
  getAudioScope,
  getAudioSmoothing,
  getAirLiftProbeDebug,
  getZoomPointsDebug,
  getBuildGridDebug,
  getPathingHierarchyDebug,
  getCameraFollowMode,
  getCameraFovDegrees,
  getCameraSmoothMode,
  getClientConfig,
  getClientUnitGroundNormalEmaMode,
  getDragPanEnabled,
  getElevationMap,
  getEntityShadows,
  getForceFieldsVisible,
  getFogShade,
  getMaterialExplosions,
  getPathingMap,
  getPathingDebugUnit,
  getPathingDebugMode,
  getBurnMarks,
  getWindParticles,
  getAaMsaaMode,
  AA_MSAA_MODE_DEFAULT,
  AA_RESOLUTION_MODE_DEFAULT,
  getAaResolutionMode,
  getLodMode,
  getLegsRadiusToggle,
  getLegsReachToggle,
  getLocomotionMarks,
  getTeamTrim,
  getAmbientLight,
  getEnvironmentLight,
  getSkyLight,
  getExposure,
  getDirectionalLight,
  getTerrainBakedLighting,
  getSurfaceTexture,
  getMasterVolume,
  getMetalMap,
  getRadarBoundary,
  getSmokeTrails,
  getSmokeSoftEdges,
  getSightBoundary,
  getVolumeToggle,
  getRangeToggle,
  getRenderMode,
  getSoundToggle,
  getTriangleDebug,
  getWaterTriangleDebug,
  getWallTriangleDebug,
  getWaypointDetail,
  getWaterBoundaryMode,
  getEntityHudToggle,
  getSelectionHudMode,
  setAudioScope,
  setAudioSmoothing,
  setAirLiftProbeDebug,
  setZoomPointsDebug,
  setBuildGridDebug,
  setPathingHierarchyDebug,
  setCameraFollowMode,
  setCameraFovDegrees,
  setCameraSmoothMode,
  setClientMode,
  setClientUnitGroundNormalEmaMode,
  setDragPanEnabled,
  setElevationMap,
  setEntityShadows,
  setForceFieldsVisible,
  setFogShade,
  setMaterialExplosions,
  setPathingMap,
  setPathingDebugUnit,
  setPathingDebugMode,
  setBurnMarks,
  setWindParticles,
  setAaMsaaMode,
  setAaResolutionMode,
  setLodMode,
  setLegsRadiusToggle,
  setLegsReachToggle,
  setLocomotionMarks,
  setTeamTrim,
  setAmbientLight,
  setEnvironmentLight,
  setSkyLight,
  setExposure,
  setDirectionalLight,
  setTerrainBakedLighting,
  setSurfaceTexture,
  setMasterVolume,
  setMetalMap,
  setRadarBoundary,
  setSmokeTrails,
  setSmokeSoftEdges,
  setSightBoundary,
  setVolumeToggle,
  setRangeToggle,
  setRenderMode,
  setSoundToggle,
  setTriangleDebug,
  setWaterTriangleDebug,
  setWallTriangleDebug,
  setWaypointDetail,
  setWaterBoundaryMode,
  setEntityHudToggle,
  setSelectionHudMode,
  type CameraSmoothMode,
  type CameraFollowMode,
  type ClientMode,
  type LodMode,
  type WaterBoundaryMode,
} from '../clientBarConfig';
import { audioManager } from '../game/audio/AudioManager';
import { musicPlayer } from '../game/audio/MusicPlayer';
import {
  DEFAULT_COMMAND_HOTKEY_PRESET,
  getActiveCommandHotkeyPresetId,
  setActiveCommandHotkeyPresetId,
  type CommandHotkeyPresetId,
} from '../game/input/commandHotkeys';
import type {
  AntialiasMsaaMode,
  AntialiasResolutionMode,
  AudioScope,
  BuildGridDebugMode,
  CameraFovDegrees,
  DriftMode,
  EntityHudElement,
  EntityHudToggles,
  EntityHudType,
  LightIntensityPercent,
  MasterVolumePercent,
  VolumeType,
  RangeType,
  SelectionHudMode,
  SoundCategory,
  WaypointDetail,
  PathingDebugMode,
  PathingDebugUnitId,
} from '../types/client';
import type { RenderMode } from '../types/graphics';
import { setSurfaceChartEnabled } from '@/game/render3d/SurfaceChartMaterial3D';
import {
  setAmbientIntensityScale,
  setBackgroundIntensityScale,
  setDirectionalIntensityScale,
  setEnvironmentIntensityScale,
  setExposureScale,
  setTerrainBakedLightingEnabled,
} from '@/game/render3d/RenderLighting3D';

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
  const environmentLight = ref<LightIntensityPercent>(getEnvironmentLight());
  const ambientLight = ref<LightIntensityPercent>(getAmbientLight());
  const directionalLight = ref<LightIntensityPercent>(getDirectionalLight());
  const skyLight = ref<LightIntensityPercent>(getSkyLight());
  const exposure = ref<LightIntensityPercent>(getExposure());
  const terrainBakedLighting = ref<boolean>(getTerrainBakedLighting());
  const audioSmoothing = ref<boolean>(getAudioSmoothing());
  const burnMarks = ref<boolean>(getBurnMarks());
  const windParticles = ref<boolean>(getWindParticles());
  const locomotionMarks = ref<boolean>(getLocomotionMarks());
  const teamTrim = ref<boolean>(getTeamTrim());
  const surfaceTexture = ref<boolean>(getSurfaceTexture());
  const smokeTrails = ref<boolean>(getSmokeTrails());
  const smokeSoftEdges = ref<boolean>(getSmokeSoftEdges());
  const entityShadows = ref<boolean>(getEntityShadows());
  const forceFieldsVisible = ref<boolean>(getForceFieldsVisible());
  const fogShade = ref<boolean>(getFogShade());
  const materialExplosions = ref<boolean>(getMaterialExplosions());
  const triangleDebug = ref<boolean>(getTriangleDebug());
  const waterTriangleDebug = ref<boolean>(getWaterTriangleDebug());
  const wallTriangleDebug = ref<boolean>(getWallTriangleDebug());
  const buildGridDebugMode = ref<BuildGridDebugMode>(getBuildGridDebug());
  const pathingHierarchyDebug = ref<boolean>(getPathingHierarchyDebug());
  const airLiftProbeDebug = ref<boolean>(getAirLiftProbeDebug());
  const zoomPointsDebug = ref<boolean>(getZoomPointsDebug());
  const metalMap = ref<boolean>(getMetalMap());
  const elevationMap = ref<boolean>(getElevationMap());
  const pathingMap = ref<boolean>(getPathingMap());
  const pathingDebugUnit = ref<PathingDebugUnitId>(getPathingDebugUnit());
  const pathingDebugMode = ref<PathingDebugMode>(getPathingDebugMode());
  const sightBoundary = ref<boolean>(getSightBoundary());
  const radarBoundary = ref<boolean>(getRadarBoundary());
  const clientUnitGroundNormalEmaMode = ref<DriftMode>(getClientUnitGroundNormalEmaMode());
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
  const volumeToggles = reactive<Record<VolumeType, boolean>>({
    selection: getVolumeToggle('selection'),
    hit: getVolumeToggle('hit'),
    collision: getVolumeToggle('collision'),
    arming: getVolumeToggle('arming'),
    explosion: getVolumeToggle('explosion'),
    turretLockOn: getVolumeToggle('turretLockOn'),
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
  const legsReachToggle = ref(getLegsReachToggle());
  const lodMode = ref<LodMode>(getLodMode());
  const aaMsaaMode = ref<AntialiasMsaaMode>(getAaMsaaMode());
  const aaResolutionMode = ref<AntialiasResolutionMode>(getAaResolutionMode());
  const cameraSmoothMode = ref<CameraSmoothMode>(getCameraSmoothMode());
  const cameraFollowMode = ref<CameraFollowMode>(getCameraFollowMode());
  const cameraFovDegrees = ref<CameraFovDegrees>(getCameraFovDegrees());
  const waterBoundaryMode = ref<WaterBoundaryMode>(getWaterBoundaryMode());

  /** Push the persisted light scales into the scene. Lights are plain scene
   *  properties, so this is all it takes — no rebuild, no material touch. */
  function applyLightRuntimeState(): void {
    setEnvironmentIntensityScale(environmentLight.value / 100);
    setAmbientIntensityScale(ambientLight.value / 100);
    setDirectionalIntensityScale(directionalLight.value / 100);
    setBackgroundIntensityScale(skyLight.value / 100);
    setExposureScale(exposure.value / 100);
    setTerrainBakedLightingEnabled(terrainBakedLighting.value);
  }

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
    environmentLight.value = getEnvironmentLight();
    ambientLight.value = getAmbientLight();
    directionalLight.value = getDirectionalLight();
    skyLight.value = getSkyLight();
    exposure.value = getExposure();
    terrainBakedLighting.value = getTerrainBakedLighting();
    applyLightRuntimeState();
    audioSmoothing.value = getAudioSmoothing();
    burnMarks.value = getBurnMarks();
    windParticles.value = getWindParticles();
    locomotionMarks.value = getLocomotionMarks();
    teamTrim.value = getTeamTrim();
    surfaceTexture.value = getSurfaceTexture();
    setSurfaceChartEnabled(surfaceTexture.value);
    smokeTrails.value = getSmokeTrails();
    smokeSoftEdges.value = getSmokeSoftEdges();
    entityShadows.value = getEntityShadows();
    forceFieldsVisible.value = getForceFieldsVisible();
    fogShade.value = getFogShade();
    materialExplosions.value = getMaterialExplosions();
    triangleDebug.value = getTriangleDebug();
    waterTriangleDebug.value = getWaterTriangleDebug();
    wallTriangleDebug.value = getWallTriangleDebug();
    buildGridDebugMode.value = getBuildGridDebug();
    pathingHierarchyDebug.value = getPathingHierarchyDebug();
    airLiftProbeDebug.value = getAirLiftProbeDebug();
    zoomPointsDebug.value = getZoomPointsDebug();
    metalMap.value = getMetalMap();
    elevationMap.value = getElevationMap();
    pathingMap.value = getPathingMap();
    pathingDebugUnit.value = getPathingDebugUnit();
    pathingDebugMode.value = getPathingDebugMode();
    sightBoundary.value = getSightBoundary();
    radarBoundary.value = getRadarBoundary();
    clientUnitGroundNormalEmaMode.value = getClientUnitGroundNormalEmaMode();
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
    for (const vt of VOLUME_TYPES) volumeToggles[vt] = getVolumeToggle(vt);
    legsRadiusToggle.value = getLegsRadiusToggle();
    legsReachToggle.value = getLegsReachToggle();
    lodMode.value = getLodMode();
    aaMsaaMode.value = getAaMsaaMode();
    aaResolutionMode.value = getAaResolutionMode();
    cameraSmoothMode.value = getCameraSmoothMode();
    cameraFollowMode.value = getCameraFollowMode();
    cameraFovDegrees.value = getCameraFovDegrees();
    waterBoundaryMode.value = getWaterBoundaryMode();
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

  function changeEnvironmentLight(percent: LightIntensityPercent): void {
    setEnvironmentLight(percent);
    environmentLight.value = percent;
    setEnvironmentIntensityScale(percent / 100);
  }

  function changeAmbientLight(percent: LightIntensityPercent): void {
    setAmbientLight(percent);
    ambientLight.value = percent;
    setAmbientIntensityScale(percent / 100);
  }

  function changeDirectionalLight(percent: LightIntensityPercent): void {
    setDirectionalLight(percent);
    directionalLight.value = percent;
    setDirectionalIntensityScale(percent / 100);
  }

  function changeSkyLight(percent: LightIntensityPercent): void {
    setSkyLight(percent);
    skyLight.value = percent;
    setBackgroundIntensityScale(percent / 100);
  }

  function changeExposure(percent: LightIntensityPercent): void {
    setExposure(percent);
    exposure.value = percent;
    setExposureScale(percent / 100);
  }

  function toggleTerrainBakedLighting(): void {
    const enabled = !terrainBakedLighting.value;
    setTerrainBakedLighting(enabled);
    terrainBakedLighting.value = enabled;
    setTerrainBakedLightingEnabled(enabled);
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

  function toggleVolume(type: VolumeType): void {
    const newValue = !volumeToggles[type];
    setVolumeToggle(type, newValue);
    volumeToggles[type] = newValue;
  }

  function toggleLegsRadius(): void {
    const newValue = !legsRadiusToggle.value;
    setLegsRadiusToggle(newValue);
    legsRadiusToggle.value = newValue;
  }

  function toggleLegsReach(): void {
    const newValue = !legsReachToggle.value;
    setLegsReachToggle(newValue);
    legsReachToggle.value = newValue;
  }

  function changeLodMode(mode: LodMode): void {
    setLodMode(mode);
    lodMode.value = mode;
  }

  // Both AA knobs are polled by ThreeApp every frame, so persisting the new
  // value is all it takes — the render pipeline reconciles on the next tick.
  function changeAaMsaaMode(mode: AntialiasMsaaMode): void {
    setAaMsaaMode(mode);
    aaMsaaMode.value = getAaMsaaMode();
  }

  function changeAaResolutionMode(mode: AntialiasResolutionMode): void {
    setAaResolutionMode(mode);
    aaResolutionMode.value = getAaResolutionMode();
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

  function changeWaterBoundaryMode(mode: WaterBoundaryMode): void {
    setWaterBoundaryMode(mode);
    waterBoundaryMode.value = getWaterBoundaryMode();
  }

  const allRangesActive = computed(() =>
    RANGE_TYPES.every((rt) => rangeToggles[rt]),
  );
  const allVolumesActive = computed(() =>
    VOLUME_TYPES.every((vt) => volumeToggles[vt]),
  );

  function toggleAllRanges(): void {
    const enable = !allRangesActive.value;
    for (const rt of RANGE_TYPES) {
      setRangeToggle(rt, enable);
      rangeToggles[rt] = enable;
    }
  }

  function toggleAllVolumes(): void {
    const enable = !allVolumesActive.value;
    for (const vt of VOLUME_TYPES) {
      setVolumeToggle(vt, enable);
      volumeToggles[vt] = enable;
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

  function toggleWindParticles(): void {
    const newValue = !windParticles.value;
    setWindParticles(newValue);
    windParticles.value = newValue;
  }

  function toggleLocomotionMarks(): void {
    const newValue = !locomotionMarks.value;
    setLocomotionMarks(newValue);
    locomotionMarks.value = newValue;
  }

  function toggleTeamTrim(): void {
    const newValue = !teamTrim.value;
    setTeamTrim(newValue);
    teamTrim.value = newValue;
  }

  function toggleSurfaceTexture(): void {
    const newValue = !surfaceTexture.value;
    setSurfaceTexture(newValue);
    surfaceTexture.value = newValue;
    // The charted materials read one shared uniform, so this reaches every
    // pool without a walk and without a shader recompile.
    setSurfaceChartEnabled(newValue);
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

  function toggleEntityShadows(): void {
    const newValue = !entityShadows.value;
    setEntityShadows(newValue);
    entityShadows.value = newValue;
  }

  function toggleForceFieldsVisible(): void {
    const newValue = !forceFieldsVisible.value;
    setForceFieldsVisible(newValue);
    forceFieldsVisible.value = newValue;
  }

  function toggleFogShade(): void {
    const newValue = !fogShade.value;
    setFogShade(newValue);
    fogShade.value = newValue;
  }

  function toggleMaterialExplosions(): void {
    const newValue = !materialExplosions.value;
    setMaterialExplosions(newValue);
    materialExplosions.value = newValue;
  }

  function toggleTriangleDebug(): void {
    const newValue = !triangleDebug.value;
    setTriangleDebug(newValue);
    triangleDebug.value = newValue;
  }

  function toggleWaterTriangleDebug(): void {
    const newValue = !waterTriangleDebug.value;
    setWaterTriangleDebug(newValue);
    waterTriangleDebug.value = newValue;
  }

  function toggleWallTriangleDebug(): void {
    const newValue = !wallTriangleDebug.value;
    setWallTriangleDebug(newValue);
    wallTriangleDebug.value = newValue;
  }

  function changeBuildGridDebugMode(mode: BuildGridDebugMode): void {
    setBuildGridDebug(mode);
    buildGridDebugMode.value = mode;
  }

  function togglePathingHierarchyDebug(): void {
    const newValue = !pathingHierarchyDebug.value;
    setPathingHierarchyDebug(newValue);
    pathingHierarchyDebug.value = newValue;
  }

  function toggleAirLiftProbeDebug(): void {
    const newValue = !airLiftProbeDebug.value;
    setAirLiftProbeDebug(newValue);
    airLiftProbeDebug.value = newValue;
  }

  function toggleZoomPointsDebug(): void {
    const newValue = !zoomPointsDebug.value;
    setZoomPointsDebug(newValue);
    zoomPointsDebug.value = newValue;
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

  function changePathingDebugMode(mode: PathingDebugMode): void {
    setPathingDebugMode(mode);
    pathingDebugMode.value = getPathingDebugMode();
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

  function toggleDragPan(): void {
    const newValue = !dragPanEnabled.value;
    setDragPanEnabled(newValue);
    dragPanEnabled.value = newValue;
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
    changeEnvironmentLight(cd.environmentLight.default);
    changeAmbientLight(cd.ambientLight.default);
    changeDirectionalLight(cd.directionalLight.default);
    changeSkyLight(cd.skyLight.default);
    changeExposure(cd.exposure.default);
    setTerrainBakedLighting(cd.terrainBakedLighting.default);
    terrainBakedLighting.value = cd.terrainBakedLighting.default;
    setTerrainBakedLightingEnabled(cd.terrainBakedLighting.default);
    setAudioSmoothing(cd.audioSmoothing.default);
    audioSmoothing.value = cd.audioSmoothing.default;
    setBurnMarks(cd.burnMarks.default);
    burnMarks.value = cd.burnMarks.default;
    setWindParticles(cd.windParticles.default);
    windParticles.value = cd.windParticles.default;
    setLocomotionMarks(cd.locomotionMarks.default);
    locomotionMarks.value = cd.locomotionMarks.default;
    setTeamTrim(cd.teamTrim.default);
    teamTrim.value = cd.teamTrim.default;
    setSurfaceTexture(cd.surfaceTexture.default);
    surfaceTexture.value = cd.surfaceTexture.default;
    setSurfaceChartEnabled(cd.surfaceTexture.default);
    setSmokeTrails(cd.smokeTrails.default);
    smokeTrails.value = cd.smokeTrails.default;
    setSmokeSoftEdges(cd.smokeSoftEdges.default);
    smokeSoftEdges.value = cd.smokeSoftEdges.default;
    setEntityShadows(cd.entityShadows.default);
    entityShadows.value = cd.entityShadows.default;
    setForceFieldsVisible(cd.forceFieldsVisible.default);
    forceFieldsVisible.value = cd.forceFieldsVisible.default;
    setFogShade(cd.fogShade.default);
    fogShade.value = cd.fogShade.default;
    setMaterialExplosions(cd.materialExplosions.default);
    materialExplosions.value = cd.materialExplosions.default;
    setTriangleDebug(cd.triangleDebug.default);
    triangleDebug.value = cd.triangleDebug.default;
    setWallTriangleDebug(cd.wallTriangleDebug.default);
    wallTriangleDebug.value = cd.wallTriangleDebug.default;
    setBuildGridDebug(cd.buildGridDebug.default);
    buildGridDebugMode.value = cd.buildGridDebug.default;
    setPathingHierarchyDebug(cd.pathingHierarchyDebug.default);
    pathingHierarchyDebug.value = cd.pathingHierarchyDebug.default;
    setAirLiftProbeDebug(cd.airLiftProbeDebug.default);
    airLiftProbeDebug.value = cd.airLiftProbeDebug.default;
    setZoomPointsDebug(cd.zoomPointsDebug.default);
    zoomPointsDebug.value = cd.zoomPointsDebug.default;
    setMetalMap(cd.metalMap.default);
    metalMap.value = cd.metalMap.default;
    setElevationMap(cd.elevationMap.default);
    elevationMap.value = cd.elevationMap.default;
    setPathingMap(cd.pathingMap.default);
    pathingMap.value = cd.pathingMap.default;
    changePathingDebugUnit(cd.pathingDebugUnit.default);
    changePathingDebugMode(cd.pathingDebugMode.default);
    setSightBoundary(cd.sightBoundary.default);
    sightBoundary.value = cd.sightBoundary.default;
    setRadarBoundary(cd.radarBoundary.default);
    radarBoundary.value = cd.radarBoundary.default;
    setClientUnitGroundNormalEmaMode(cd.unitGroundNormalEma.default);
    clientUnitGroundNormalEmaMode.value = cd.unitGroundNormalEma.default;
    if (dragPanEnabled.value !== cd.dragPan.default) toggleDragPan();
    for (const rt of RANGE_TYPES) {
      if (rangeToggles[rt] !== cd.rangeToggles.default) toggleRange(rt);
    }
    for (const vt of VOLUME_TYPES) {
      if (volumeToggles[vt] !== cd.volumeToggles.default) toggleVolume(vt);
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
    if (legsReachToggle.value !== cd.legsReach.default) toggleLegsReach();
    setCameraMode(cd.cameraSmooth.default);
    setCameraFollow(cd.cameraFollow.default);
    changeCameraFovDegrees(cd.cameraFov.default);
    changeWaterBoundaryMode(cd.waterBoundaryMode.default);
    // AA knobs are standalone globals; their authored defaults live next to
    // the option lists rather than in the per-mode config.
    changeAaMsaaMode(AA_MSAA_MODE_DEFAULT);
    changeAaResolutionMode(AA_RESOLUTION_MODE_DEFAULT);
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
    environmentLight,
    ambientLight,
    directionalLight,
    skyLight,
    exposure,
    terrainBakedLighting,
    audioSmoothing,
    burnMarks,
    windParticles,
    locomotionMarks,
    teamTrim,
    surfaceTexture,
    smokeTrails,
    smokeSoftEdges,
    entityShadows,
    forceFieldsVisible,
    fogShade,
    materialExplosions,
    triangleDebug,
    waterTriangleDebug,
    wallTriangleDebug,
    buildGridDebugMode,
    pathingHierarchyDebug,
    airLiftProbeDebug,
    zoomPointsDebug,
    metalMap,
    elevationMap,
    pathingMap,
    pathingDebugUnit,
    pathingDebugMode,
    sightBoundary,
    radarBoundary,
    clientUnitGroundNormalEmaMode,
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
    volumeToggles,
    legsRadiusToggle,
    legsReachToggle,
    lodMode,
    aaMsaaMode,
    aaResolutionMode,
    cameraSmoothMode,
    cameraFollowMode,
    cameraFovDegrees,
    waterBoundaryMode,
    allRangesActive,
    allVolumesActive,
    SFX_CATEGORIES,
    allSoundsActive,
    SOUND_LABELS,
    SOUND_TOOLTIPS,
    resetClientDefaults,
    changeRenderMode,
    changeAudioScope,
    changeMasterVolume,
    changeEnvironmentLight,
    changeAmbientLight,
    changeDirectionalLight,
    changeSkyLight,
    changeExposure,
    toggleTerrainBakedLighting,
    toggleRange,
    cycleAttackRangeDisplay,
    toggleVolume,
    toggleLegsRadius,
    toggleLegsReach,
    changeLodMode,
    changeAaMsaaMode,
    changeAaResolutionMode,
    setCameraMode,
    setCameraFollow,
    changeCameraFovDegrees,
    changeCameraFovBy,
    changeWaterBoundaryMode,
    toggleAllRanges,
    toggleAllVolumes,
    toggleAudioSmoothing,
    toggleBurnMarks,
    toggleWindParticles,
    toggleLocomotionMarks,
    toggleTeamTrim,
    toggleSurfaceTexture,
    toggleSmokeTrails,
    toggleSmokeSoftEdges,
    toggleEntityShadows,
    toggleForceFieldsVisible,
    toggleFogShade,
    toggleMaterialExplosions,
    toggleTriangleDebug,
    toggleWaterTriangleDebug,
    toggleWallTriangleDebug,
    changeBuildGridDebugMode,
    togglePathingHierarchyDebug,
    toggleAirLiftProbeDebug,
    toggleZoomPointsDebug,
    toggleMetalMap,
    toggleElevationMap,
    togglePathingMap,
    changePathingDebugMode,
    changePathingDebugUnit,
    toggleSightBoundary,
    toggleRadarBoundary,
    changeClientUnitGroundNormalEmaMode,
    changeWaypointDetail,
    toggleEntityHud,
    changeSelectionHudMode,
    changeCommandHotkeyPreset,
    refreshCommandHotkeys,
    toggleDragPan,
    toggleAllSounds,
    toggleSoundCategory,
  };
}
