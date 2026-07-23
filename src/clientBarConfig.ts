import type {
  GraphicsConfig,
  RenderMode,
} from './types/graphics';
import type { ClientBarConfig } from './types/client';
import type {
  AudioScope,
  CameraFollowMode,
  CameraFovDegrees,
  CameraSmoothMode,
  DriftMode,
  EntityHudElement,
  EntityHudToggles,
  EntityHudType,
  LodMode,
  MasterVolumePercent,
  PathingDebugMode,
  PathingDebugUnitId,
  SelectionHudMode,
  SoundCategory,
  RangeType,
  ProjRangeType,
  UnitRadiusType,
  WaypointDetail,
  WaterBoundaryMode,
} from './types/client';
import { CAMERA_FOV_DEGREES } from './config';
import { FOG_CONFIG } from './fogConfig';
import { persist, persistJson, readPersisted } from './persistence';
import rawPlayerClientGraphicsConfig from './playerClientGraphicsConfig.json';
import clientBarConfig from './clientBarConfig.json';
import { isBuildableUnitBlueprintId } from './game/sim/blueprints/unitRoster';

export type { CameraSmoothMode, CameraFollowMode } from './types/client';
export type {
  EntityHudElement,
  EntityHudType,
  LodMode,
  SelectionHudMode,
  WaterBoundaryMode,
} from './types/client';
export type ClientMode = 'demo' | 'real';
export type FogShadePresentationSettings = {
  unseenDarkness: number;
  radarDarkness: number;
  unseenDesaturation: number;
  radarDesaturation: number;
};

// ── Authored data lives in clientBarConfig.json ──
// The TS shim re-exports CLIENT_CONFIG as a typed view over the JSON.
// One field needs a cross-config reference: `cameraFov.default` reads
// from CAMERA_FOV_DEGREES in config.ts so the canonical FOV stays in
// one place and the client settings inherit it.

type OptionList<T> = ReadonlyArray<{ value: T; label: string }>;
const PLAYER_CLIENT_MAX_GRAPHICS_CONFIG = rawPlayerClientGraphicsConfig as GraphicsConfig;
const MIN_CAMERA_FOV_DEGREES = 1;
const MAX_CAMERA_FOV_DEGREES = 179;
const FOG_PRESENTATION = FOG_CONFIG.presentation;

type ClientDefaults = {
  readonly render: RenderMode;
  readonly audio: Exclude<AudioScope, 'off'>;
  readonly masterVolume: MasterVolumePercent;
  readonly audioSmoothing: boolean;
  readonly burnMarks: boolean;
  readonly locomotionMarks: boolean;
  readonly smokeTrails: boolean;
  readonly smokeSoftEdges: boolean;
  readonly entityShadows: boolean;
  readonly fogShade: boolean;
  readonly materialExplosions: boolean;
  readonly triangleDebug: boolean;
  readonly waterTriangleDebug: boolean;
  readonly wallTriangleDebug: boolean;
  readonly buildGridDebug: boolean;
  readonly airLiftProbeDebug: boolean;
  readonly zoomPointsDebug: boolean;
  readonly metalMap: boolean;
  readonly elevationMap: boolean;
  readonly pathingMap: boolean;
  readonly pathingDebugUnit: PathingDebugUnitId;
  readonly pathingDebugMode: PathingDebugMode;
  readonly sightBoundary: boolean;
  readonly radarBoundary: boolean;
  readonly unitGroundNormalEma: DriftMode;
  readonly legsRadius: boolean;
  readonly legsReach: boolean;
  readonly cameraSmooth: CameraSmoothMode;
  readonly cameraFollow: CameraFollowMode;
  readonly cameraFov: CameraFovDegrees;
  readonly waterBoundaryMode: WaterBoundaryMode;
  readonly dragPan: boolean;
  readonly sounds: Record<SoundCategory, boolean>;
  readonly rangeToggles: boolean;
  readonly projRangeToggles: boolean;
  readonly unitRadiusToggles: boolean;
  readonly lobbyVisible: { readonly mobile: boolean; readonly desktop: boolean };
  readonly waypointDetail: WaypointDetail;
  readonly entityHud: EntityHudToggles;
  readonly selectionHudMode: SelectionHudMode;
};

// Every per-mode default lives in JSON as paired `demoDefault` and
// `realDefault` fields. The TS shim picks the right one for each mode
// here — there is no `modeDefaults` override block any more, every
// field is fully authored for both modes side-by-side in the JSON.
function pickDefault<T>(
  section: { demoDefault: T; realDefault: T },
  mode: ClientMode,
): T {
  return mode === 'real' ? section.realDefault : section.demoDefault;
}

// Declared here (before `resolveClientDefaults` runs at module init via
// DEMO_CLIENT_DEFAULTS) because `cloneEntityHud` iterates this array
// while building the defaults; the other constant arrays below are only
// touched later in applyClientDefaults / loadFromStorage.
export const ENTITY_HUD_TYPES: EntityHudType[] =
  clientBarConfig.entityHudTypes as EntityHudType[];

export const ENTITY_HUD_ELEMENTS: EntityHudElement[] =
  clientBarConfig.entityHudElements as EntityHudElement[];

export function isEntityHudElementSupported(
  type: EntityHudType,
  element: EntityHudElement,
): boolean {
  if (type === 'shot') return element === 'name';
  return true;
}

function resolveClientDefaults(mode: ClientMode): ClientDefaults {
  return {
    render: pickDefault(clientBarConfig.render, mode) as RenderMode,
    audio: pickDefault(clientBarConfig.audio, mode) as Exclude<AudioScope, 'off'>,
    masterVolume: pickDefault(clientBarConfig.masterVolume, mode) as MasterVolumePercent,
    audioSmoothing: pickDefault(clientBarConfig.audioSmoothing, mode),
    burnMarks: pickDefault(clientBarConfig.burnMarks, mode),
    locomotionMarks: pickDefault(clientBarConfig.locomotionMarks, mode),
    smokeTrails: pickDefault(clientBarConfig.smokeTrails, mode),
    smokeSoftEdges: pickDefault(clientBarConfig.smokeSoftEdges, mode),
    entityShadows: pickDefault(clientBarConfig.entityShadows, mode),
    fogShade: FOG_PRESENTATION.enabledByDefault,
    materialExplosions: pickDefault(clientBarConfig.materialExplosions, mode),
    triangleDebug: pickDefault(clientBarConfig.triangleDebug, mode),
    waterTriangleDebug: pickDefault(clientBarConfig.waterTriangleDebug, mode),
    wallTriangleDebug: pickDefault(clientBarConfig.wallTriangleDebug, mode),
    buildGridDebug: pickDefault(clientBarConfig.buildGridDebug, mode),
    airLiftProbeDebug: pickDefault(clientBarConfig.airLiftProbeDebug, mode),
    zoomPointsDebug: pickDefault(clientBarConfig.zoomPointsDebug, mode),
    metalMap: pickDefault(clientBarConfig.metalMap, mode),
    elevationMap: pickDefault(clientBarConfig.elevationMap, mode),
    pathingMap: pickDefault(clientBarConfig.pathingMap, mode),
    pathingDebugUnit:
      pickDefault(clientBarConfig.pathingDebugUnit, mode) as PathingDebugUnitId,
    pathingDebugMode:
      pickDefault(clientBarConfig.pathingDebugMode, mode) as PathingDebugMode,
    sightBoundary: pickDefault(clientBarConfig.sightBoundary, mode),
    radarBoundary: pickDefault(clientBarConfig.radarBoundary, mode),
    unitGroundNormalEma: pickDefault(clientBarConfig.unitGroundNormalEma, mode) as DriftMode,
    legsRadius: pickDefault(clientBarConfig.legsRadius, mode),
    legsReach: pickDefault(clientBarConfig.legsReach, mode),
    cameraSmooth: pickDefault(clientBarConfig.cameraSmooth, mode) as CameraSmoothMode,
    cameraFollow: pickDefault(clientBarConfig.cameraFollow, mode) as CameraFollowMode,
    // FOV default lives in config.ts as CAMERA_FOV_DEGREES — keep one
    // canonical source for that one knob; the JSON only owns the options list.
    cameraFov: CAMERA_FOV_DEGREES,
    waterBoundaryMode:
      pickDefault(clientBarConfig.waterBoundaryMode, mode) as WaterBoundaryMode,
    dragPan: pickDefault(clientBarConfig.dragPan, mode),
    sounds: { ...pickDefault(clientBarConfig.sounds, mode) } as Record<SoundCategory, boolean>,
    rangeToggles: pickDefault(clientBarConfig.rangeToggles, mode),
    projRangeToggles: pickDefault(clientBarConfig.projRangeToggles, mode),
    unitRadiusToggles: pickDefault(clientBarConfig.unitRadiusToggles, mode),
    lobbyVisible: { ...pickDefault(clientBarConfig.lobbyVisible, mode) },
    waypointDetail: pickDefault(clientBarConfig.waypointDetail, mode) as WaypointDetail,
    entityHud: cloneEntityHud(
      pickDefault(clientBarConfig.entityHud, mode) as EntityHudToggles,
    ),
    selectionHudMode:
      pickDefault(clientBarConfig.selectionHudMode, mode) as SelectionHudMode,
  };
}

// The entityHud default is a nested record; spread-cloning the outer
// record would still share the per-element inner objects between modes
// and the live runtime copy, so clone one level deeper.
function cloneEntityHud(source: EntityHudToggles): EntityHudToggles {
  const out = {} as EntityHudToggles;
  for (const type of ENTITY_HUD_TYPES) {
    out[type] = { ...source[type] };
    for (const element of ENTITY_HUD_ELEMENTS) {
      if (!isEntityHudElementSupported(type, element)) out[type][element] = false;
    }
  }
  return out;
}

const DEMO_CLIENT_DEFAULTS = resolveClientDefaults('demo');

// `CLIENT_CONFIG` keeps the legacy `.default` accessor populated with
// the DEMO CLIENT value (the app boots in demo). Per-mode reads should
// go through `getClientConfig(mode)` / the bar's storage helpers; the
// `.default` field exists for callers that just need the boot-time value.
export const CLIENT_CONFIG = {
  render: {
    default: DEMO_CLIENT_DEFAULTS.render,
    options: clientBarConfig.render.options as OptionList<RenderMode>,
  },
  audio: {
    default: DEMO_CLIENT_DEFAULTS.audio,
    options: clientBarConfig.audio.options as OptionList<Exclude<AudioScope, 'off'>>,
  },
  masterVolume: {
    default: DEMO_CLIENT_DEFAULTS.masterVolume,
    options: clientBarConfig.masterVolume.options as OptionList<MasterVolumePercent>,
  },
  audioSmoothing: { default: DEMO_CLIENT_DEFAULTS.audioSmoothing },
  burnMarks: { default: DEMO_CLIENT_DEFAULTS.burnMarks },
  locomotionMarks: { default: DEMO_CLIENT_DEFAULTS.locomotionMarks },
  smokeTrails: { default: DEMO_CLIENT_DEFAULTS.smokeTrails },
  smokeSoftEdges: { default: DEMO_CLIENT_DEFAULTS.smokeSoftEdges },
  entityShadows: { default: DEMO_CLIENT_DEFAULTS.entityShadows },
  fogShade: { default: DEMO_CLIENT_DEFAULTS.fogShade },
  materialExplosions: { default: DEMO_CLIENT_DEFAULTS.materialExplosions },
  triangleDebug: { default: DEMO_CLIENT_DEFAULTS.triangleDebug },
  waterTriangleDebug: { default: DEMO_CLIENT_DEFAULTS.waterTriangleDebug },
  wallTriangleDebug: { default: DEMO_CLIENT_DEFAULTS.wallTriangleDebug },
  buildGridDebug: { default: DEMO_CLIENT_DEFAULTS.buildGridDebug },
  airLiftProbeDebug: { default: DEMO_CLIENT_DEFAULTS.airLiftProbeDebug },
  zoomPointsDebug: { default: DEMO_CLIENT_DEFAULTS.zoomPointsDebug },
  metalMap: { default: DEMO_CLIENT_DEFAULTS.metalMap },
  elevationMap: { default: DEMO_CLIENT_DEFAULTS.elevationMap },
  pathingMap: { default: DEMO_CLIENT_DEFAULTS.pathingMap },
  pathingDebugUnit: { default: DEMO_CLIENT_DEFAULTS.pathingDebugUnit },
  pathingDebugMode: { default: DEMO_CLIENT_DEFAULTS.pathingDebugMode },
  sightBoundary: { default: DEMO_CLIENT_DEFAULTS.sightBoundary },
  radarBoundary: { default: DEMO_CLIENT_DEFAULTS.radarBoundary },
  /** Client-side unit ground normal EMA layered ON TOP of the host's
   *  ground-normal EMA. SNAP = no client smoothing. */
  unitGroundNormalEma: {
    default: DEMO_CLIENT_DEFAULTS.unitGroundNormalEma,
    options: clientBarConfig.unitGroundNormalEma.options as OptionList<DriftMode>,
  },
  legsRadius: { default: DEMO_CLIENT_DEFAULTS.legsRadius },
  legsReach: { default: DEMO_CLIENT_DEFAULTS.legsReach },
  cameraSmooth: {
    default: DEMO_CLIENT_DEFAULTS.cameraSmooth,
    options: clientBarConfig.cameraSmooth.options as OptionList<CameraSmoothMode>,
  },
  cameraFollow: {
    default: DEMO_CLIENT_DEFAULTS.cameraFollow,
    options: clientBarConfig.cameraFollow.options as OptionList<CameraFollowMode>,
  },
  cameraFov: {
    default: CAMERA_FOV_DEGREES,
    options: clientBarConfig.cameraFov.options as OptionList<CameraFovDegrees>,
  },
  waterBoundaryMode: {
    default: DEMO_CLIENT_DEFAULTS.waterBoundaryMode,
    options: clientBarConfig.waterBoundaryMode.options as OptionList<WaterBoundaryMode>,
  },
  dragPan: { default: DEMO_CLIENT_DEFAULTS.dragPan },
  sounds: { default: { ...DEMO_CLIENT_DEFAULTS.sounds } },
  rangeToggles: { default: DEMO_CLIENT_DEFAULTS.rangeToggles },
  projRangeToggles: { default: DEMO_CLIENT_DEFAULTS.projRangeToggles },
  unitRadiusToggles: { default: DEMO_CLIENT_DEFAULTS.unitRadiusToggles },
  lobbyVisible: { default: { ...DEMO_CLIENT_DEFAULTS.lobbyVisible } },
  waypointDetail: {
    default: DEMO_CLIENT_DEFAULTS.waypointDetail,
    options: clientBarConfig.waypointDetail.options as OptionList<WaypointDetail>,
  },
  entityHud: { default: cloneEntityHud(DEMO_CLIENT_DEFAULTS.entityHud) },
  selectionHudMode: {
    default: DEMO_CLIENT_DEFAULTS.selectionHudMode,
    options: clientBarConfig.selectionHudMode.options as OptionList<SelectionHudMode>,
  },
  telemetryBudgets: { ...clientBarConfig.telemetryBudgets },
} satisfies ClientBarConfig;

// ── Constant arrays ──
export const SOUND_CATEGORIES: SoundCategory[] =
  clientBarConfig.soundCategories as SoundCategory[];

export const RANGE_TYPES: RangeType[] =
  clientBarConfig.rangeTypes as RangeType[];

export const PROJ_RANGE_TYPES: ProjRangeType[] =
  clientBarConfig.projRangeTypes as ProjRangeType[];

export const UNIT_RADIUS_TYPES: UnitRadiusType[] =
  clientBarConfig.unitRadiusTypes as UnitRadiusType[];

function buildClientConfig(defaults: ClientDefaults): ClientBarConfig {
  return {
    ...CLIENT_CONFIG,
    render: { ...CLIENT_CONFIG.render, default: defaults.render },
    audio: { ...CLIENT_CONFIG.audio, default: defaults.audio },
    masterVolume: { ...CLIENT_CONFIG.masterVolume, default: defaults.masterVolume },
    audioSmoothing: { default: defaults.audioSmoothing },
    burnMarks: { default: defaults.burnMarks },
    locomotionMarks: { default: defaults.locomotionMarks },
    smokeTrails: { default: defaults.smokeTrails },
    smokeSoftEdges: { default: defaults.smokeSoftEdges },
    entityShadows: { default: defaults.entityShadows },
    fogShade: { default: defaults.fogShade },
    materialExplosions: { default: defaults.materialExplosions },
    triangleDebug: { default: defaults.triangleDebug },
    waterTriangleDebug: { default: defaults.waterTriangleDebug },
    wallTriangleDebug: { default: defaults.wallTriangleDebug },
    buildGridDebug: { default: defaults.buildGridDebug },
    airLiftProbeDebug: { default: defaults.airLiftProbeDebug },
    zoomPointsDebug: { default: defaults.zoomPointsDebug },
    metalMap: { default: defaults.metalMap },
    elevationMap: { default: defaults.elevationMap },
    pathingMap: { default: defaults.pathingMap },
    pathingDebugUnit: { default: defaults.pathingDebugUnit },
    pathingDebugMode: { default: defaults.pathingDebugMode },
    sightBoundary: { default: defaults.sightBoundary },
    radarBoundary: { default: defaults.radarBoundary },
    unitGroundNormalEma: {
      ...CLIENT_CONFIG.unitGroundNormalEma,
      default: defaults.unitGroundNormalEma,
    },
    legsRadius: { default: defaults.legsRadius },
    legsReach: { default: defaults.legsReach },
    cameraSmooth: { ...CLIENT_CONFIG.cameraSmooth, default: defaults.cameraSmooth },
    cameraFollow: { ...CLIENT_CONFIG.cameraFollow, default: defaults.cameraFollow },
    cameraFov: { ...CLIENT_CONFIG.cameraFov, default: defaults.cameraFov },
    waterBoundaryMode: {
      ...CLIENT_CONFIG.waterBoundaryMode,
      default: defaults.waterBoundaryMode,
    },
    dragPan: { default: defaults.dragPan },
    sounds: { default: { ...defaults.sounds } },
    rangeToggles: { default: defaults.rangeToggles },
    projRangeToggles: { default: defaults.projRangeToggles },
    unitRadiusToggles: { default: defaults.unitRadiusToggles },
    lobbyVisible: { default: { ...defaults.lobbyVisible } },
    waypointDetail: { ...CLIENT_CONFIG.waypointDetail, default: defaults.waypointDetail },
    entityHud: { default: cloneEntityHud(defaults.entityHud) },
    selectionHudMode: {
      ...CLIENT_CONFIG.selectionHudMode,
      default: defaults.selectionHudMode,
    },
  };
}

const CLIENT_MODE_CONFIGS: Record<ClientMode, ClientBarConfig> = {
  demo: buildClientConfig(resolveClientDefaults('demo')),
  real: buildClientConfig(resolveClientDefaults('real')),
};

// ── localStorage keys (module-private) ──
// DEMO CLIENT and REAL CLIENT settings live in separate namespaces.
// No legacy keys are migrated into these namespaces.
type ClientStorageKeyName =
  | 'renderMode'
  | 'audioScope'
  | 'masterVolume'
  | 'audioSmoothing'
  | 'burnMarks'
  | 'locomotionMarks'
  | 'smokeTrails'
  | 'smokeSoftEdges'
  | 'entityShadows'
  | 'fogShade'
  | 'materialExplosions'
  | 'triangleDebug'
  | 'waterTriangleDebug'
  | 'wallTriangleDebug'
  | 'buildGridDebug'
  | 'airLiftProbeDebug'
  | 'zoomPointsDebug'
  | 'metalMap'
  | 'elevationMap'
  | 'pathingMap'
  | 'pathingDebugUnit'
  | 'pathingDebugMode'
  | 'sightBoundary'
  | 'radarBoundary'
  | 'unitGroundNormalEmaMode'
  | 'soundToggles'
  | 'rangeToggles'
  | 'projRangeToggles'
  | 'unitRadiusToggles'
  | 'legsRadius'
  | 'legsReach'
  | 'cameraSmooth'
  | 'cameraFollow'
  | 'cameraFov'
  | 'waterBoundaryMode'
  | 'dragPan'
  | 'lobbyVisible'
  | 'waypointDetail'
  | 'entityHud'
  | 'selectionHudMode';

type ClientStorageKeys = Record<ClientStorageKeyName, string>;

const CLIENT_STORAGE_KEY_NAMES: readonly ClientStorageKeyName[] = [
  'renderMode',
  'audioScope',
  'masterVolume',
  'audioSmoothing',
  'burnMarks',
  'locomotionMarks',
  'smokeTrails',
  'smokeSoftEdges',
  'entityShadows',
  'fogShade',
  'materialExplosions',
  'triangleDebug',
  'waterTriangleDebug',
  'wallTriangleDebug',
  'buildGridDebug',
  'airLiftProbeDebug',
  'zoomPointsDebug',
  'metalMap',
  'elevationMap',
  'pathingMap',
  'pathingDebugUnit',
  'pathingDebugMode',
  'sightBoundary',
  'radarBoundary',
  'unitGroundNormalEmaMode',
  'soundToggles',
  'rangeToggles',
  'projRangeToggles',
  'unitRadiusToggles',
  'legsRadius',
  'legsReach',
  'cameraSmooth',
  'cameraFollow',
  'cameraFov',
  'waterBoundaryMode',
  'dragPan',
  'lobbyVisible',
  'waypointDetail',
  'entityHud',
  'selectionHudMode',
];

const storageKeySuffixes =
  clientBarConfig.storageKeySuffixes as Record<ClientStorageKeyName, string>;

function buildStorageKeys(mode: ClientMode): ClientStorageKeys {
  const keys = {} as ClientStorageKeys;
  for (const name of CLIENT_STORAGE_KEY_NAMES) {
    keys[name] = `${mode}-client-${storageKeySuffixes[name]}`;
  }
  return keys;
}

const CLIENT_STORAGE_KEYS: Record<ClientMode, ClientStorageKeys> = {
  demo: buildStorageKeys('demo'),
  real: buildStorageKeys('real'),
};

// ── Runtime state ──
let currentClientMode: ClientMode = 'demo';

export function getClientConfig(mode: ClientMode = currentClientMode): ClientBarConfig {
  return CLIENT_MODE_CONFIGS[mode];
}

function activeStorageKeys(): ClientStorageKeys {
  return CLIENT_STORAGE_KEYS[currentClientMode];
}

const _cd = CLIENT_MODE_CONFIGS.demo;
let currentRenderMode: RenderMode = _cd.render.default;
const currentRangeToggles: Record<RangeType, boolean> = {
  trackAcquire: _cd.rangeToggles.default,
  trackRelease: _cd.rangeToggles.default,
  engageAcquire: _cd.rangeToggles.default,
  engageRelease: _cd.rangeToggles.default,
  engageMinAcquire: _cd.rangeToggles.default,
  engageMinRelease: _cd.rangeToggles.default,
  build: _cd.rangeToggles.default,
};
const currentProjRangeToggles: Record<ProjRangeType, boolean> = {
  collision: _cd.projRangeToggles.default,
  explosion: _cd.projRangeToggles.default,
};
const currentUnitRadiusToggles: Record<UnitRadiusType, boolean> = {
  other: _cd.unitRadiusToggles.default,
  hitbox: _cd.unitRadiusToggles.default,
  collision: _cd.unitRadiusToggles.default,
  shotArmingRadius: _cd.unitRadiusToggles.default,
};
let currentLegsRadius: boolean = _cd.legsRadius.default;
let currentLegsReach: boolean = _cd.legsReach.default;
let currentCameraSmoothMode: CameraSmoothMode = _cd.cameraSmooth.default;
let currentCameraFollowMode: CameraFollowMode = _cd.cameraFollow.default;
let currentCameraFovDegrees: CameraFovDegrees = _cd.cameraFov.default;
let currentWaterBoundaryMode: WaterBoundaryMode = _cd.waterBoundaryMode.default;
let currentAudioScope: AudioScope = _cd.audio.default;
let currentMasterVolume: MasterVolumePercent = _cd.masterVolume.default;
let currentAudioSmoothing: boolean = _cd.audioSmoothing.default;
let currentBurnMarks: boolean = _cd.burnMarks.default;
let currentLocomotionMarks: boolean = _cd.locomotionMarks.default;
let currentSmokeTrails: boolean = _cd.smokeTrails.default;
let currentSmokeSoftEdges: boolean = _cd.smokeSoftEdges.default;
let currentEntityShadows: boolean = _cd.entityShadows.default;
let currentFogShade: boolean = _cd.fogShade.default;
let currentMaterialExplosions: boolean = _cd.materialExplosions.default;
let currentTriangleDebug: boolean = _cd.triangleDebug.default;
let currentWaterTriangleDebug: boolean = _cd.waterTriangleDebug.default;
let currentWallTriangleDebug: boolean = _cd.wallTriangleDebug.default;
let currentBuildGridDebug: boolean = _cd.buildGridDebug.default;
let currentAirLiftProbeDebug: boolean = _cd.airLiftProbeDebug.default;
let currentZoomPointsDebug: boolean = _cd.zoomPointsDebug.default;
let currentMetalMap: boolean = _cd.metalMap.default;
let currentElevationMap: boolean = _cd.elevationMap.default;
let currentPathingMap: boolean = _cd.pathingMap.default;
let currentPathingDebugUnit: PathingDebugUnitId = _cd.pathingDebugUnit.default;
let currentPathingDebugMode: PathingDebugMode = _cd.pathingDebugMode.default;
let currentSightBoundary: boolean = _cd.sightBoundary.default;
let currentRadarBoundary: boolean = _cd.radarBoundary.default;
let currentClientUnitGroundNormalEmaMode: DriftMode = _cd.unitGroundNormalEma.default;
const currentSoundToggles: Record<SoundCategory, boolean> = {
  ..._cd.sounds.default,
};
let currentDragPanEnabled: boolean = _cd.dragPan.default;
const _isMobile = typeof navigator !== 'undefined' &&
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
let currentWaypointDetail: WaypointDetail = _cd.waypointDetail.default;
const currentEntityHud: EntityHudToggles = cloneEntityHud(_cd.entityHud.default);
let currentSelectionHudMode: SelectionHudMode = _cd.selectionHudMode.default;

function isSelectionHudMode(value: unknown): value is SelectionHudMode {
  return value === 'always' || value === 'never' || value === 'whenNotFull';
}

function isPathingDebugUnitId(value: unknown): value is PathingDebugUnitId {
  return typeof value === 'string' && isBuildableUnitBlueprintId(value);
}

function isPathingDebugMode(value: unknown): value is PathingDebugMode {
  return value === 'none' || value === 'waypoint' || value === 'move';
}

function isCameraFovDegrees(value: number): value is CameraFovDegrees {
  return Number.isFinite(value) &&
    value >= MIN_CAMERA_FOV_DEGREES &&
    value <= MAX_CAMERA_FOV_DEGREES;
}

function normalizeCameraFovDegrees(value: CameraFovDegrees): CameraFovDegrees {
  return Math.min(MAX_CAMERA_FOV_DEGREES, Math.max(MIN_CAMERA_FOV_DEGREES, value));
}

function isMasterVolumePercent(value: number): value is MasterVolumePercent {
  return Number.isFinite(value) && value >= 0 && value <= 200;
}

function isCameraFollowMode(value: unknown): value is CameraFollowMode {
  return value === 'free' || value === 'follow' || value === 'follow-behind';
}

function isWaterBoundaryMode(value: unknown): value is WaterBoundaryMode {
  return value === 'infinity' ||
    value === 'floating-square' ||
    value === 'floating-square-sea';
}

function applyClientDefaults(mode: ClientMode): void {
  const cd = getClientConfig(mode);
  currentRenderMode = cd.render.default;
  for (const rt of RANGE_TYPES) currentRangeToggles[rt] = cd.rangeToggles.default;
  for (const prt of PROJ_RANGE_TYPES) currentProjRangeToggles[prt] = cd.projRangeToggles.default;
  for (const urt of UNIT_RADIUS_TYPES) currentUnitRadiusToggles[urt] = cd.unitRadiusToggles.default;
  currentLegsRadius = cd.legsRadius.default;
  currentLegsReach = cd.legsReach.default;
  currentCameraSmoothMode = cd.cameraSmooth.default;
  currentCameraFollowMode = cd.cameraFollow.default;
  currentCameraFovDegrees = cd.cameraFov.default;
  currentWaterBoundaryMode = cd.waterBoundaryMode.default;
  currentAudioScope = cd.audio.default;
  currentMasterVolume = cd.masterVolume.default;
  currentAudioSmoothing = cd.audioSmoothing.default;
  currentBurnMarks = cd.burnMarks.default;
  currentLocomotionMarks = cd.locomotionMarks.default;
  currentSmokeTrails = cd.smokeTrails.default;
  currentSmokeSoftEdges = cd.smokeSoftEdges.default;
  currentEntityShadows = cd.entityShadows.default;
  currentFogShade = cd.fogShade.default;
  currentMaterialExplosions = cd.materialExplosions.default;
  currentTriangleDebug = cd.triangleDebug.default;
  currentWaterTriangleDebug = cd.waterTriangleDebug.default;
  currentWallTriangleDebug = cd.wallTriangleDebug.default;
  currentBuildGridDebug = cd.buildGridDebug.default;
  currentAirLiftProbeDebug = cd.airLiftProbeDebug.default;
  currentZoomPointsDebug = cd.zoomPointsDebug.default;
  currentMetalMap = cd.metalMap.default;
  currentElevationMap = cd.elevationMap.default;
  currentPathingMap = cd.pathingMap.default;
  currentPathingDebugUnit = cd.pathingDebugUnit.default;
  currentPathingDebugMode = cd.pathingDebugMode.default;
  currentSightBoundary = cd.sightBoundary.default;
  currentRadarBoundary = cd.radarBoundary.default;
  currentClientUnitGroundNormalEmaMode = cd.unitGroundNormalEma.default;
  for (const cat of SOUND_CATEGORIES) currentSoundToggles[cat] = cd.sounds.default[cat];
  currentDragPanEnabled = cd.dragPan.default;
  currentWaypointDetail = cd.waypointDetail.default;
  for (const type of ENTITY_HUD_TYPES) {
    for (const element of ENTITY_HUD_ELEMENTS) {
      currentEntityHud[type][element] = cd.entityHud.default[type][element];
    }
  }
  currentSelectionHudMode = cd.selectionHudMode.default;
}

// ── Load from localStorage on module init / mode switch ──
// Each read is independent — a bad JSON value or throw from ONE key
// must not prevent every later key from loading.
function loadFromStorage(mode: ClientMode): void {
  currentClientMode = mode;
  applyClientDefaults(mode);
  const cd = getClientConfig(mode);
  const keys = CLIENT_STORAGE_KEYS[mode];
  const storedRenderMode = readPersisted(keys.renderMode);
  if (
    storedRenderMode &&
    (storedRenderMode === 'window' ||
      storedRenderMode === 'padded' ||
      storedRenderMode === 'all')
  ) {
    currentRenderMode = storedRenderMode;
  }
  const storedAudioScope = readPersisted(keys.audioScope);
  if (
    storedAudioScope &&
    (storedAudioScope === 'off' ||
      storedAudioScope === 'window' ||
      storedAudioScope === 'padded' ||
      storedAudioScope === 'all')
  ) {
    currentAudioScope = storedAudioScope;
  }
  const storedAudioSmoothing = readPersisted(keys.audioSmoothing);
  if (storedAudioSmoothing !== null) {
    currentAudioSmoothing = storedAudioSmoothing === 'true';
  }
  const storedMasterVolume = readPersisted(keys.masterVolume);
  if (storedMasterVolume !== null) {
    const parsed = Number(storedMasterVolume);
    if (Number.isFinite(parsed) && isMasterVolumePercent(parsed)) {
      currentMasterVolume = parsed;
    }
  }
  const storedBurnMarks = readPersisted(keys.burnMarks);
  if (storedBurnMarks !== null) {
    currentBurnMarks = storedBurnMarks === 'true';
  }
  const storedLocomotionMarks = readPersisted(keys.locomotionMarks);
  if (storedLocomotionMarks !== null) {
    currentLocomotionMarks = storedLocomotionMarks === 'true';
  }
  const storedSmokeTrails = readPersisted(keys.smokeTrails);
  if (storedSmokeTrails !== null) {
    currentSmokeTrails = storedSmokeTrails === 'true';
  }
  const storedSmokeSoftEdges = readPersisted(keys.smokeSoftEdges);
  if (storedSmokeSoftEdges !== null) {
    currentSmokeSoftEdges = storedSmokeSoftEdges === 'true';
  }
  const storedEntityShadows = readPersisted(keys.entityShadows);
  if (storedEntityShadows !== null) {
    currentEntityShadows = storedEntityShadows === 'true';
  }
  const storedFogShade = readPersisted(keys.fogShade);
  if (storedFogShade !== null) {
    currentFogShade = storedFogShade === 'true';
  }
  const storedMaterialExplosions = readPersisted(keys.materialExplosions);
  if (storedMaterialExplosions !== null) {
    currentMaterialExplosions = storedMaterialExplosions === 'true';
  }
  const storedTriangleDebug = readPersisted(keys.triangleDebug);
  if (storedTriangleDebug !== null) {
    currentTriangleDebug = storedTriangleDebug === 'true';
  }
  const storedWaterTriangleDebug = readPersisted(keys.waterTriangleDebug);
  if (storedWaterTriangleDebug !== null) {
    currentWaterTriangleDebug = storedWaterTriangleDebug === 'true';
  }
  const storedWallTriangleDebug = readPersisted(keys.wallTriangleDebug);
  if (storedWallTriangleDebug !== null) {
    currentWallTriangleDebug = storedWallTriangleDebug === 'true';
  }
  const storedBuildGridDebug = readPersisted(keys.buildGridDebug);
  if (storedBuildGridDebug !== null) {
    currentBuildGridDebug = storedBuildGridDebug === 'true';
  }
  const storedAirLiftProbeDebug = readPersisted(keys.airLiftProbeDebug);
  if (storedAirLiftProbeDebug !== null) {
    currentAirLiftProbeDebug = storedAirLiftProbeDebug === 'true';
  }
  const storedZoomPointsDebug = readPersisted(keys.zoomPointsDebug);
  if (storedZoomPointsDebug !== null) {
    currentZoomPointsDebug = storedZoomPointsDebug === 'true';
  }
  const storedMetalMap = readPersisted(keys.metalMap);
  if (storedMetalMap !== null) {
    currentMetalMap = storedMetalMap === 'true';
  }
  const storedElevationMap = readPersisted(keys.elevationMap);
  if (storedElevationMap !== null) {
    currentElevationMap = storedElevationMap === 'true';
  }
  const storedPathingMap = readPersisted(keys.pathingMap);
  if (storedPathingMap !== null) {
    currentPathingMap = storedPathingMap === 'true';
  }
  const storedPathingDebugUnit = readPersisted(keys.pathingDebugUnit);
  if (isPathingDebugUnitId(storedPathingDebugUnit)) {
    currentPathingDebugUnit = storedPathingDebugUnit;
  }
  const storedPathingDebugMode = readPersisted(keys.pathingDebugMode);
  if (isPathingDebugMode(storedPathingDebugMode)) {
    currentPathingDebugMode = storedPathingDebugMode;
  }
  const storedSightBoundary = readPersisted(keys.sightBoundary);
  if (storedSightBoundary !== null) {
    currentSightBoundary = storedSightBoundary === 'true';
  }
  const storedRadarBoundary = readPersisted(keys.radarBoundary);
  if (storedRadarBoundary !== null) {
    currentRadarBoundary = storedRadarBoundary === 'true';
  }
  const storedLegsRadius = readPersisted(keys.legsRadius);
  if (storedLegsRadius !== null) {
    currentLegsRadius = storedLegsRadius === 'true';
  }
  const storedLegsReach = readPersisted(keys.legsReach);
  if (storedLegsReach !== null) {
    currentLegsReach = storedLegsReach === 'true';
  }
  const storedCameraSmooth = readPersisted(keys.cameraSmooth);
  if (
    storedCameraSmooth === 'snap'
    || storedCameraSmooth === 'fast'
    || storedCameraSmooth === 'mid'
    || storedCameraSmooth === 'slow'
  ) {
    currentCameraSmoothMode = storedCameraSmooth;
  } else if (storedCameraSmooth === 'true') {
    currentCameraSmoothMode = cd.cameraSmooth.default;
  } else if (storedCameraSmooth === 'false') {
    currentCameraSmoothMode = 'snap';
  }
  const storedCameraFollow = readPersisted(keys.cameraFollow);
  if (isCameraFollowMode(storedCameraFollow)) {
    currentCameraFollowMode = storedCameraFollow;
  }
  const storedCameraFov = readPersisted(keys.cameraFov);
  if (storedCameraFov !== null) {
    const parsed = Number(storedCameraFov);
    if (Number.isFinite(parsed) && isCameraFovDegrees(parsed)) {
      currentCameraFovDegrees = parsed;
    }
  }
  const storedWaterBoundaryMode = readPersisted(keys.waterBoundaryMode);
  if (isWaterBoundaryMode(storedWaterBoundaryMode)) {
    currentWaterBoundaryMode = storedWaterBoundaryMode;
  }
  const storedClientUnitGroundNormal = readPersisted(keys.unitGroundNormalEmaMode);
  if (
    storedClientUnitGroundNormal &&
    (storedClientUnitGroundNormal === 'snap' ||
      storedClientUnitGroundNormal === 'fast' ||
      storedClientUnitGroundNormal === 'mid' ||
      storedClientUnitGroundNormal === 'slow')
  ) {
    currentClientUnitGroundNormalEmaMode = storedClientUnitGroundNormal;
  }
  const storedSoundToggles = readPersisted(keys.soundToggles);
  if (storedSoundToggles) {
    try {
      const parsed = JSON.parse(storedSoundToggles);
      for (const cat of SOUND_CATEGORIES) {
        if (typeof parsed[cat] === 'boolean') {
          currentSoundToggles[cat] = parsed[cat];
        }
      }
    } catch { /* malformed JSON — keep defaults */ }
  }
  const storedRangeToggles = readPersisted(keys.rangeToggles);
  if (storedRangeToggles) {
    try {
      const parsed = JSON.parse(storedRangeToggles);
      for (const rt of RANGE_TYPES) {
        if (typeof parsed[rt] === 'boolean') {
          currentRangeToggles[rt] = parsed[rt];
        }
      }
    } catch { /* malformed JSON — keep defaults */ }
  }
  const storedProjRangeToggles = readPersisted(keys.projRangeToggles);
  if (storedProjRangeToggles) {
    try {
      const parsed = JSON.parse(storedProjRangeToggles);
      for (const prt of PROJ_RANGE_TYPES) {
        if (typeof parsed[prt] === 'boolean') {
          currentProjRangeToggles[prt] = parsed[prt];
        }
      }
    } catch { /* malformed JSON — keep defaults */ }
  }
  const storedUnitRadiusToggles = readPersisted(keys.unitRadiusToggles);
  if (storedUnitRadiusToggles) {
    try {
      const parsed = JSON.parse(storedUnitRadiusToggles);
      for (const urt of UNIT_RADIUS_TYPES) {
        if (typeof parsed[urt] === 'boolean') {
          currentUnitRadiusToggles[urt] = parsed[urt];
        }
      }
    } catch { /* malformed JSON — keep defaults */ }
  }
  const storedDragPan = readPersisted(keys.dragPan);
  if (storedDragPan !== null) {
    currentDragPanEnabled = storedDragPan === 'true';
  }
  const storedWaypointDetail = readPersisted(keys.waypointDetail);
  if (storedWaypointDetail === 'simple' || storedWaypointDetail === 'detailed') {
    currentWaypointDetail = storedWaypointDetail;
  }
  const storedEntityHud = readPersisted(keys.entityHud);
  if (storedEntityHud) {
    try {
      const parsed = JSON.parse(storedEntityHud);
      const parsedRecord = parsed !== null && typeof parsed === 'object'
        ? parsed as Record<string, unknown>
        : null;
      for (const type of ENTITY_HUD_TYPES) {
        const row = parsedRecord !== null ? parsedRecord[type] : null;
        if (row === null || typeof row !== 'object') continue;
        const rowRecord = row as Record<string, unknown>;
        for (const element of ENTITY_HUD_ELEMENTS) {
          if (!isEntityHudElementSupported(type, element)) {
            currentEntityHud[type][element] = false;
            continue;
          }
          let value = rowRecord[element];
          if (element === 'buildBars' && typeof value !== 'boolean') {
            // Saved HUD blobs from before the RES->BUILD rename used
            // `resourceBars` for this construction-progress toggle.
            value = rowRecord.resourceBars;
          }
          if (typeof value === 'boolean') {
            currentEntityHud[type][element] = value;
          }
        }
      }
    } catch { /* malformed JSON — keep defaults */ }
  }
  const storedSelectionHudMode = readPersisted(keys.selectionHudMode);
  if (isSelectionHudMode(storedSelectionHudMode)) {
    currentSelectionHudMode = storedSelectionHudMode;
  }
}

export function setClientMode(mode: ClientMode): void {
  if (mode === currentClientMode) return;
  loadFromStorage(mode);
}

export function getGraphicsConfig(): GraphicsConfig {
  return PLAYER_CLIENT_MAX_GRAPHICS_CONFIG;
}

export function getRenderMode(): RenderMode {
  return currentRenderMode;
}

export function setRenderMode(mode: RenderMode): void {
  currentRenderMode = mode;
  persist(activeStorageKeys().renderMode, mode);
}

export function getRangeToggle(type: RangeType): boolean {
  return currentRangeToggles[type];
}

export function setRangeToggle(type: RangeType, show: boolean): void {
  currentRangeToggles[type] = show;
  persistJson(activeStorageKeys().rangeToggles, currentRangeToggles);
}

export function anyRangeToggleActive(): boolean {
  return RANGE_TYPES.some((rt) => currentRangeToggles[rt]);
}

export function getProjRangeToggle(type: ProjRangeType): boolean {
  return currentProjRangeToggles[type];
}

export function setProjRangeToggle(type: ProjRangeType, show: boolean): void {
  currentProjRangeToggles[type] = show;
  persistJson(activeStorageKeys().projRangeToggles, currentProjRangeToggles);
}

export function getUnitRadiusToggle(type: UnitRadiusType): boolean {
  return currentUnitRadiusToggles[type];
}

export function setUnitRadiusToggle(type: UnitRadiusType, show: boolean): void {
  currentUnitRadiusToggles[type] = show;
  persistJson(activeStorageKeys().unitRadiusToggles, currentUnitRadiusToggles);
}

export function anyUnitRadiusToggleActive(): boolean {
  return UNIT_RADIUS_TYPES.some((urt) => currentUnitRadiusToggles[urt]);
}

export function getLegsRadiusToggle(): boolean {
  return currentLegsRadius;
}

export function setLegsRadiusToggle(show: boolean): void {
  currentLegsRadius = show;
  persist(activeStorageKeys().legsRadius, String(show));
}

export function getLegsReachToggle(): boolean {
  return currentLegsReach;
}

export function setLegsReachToggle(show: boolean): void {
  currentLegsReach = show;
  persist(activeStorageKeys().legsReach, String(show));
}

// Entity LOD policy. Standalone + global (not per-mode) because it is a
// renderer inspection/perf policy rather than a battle/profile setting.
// Keep the legacy storage key so existing AUTO/HIGH/LOW preferences survive
// the five-mode control upgrade.
const LOD_MODE_STORAGE_KEY = 'client-force-lod-proxy';
export const LOD_MODE_OPTIONS: OptionList<LodMode> = [
  { value: 'auto', label: 'AUTO' },
  { value: 'high', label: 'HIGH' },
  { value: 'medium', label: 'MED' },
  { value: 'low', label: 'LOW' },
  { value: 'off', label: 'OFF' },
];

function parseStoredLodMode(raw: string | null): LodMode {
  if (raw === 'off') return 'off';
  if (raw === 'low' || raw === 'true') return 'low';
  if (raw === 'medium') return 'medium';
  if (raw === 'high') return 'high';
  return 'auto';
}

let currentLodMode: LodMode = parseStoredLodMode(readPersisted(LOD_MODE_STORAGE_KEY));

export function getLodMode(): LodMode {
  return currentLodMode;
}

export function setLodMode(mode: LodMode): void {
  currentLodMode = mode;
  persist(LOD_MODE_STORAGE_KEY, mode);
}

export function getCameraSmoothMode(): CameraSmoothMode {
  return currentCameraSmoothMode;
}

export function setCameraSmoothMode(mode: CameraSmoothMode): void {
  currentCameraSmoothMode = mode;
  persist(activeStorageKeys().cameraSmooth, mode);
}

export function getCameraFollowMode(): CameraFollowMode {
  return currentCameraFollowMode;
}

export function setCameraFollowMode(mode: CameraFollowMode): void {
  currentCameraFollowMode = mode;
  persist(activeStorageKeys().cameraFollow, mode);
}

export function getCameraFovDegrees(): CameraFovDegrees {
  return currentCameraFovDegrees;
}

export function setCameraFovDegrees(fov: CameraFovDegrees): void {
  const nextFov = normalizeCameraFovDegrees(fov);
  currentCameraFovDegrees = nextFov;
  persist(activeStorageKeys().cameraFov, String(nextFov));
}

export function getWaterBoundaryMode(): WaterBoundaryMode {
  return currentWaterBoundaryMode;
}

export function setWaterBoundaryMode(mode: WaterBoundaryMode): void {
  currentWaterBoundaryMode = isWaterBoundaryMode(mode)
    ? mode
    : getClientConfig().waterBoundaryMode.default;
  persist(activeStorageKeys().waterBoundaryMode, currentWaterBoundaryMode);
}

export function getAudioScope(): AudioScope {
  return currentAudioScope;
}

export function setAudioScope(scope: AudioScope): void {
  currentAudioScope = scope;
  persist(activeStorageKeys().audioScope, scope);
}

export function getMasterVolume(): MasterVolumePercent {
  return currentMasterVolume;
}

export function setMasterVolume(volume: MasterVolumePercent): void {
  currentMasterVolume = Math.max(0, Math.min(200, Math.round(volume)));
  persist(activeStorageKeys().masterVolume, String(currentMasterVolume));
}

export function getAudioSmoothing(): boolean {
  return currentAudioSmoothing;
}

export function setAudioSmoothing(enabled: boolean): void {
  currentAudioSmoothing = enabled;
  persist(activeStorageKeys().audioSmoothing, String(enabled));
}

/** Burn-mark toggle: beam, laser, and dgun projectile scorch trails
 *  on the ground plane. Default off — scorches accumulate fast in
 *  long battles and the player typically wants to see the live
 *  battlefield, not its history. */
export function getBurnMarks(): boolean {
  return currentBurnMarks;
}

export function setBurnMarks(enabled: boolean): void {
  currentBurnMarks = enabled;
  persist(activeStorageKeys().burnMarks, String(enabled));
}

/** Locomotion-mark toggle: wheel, tread, and footstep prints from
 *  unit movement. Default on — these decay quickly (≈1s base) and
 *  the motion cues read as part of the unit silhouettes. */
export function getLocomotionMarks(): boolean {
  return currentLocomotionMarks;
}

export function setLocomotionMarks(enabled: boolean): void {
  currentLocomotionMarks = enabled;
  persist(activeStorageKeys().locomotionMarks, String(enabled));
}

/** Smoke-trail toggle: thrust-projectile smoke puffs rendered by
 *  SmokeTrail3D. Default on — turning it off clears any live puffs
 *  immediately and skips spawning new ones. */
export function getSmokeTrails(): boolean {
  return currentSmokeTrails;
}

export function setSmokeTrails(enabled: boolean): void {
  currentSmokeTrails = enabled;
  persist(activeStorageKeys().smokeTrails, String(enabled));
}

/** Smoke-puff edge style read by SmokeTrail3D. Off (default): legacy
 *  hard-edged translucent spheres. On: soft fog-style radial fade so
 *  puffs read as soft blobs. No effect when smoke trails are off. */
export function getSmokeSoftEdges(): boolean {
  return currentSmokeSoftEdges;
}

export function setSmokeSoftEdges(enabled: boolean): void {
  currentSmokeSoftEdges = enabled;
  persist(activeStorageKeys().smokeSoftEdges, String(enabled));
}

/** Entity-shadow toggle: presentation-only grounding shadows written into
 *  the shared world coverage field. Turning this off also skips packet work. */
export function getEntityShadows(): boolean {
  return currentEntityShadows;
}

export function setEntityShadows(enabled: boolean): void {
  currentEntityShadows = enabled;
  persist(activeStorageKeys().entityShadows, String(enabled));
}

/** Fog-shade toggle: world-attached live shade for terrain and environment props.
 *  This does not change battle-level fog truth, snapshot filtering,
 *  or entity visibility. */
export function getFogShade(): boolean {
  return currentFogShade;
}

export function setFogShade(enabled: boolean): void {
  currentFogShade = enabled;
  persist(activeStorageKeys().fogShade, String(enabled));
}

export function getFogShadePresentationSettings(): FogShadePresentationSettings {
  return {
    unseenDarkness: FOG_PRESENTATION.shade.unseenDarknessPercent / 100,
    radarDarkness: FOG_PRESENTATION.shade.radarDarknessPercent / 100,
    unseenDesaturation: FOG_PRESENTATION.shade.unseenColorLossPercent / 100,
    radarDesaturation: FOG_PRESENTATION.shade.radarColorLossPercent / 100,
  };
}

/** Material-explosion toggle: client-side death fire puff and Debris3D
 *  part breakup. Gameplay death, blast damage, knockback, and the
 *  dying shell fade remain authoritative / unchanged. */
export function getMaterialExplosions(): boolean {
  return currentMaterialExplosions;
}

export function setMaterialExplosions(enabled: boolean): void {
  currentMaterialExplosions = enabled;
  persist(activeStorageKeys().materialExplosions, String(enabled));
}

export function getTriangleDebug(): boolean {
  return currentTriangleDebug;
}

export function setTriangleDebug(enabled: boolean): void {
  currentTriangleDebug = enabled;
  persist(activeStorageKeys().triangleDebug, String(enabled));
}

export function getWaterTriangleDebug(): boolean {
  return currentWaterTriangleDebug;
}

export function setWaterTriangleDebug(enabled: boolean): void {
  currentWaterTriangleDebug = enabled;
  persist(activeStorageKeys().waterTriangleDebug, String(enabled));
}

export function getWallTriangleDebug(): boolean {
  return currentWallTriangleDebug;
}

export function setWallTriangleDebug(enabled: boolean): void {
  currentWallTriangleDebug = enabled;
  persist(activeStorageKeys().wallTriangleDebug, String(enabled));
}

export function getBuildGridDebug(): boolean {
  return currentBuildGridDebug;
}

export function setBuildGridDebug(enabled: boolean): void {
  currentBuildGridDebug = enabled;
  persist(activeStorageKeys().buildGridDebug, String(enabled));
}

export function getAirLiftProbeDebug(): boolean {
  return currentAirLiftProbeDebug;
}

export function setAirLiftProbeDebug(enabled: boolean): void {
  currentAirLiftProbeDebug = enabled;
  persist(activeStorageKeys().airLiftProbeDebug, String(enabled));
}

export function getZoomPointsDebug(): boolean {
  return currentZoomPointsDebug;
}

export function setZoomPointsDebug(enabled: boolean): void {
  currentZoomPointsDebug = enabled;
  persist(activeStorageKeys().zoomPointsDebug, String(enabled));
}

export function getMetalMap(): boolean {
  return currentMetalMap;
}

export function setMetalMap(enabled: boolean): void {
  currentMetalMap = enabled;
  persist(activeStorageKeys().metalMap, String(enabled));
}

export function getElevationMap(): boolean {
  return currentElevationMap;
}

export function setElevationMap(enabled: boolean): void {
  currentElevationMap = enabled;
  persist(activeStorageKeys().elevationMap, String(enabled));
}

export function getPathingMap(): boolean {
  return currentPathingMap;
}

export function setPathingMap(enabled: boolean): void {
  currentPathingMap = enabled;
  persist(activeStorageKeys().pathingMap, String(enabled));
}

export function getPathingDebugUnit(): PathingDebugUnitId {
  return currentPathingDebugUnit;
}

export function setPathingDebugUnit(unitBlueprintId: PathingDebugUnitId): void {
  currentPathingDebugUnit = isPathingDebugUnitId(unitBlueprintId)
    ? unitBlueprintId
    : _cd.pathingDebugUnit.default;
  persist(activeStorageKeys().pathingDebugUnit, currentPathingDebugUnit);
}

export function getPathingDebugMode(): PathingDebugMode {
  return currentPathingDebugMode;
}

export function setPathingDebugMode(mode: PathingDebugMode): void {
  currentPathingDebugMode = isPathingDebugMode(mode) ? mode : 'none';
  persist(activeStorageKeys().pathingDebugMode, currentPathingDebugMode);
}

export function getSightBoundary(): boolean {
  return currentSightBoundary;
}

export function setSightBoundary(enabled: boolean): void {
  currentSightBoundary = enabled;
  persist(activeStorageKeys().sightBoundary, String(enabled));
}

export function getRadarBoundary(): boolean {
  return currentRadarBoundary;
}

export function setRadarBoundary(enabled: boolean): void {
  currentRadarBoundary = enabled;
  persist(activeStorageKeys().radarBoundary, String(enabled));
}

/** Active client-side unit ground normal EMA mode. */
export function getClientUnitGroundNormalEmaMode(): DriftMode {
  return currentClientUnitGroundNormalEmaMode;
}

export function setClientUnitGroundNormalEmaMode(mode: DriftMode): void {
  currentClientUnitGroundNormalEmaMode = mode;
  persist(activeStorageKeys().unitGroundNormalEmaMode, mode);
}

export function getSoundToggle(category: SoundCategory): boolean {
  return currentSoundToggles[category];
}

export function setSoundToggle(
  category: SoundCategory,
  enabled: boolean,
): void {
  currentSoundToggles[category] = enabled;
  persistJson(activeStorageKeys().soundToggles, currentSoundToggles);
}

export function getDragPanEnabled(): boolean {
  return currentDragPanEnabled;
}

export function setDragPanEnabled(enabled: boolean): void {
  currentDragPanEnabled = enabled;
  persist(activeStorageKeys().dragPan, String(enabled));
}

/** Per-mode default for the sidebar (lobby) visibility, honoring the
 *  mobile/desktop split. Single source for the module-init value, the
 *  mode-switch reset in applyClientDefaults, and the stored-value fallback. */
function defaultLobbyVisible(mode: ClientMode): boolean {
  const def = CLIENT_MODE_CONFIGS[mode].lobbyVisible.default;
  return _isMobile ? def.mobile : def.desktop;
}

/** Read the persisted sidebar (lobby) visibility for a specific mode WITHOUT
 *  switching the active client mode. Lets the chrome layer restore the sidebar
 *  on a demo↔real transition before setClientMode() has run for that mode,
 *  mirroring the per-mode bottom-bars loaders. Falls back to the mode default
 *  (open). */
export function getStoredLobbyVisible(mode: ClientMode): boolean {
  const stored = readPersisted(CLIENT_STORAGE_KEYS[mode].lobbyVisible);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultLobbyVisible(mode);
}

export function setLobbyVisible(visible: boolean): void {
  persist(activeStorageKeys().lobbyVisible, String(visible));
}

export function getWaypointDetail(): WaypointDetail {
  return currentWaypointDetail;
}

export function setWaypointDetail(mode: WaypointDetail): void {
  currentWaypointDetail = mode;
  persist(activeStorageKeys().waypointDetail, mode);
}

export function getEntityHudToggle(
  type: EntityHudType,
  element: EntityHudElement,
): boolean {
  if (!isEntityHudElementSupported(type, element)) return false;
  return currentEntityHud[type][element];
}

export function setEntityHudToggle(
  type: EntityHudType,
  element: EntityHudElement,
  on: boolean,
): void {
  if (!isEntityHudElementSupported(type, element)) return;
  currentEntityHud[type][element] = on;
  persistJson(activeStorageKeys().entityHud, currentEntityHud);
}

export function getSelectionHudMode(): SelectionHudMode {
  return currentSelectionHudMode;
}

export function setSelectionHudMode(mode: SelectionHudMode): void {
  currentSelectionHudMode = mode;
  persist(activeStorageKeys().selectionHudMode, mode);
}

// Initial page load starts on the demo shell; GameCanvas switches this
// to the real namespace when the user enters the lobby or starts a game.
loadFromStorage('demo');
