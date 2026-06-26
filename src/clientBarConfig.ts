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
  DriftChannelMode,
  DriftMode,
  EntityHudElement,
  EntityHudToggles,
  EntityHudType,
  MasterVolumePercent,
  PositionDriftChannelMode,
  PredictionMode,
  PathingDebugUnitId,
  SelectionHudMode,
  SoundCategory,
  RangeType,
  ProjRangeType,
  UnitRadiusType,
  WaypointDetail,
} from './types/client';
import { CAMERA_FOV_DEGREES } from './config';
import { persist, persistJson, readPersisted } from './persistence';
import {
  DEFAULT_BALLS_PER_RESOURCE_PER_SECOND,
  isResourceBallDensityOption,
  setBallsPerResourcePerSecond,
} from './resourceConfig';
import rawPlayerClientGraphicsConfig from './playerClientGraphicsConfig.json';
import clientBarConfig from './clientBarConfig.json';
import { isBuildableUnitBlueprintId } from './game/sim/blueprints/unitRoster';

export type { CameraSmoothMode, CameraFollowMode } from './types/client';
export type {
  EntityHudElement,
  EntityHudType,
  SelectionHudMode,
} from './types/client';
export type ClientMode = 'demo' | 'real';

// ── Authored data lives in clientBarConfig.json ──
// The TS shim re-exports CLIENT_CONFIG as a typed view over the JSON.
// One field needs a cross-config reference: `cameraFov.default` reads
// from CAMERA_FOV_DEGREES in config.ts so the canonical FOV stays in
// one place and the bar inherits it.

type OptionList<T> = ReadonlyArray<{ value: T; label: string }>;
const PLAYER_CLIENT_MAX_GRAPHICS_CONFIG = rawPlayerClientGraphicsConfig as GraphicsConfig;

type ClientDefaults = {
  readonly render: RenderMode;
  readonly audio: Exclude<AudioScope, 'off'>;
  readonly masterVolume: MasterVolumePercent;
  readonly audioSmoothing: boolean;
  readonly burnMarks: boolean;
  readonly locomotionMarks: boolean;
  readonly smokeTrails: boolean;
  readonly smokeSoftEdges: boolean;
  readonly fogClouds: boolean;
  readonly materialExplosions: boolean;
  readonly beamSnapToTurret: boolean;
  readonly triangleDebug: boolean;
  readonly buildGridDebug: boolean;
  readonly metalMap: boolean;
  readonly elevationMap: boolean;
  readonly pathingMap: boolean;
  readonly pathingDebugUnit: PathingDebugUnitId;
  readonly sightBoundary: boolean;
  readonly radarBoundary: boolean;
  readonly predictionMode: PredictionMode;
  readonly movementPosEma: PositionDriftChannelMode;
  readonly movementVelEma: DriftChannelMode;
  readonly rotationPosEma: PositionDriftChannelMode;
  readonly rotationVelEma: DriftChannelMode;
  readonly unitGroundNormalEma: DriftMode;
  readonly legsRadius: boolean;
  readonly cameraSmooth: CameraSmoothMode;
  readonly cameraFollow: CameraFollowMode;
  readonly cameraFov: CameraFovDegrees;
  readonly edgeScroll: boolean;
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
    fogClouds: pickDefault(clientBarConfig.fogClouds, mode),
    materialExplosions: pickDefault(clientBarConfig.materialExplosions, mode),
    beamSnapToTurret: pickDefault(clientBarConfig.beamSnapToTurret, mode),
    triangleDebug: pickDefault(clientBarConfig.triangleDebug, mode),
    buildGridDebug: pickDefault(clientBarConfig.buildGridDebug, mode),
    metalMap: pickDefault(clientBarConfig.metalMap, mode),
    elevationMap: pickDefault(clientBarConfig.elevationMap, mode),
    pathingMap: pickDefault(clientBarConfig.pathingMap, mode),
    pathingDebugUnit:
      pickDefault(clientBarConfig.pathingDebugUnit, mode) as PathingDebugUnitId,
    sightBoundary: pickDefault(clientBarConfig.sightBoundary, mode),
    radarBoundary: pickDefault(clientBarConfig.radarBoundary, mode),
    predictionMode: pickDefault(clientBarConfig.predictionMode, mode) as PredictionMode,
    movementPosEma: pickDefault(clientBarConfig.movementPosEma, mode) as PositionDriftChannelMode,
    movementVelEma: pickDefault(clientBarConfig.movementVelEma, mode) as DriftChannelMode,
    rotationPosEma: pickDefault(clientBarConfig.rotationPosEma, mode) as PositionDriftChannelMode,
    rotationVelEma: pickDefault(clientBarConfig.rotationVelEma, mode) as DriftChannelMode,
    unitGroundNormalEma: pickDefault(clientBarConfig.unitGroundNormalEma, mode) as DriftMode,
    legsRadius: pickDefault(clientBarConfig.legsRadius, mode),
    cameraSmooth: pickDefault(clientBarConfig.cameraSmooth, mode) as CameraSmoothMode,
    cameraFollow: pickDefault(clientBarConfig.cameraFollow, mode) as CameraFollowMode,
    // FOV default lives in config.ts as CAMERA_FOV_DEGREES — keep one
    // canonical source for that one knob; the JSON only owns the options list.
    cameraFov: CAMERA_FOV_DEGREES,
    edgeScroll: pickDefault(clientBarConfig.edgeScroll, mode),
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
  fogClouds: { default: DEMO_CLIENT_DEFAULTS.fogClouds },
  materialExplosions: { default: DEMO_CLIENT_DEFAULTS.materialExplosions },
  beamSnapToTurret: { default: DEMO_CLIENT_DEFAULTS.beamSnapToTurret },
  triangleDebug: { default: DEMO_CLIENT_DEFAULTS.triangleDebug },
  buildGridDebug: { default: DEMO_CLIENT_DEFAULTS.buildGridDebug },
  metalMap: { default: DEMO_CLIENT_DEFAULTS.metalMap },
  elevationMap: { default: DEMO_CLIENT_DEFAULTS.elevationMap },
  pathingMap: { default: DEMO_CLIENT_DEFAULTS.pathingMap },
  pathingDebugUnit: { default: DEMO_CLIENT_DEFAULTS.pathingDebugUnit },
  sightBoundary: { default: DEMO_CLIENT_DEFAULTS.sightBoundary },
  radarBoundary: { default: DEMO_CLIENT_DEFAULTS.radarBoundary },
  /** Prediction physics order: POS / VEL. Default 'vel' (integrate
   *  position from the last-seen velocity each frame); 'pos' skips
   *  integration entirely and snaps straight to snapshot position.
   *  There is no ACC mode — acceleration is not shipped on the wire,
   *  so the client cannot integrate it. */
  predictionMode: {
    default: DEMO_CLIENT_DEFAULTS.predictionMode,
    options: clientBarConfig.predictionMode.options as OptionList<PredictionMode>,
  },
  /** Per-channel snapshot drift EMAs. Position channels always apply
   *  correction and choose from SNAP / FAST / MED / SLOW. Velocity
   *  channels also expose IGNORE because keeping the predicted
   *  derivative can be meaningful there. */
  movementPosEma: {
    default: DEMO_CLIENT_DEFAULTS.movementPosEma,
    options: clientBarConfig.movementPosEma.options as OptionList<PositionDriftChannelMode>,
  },
  movementVelEma: {
    default: DEMO_CLIENT_DEFAULTS.movementVelEma,
    options: clientBarConfig.movementVelEma.options as OptionList<DriftChannelMode>,
  },
  rotationPosEma: {
    default: DEMO_CLIENT_DEFAULTS.rotationPosEma,
    options: clientBarConfig.rotationPosEma.options as OptionList<PositionDriftChannelMode>,
  },
  rotationVelEma: {
    default: DEMO_CLIENT_DEFAULTS.rotationVelEma,
    options: clientBarConfig.rotationVelEma.options as OptionList<DriftChannelMode>,
  },
  /** Client-side unit ground normal EMA layered ON TOP of the host's
   *  ground-normal EMA. SNAP = no client smoothing. */
  unitGroundNormalEma: {
    default: DEMO_CLIENT_DEFAULTS.unitGroundNormalEma,
    options: clientBarConfig.unitGroundNormalEma.options as OptionList<DriftMode>,
  },
  legsRadius: { default: DEMO_CLIENT_DEFAULTS.legsRadius },
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
  edgeScroll: { default: DEMO_CLIENT_DEFAULTS.edgeScroll },
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
    fogClouds: { default: defaults.fogClouds },
    materialExplosions: { default: defaults.materialExplosions },
    beamSnapToTurret: { default: defaults.beamSnapToTurret },
    triangleDebug: { default: defaults.triangleDebug },
    buildGridDebug: { default: defaults.buildGridDebug },
    metalMap: { default: defaults.metalMap },
    elevationMap: { default: defaults.elevationMap },
    pathingMap: { default: defaults.pathingMap },
    pathingDebugUnit: { default: defaults.pathingDebugUnit },
    sightBoundary: { default: defaults.sightBoundary },
    radarBoundary: { default: defaults.radarBoundary },
    predictionMode: { ...CLIENT_CONFIG.predictionMode, default: defaults.predictionMode },
    movementPosEma: { ...CLIENT_CONFIG.movementPosEma, default: defaults.movementPosEma },
    movementVelEma: { ...CLIENT_CONFIG.movementVelEma, default: defaults.movementVelEma },
    rotationPosEma: { ...CLIENT_CONFIG.rotationPosEma, default: defaults.rotationPosEma },
    rotationVelEma: { ...CLIENT_CONFIG.rotationVelEma, default: defaults.rotationVelEma },
    unitGroundNormalEma: {
      ...CLIENT_CONFIG.unitGroundNormalEma,
      default: defaults.unitGroundNormalEma,
    },
    legsRadius: { default: defaults.legsRadius },
    cameraSmooth: { ...CLIENT_CONFIG.cameraSmooth, default: defaults.cameraSmooth },
    cameraFollow: { ...CLIENT_CONFIG.cameraFollow, default: defaults.cameraFollow },
    cameraFov: { ...CLIENT_CONFIG.cameraFov, default: defaults.cameraFov },
    edgeScroll: { default: defaults.edgeScroll },
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
  | 'fogClouds'
  | 'materialExplosions'
  | 'beamSnapToTurret'
  | 'resourceBallDensity'
  | 'triangleDebug'
  | 'buildGridDebug'
  | 'metalMap'
  | 'elevationMap'
  | 'pathingMap'
  | 'pathingDebugUnit'
  | 'sightBoundary'
  | 'radarBoundary'
  | 'movementPosEma'
  | 'movementVelEma'
  | 'rotationPosEma'
  | 'rotationVelEma'
  | 'predictionMode'
  | 'unitGroundNormalEmaMode'
  | 'soundToggles'
  | 'rangeToggles'
  | 'projRangeToggles'
  | 'unitRadiusToggles'
  | 'legsRadius'
  | 'cameraSmooth'
  | 'cameraFollow'
  | 'cameraFov'
  | 'edgeScroll'
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
  'fogClouds',
  'materialExplosions',
  'beamSnapToTurret',
  'resourceBallDensity',
  'triangleDebug',
  'buildGridDebug',
  'metalMap',
  'elevationMap',
  'pathingMap',
  'pathingDebugUnit',
  'sightBoundary',
  'radarBoundary',
  'movementPosEma',
  'movementVelEma',
  'rotationPosEma',
  'rotationVelEma',
  'predictionMode',
  'unitGroundNormalEmaMode',
  'soundToggles',
  'rangeToggles',
  'projRangeToggles',
  'unitRadiusToggles',
  'legsRadius',
  'cameraSmooth',
  'cameraFollow',
  'cameraFov',
  'edgeScroll',
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
let currentCameraSmoothMode: CameraSmoothMode = _cd.cameraSmooth.default;
let currentCameraFollowMode: CameraFollowMode = _cd.cameraFollow.default;
let currentCameraFovDegrees: CameraFovDegrees = _cd.cameraFov.default;
let currentAudioScope: AudioScope = _cd.audio.default;
let currentMasterVolume: MasterVolumePercent = _cd.masterVolume.default;
let currentAudioSmoothing: boolean = _cd.audioSmoothing.default;
let currentBurnMarks: boolean = _cd.burnMarks.default;
let currentLocomotionMarks: boolean = _cd.locomotionMarks.default;
let currentSmokeTrails: boolean = _cd.smokeTrails.default;
let currentSmokeSoftEdges: boolean = _cd.smokeSoftEdges.default;
let currentFogClouds: boolean = _cd.fogClouds.default;
let currentMaterialExplosions: boolean = _cd.materialExplosions.default;
let currentBeamSnapToTurret: boolean = _cd.beamSnapToTurret.default;
let currentResourceBallDensity: number = DEFAULT_BALLS_PER_RESOURCE_PER_SECOND;
let currentTriangleDebug: boolean = _cd.triangleDebug.default;
let currentBuildGridDebug: boolean = _cd.buildGridDebug.default;
let currentMetalMap: boolean = _cd.metalMap.default;
let currentElevationMap: boolean = _cd.elevationMap.default;
let currentPathingMap: boolean = _cd.pathingMap.default;
let currentPathingDebugUnit: PathingDebugUnitId = _cd.pathingDebugUnit.default;
let currentSightBoundary: boolean = _cd.sightBoundary.default;
let currentRadarBoundary: boolean = _cd.radarBoundary.default;
let currentMovementPosEma: PositionDriftChannelMode = _cd.movementPosEma.default;
let currentMovementVelEma: DriftChannelMode = _cd.movementVelEma.default;
let currentRotationPosEma: PositionDriftChannelMode = _cd.rotationPosEma.default;
let currentRotationVelEma: DriftChannelMode = _cd.rotationVelEma.default;
let currentPredictionMode: PredictionMode = _cd.predictionMode.default;
let currentClientUnitGroundNormalEmaMode: DriftMode = _cd.unitGroundNormalEma.default;
const currentSoundToggles: Record<SoundCategory, boolean> = {
  ..._cd.sounds.default,
};
let currentEdgeScrollEnabled: boolean = _cd.edgeScroll.default;
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
  return value === 'none' || (typeof value === 'string' && isBuildableUnitBlueprintId(value));
}

function isCameraFovDegrees(value: number): value is CameraFovDegrees {
  return _cd.cameraFov.options.some((opt) => opt.value === value);
}

function isMasterVolumePercent(value: number): value is MasterVolumePercent {
  return _cd.masterVolume.options.some((opt) => opt.value === value);
}

function isCameraFollowMode(value: unknown): value is CameraFollowMode {
  return value === 'free' || value === 'follow' || value === 'follow-behind';
}

function isDriftChannelMode(value: unknown): value is DriftChannelMode {
  return value === 'ignore'
    || value === 'snap'
    || value === 'fast'
    || value === 'medium'
    || value === 'slow';
}

function isPositionDriftChannelMode(value: unknown): value is PositionDriftChannelMode {
  return value === 'snap'
    || value === 'fast'
    || value === 'medium'
    || value === 'slow';
}

function readDriftChannelMode(storageKey: string, fallback: DriftChannelMode): DriftChannelMode {
  const stored = readPersisted(storageKey);
  return isDriftChannelMode(stored) ? stored : fallback;
}

function readPositionDriftChannelMode(
  storageKey: string,
  fallback: PositionDriftChannelMode,
): PositionDriftChannelMode {
  const stored = readPersisted(storageKey);
  return isPositionDriftChannelMode(stored) ? stored : fallback;
}

function applyResourceBallDensity(value: number): void {
  currentResourceBallDensity = value;
  setBallsPerResourcePerSecond(value);
}

function applyClientDefaults(mode: ClientMode): void {
  const cd = getClientConfig(mode);
  currentRenderMode = cd.render.default;
  for (const rt of RANGE_TYPES) currentRangeToggles[rt] = cd.rangeToggles.default;
  for (const prt of PROJ_RANGE_TYPES) currentProjRangeToggles[prt] = cd.projRangeToggles.default;
  for (const urt of UNIT_RADIUS_TYPES) currentUnitRadiusToggles[urt] = cd.unitRadiusToggles.default;
  currentLegsRadius = cd.legsRadius.default;
  currentCameraSmoothMode = cd.cameraSmooth.default;
  currentCameraFollowMode = cd.cameraFollow.default;
  currentCameraFovDegrees = cd.cameraFov.default;
  currentAudioScope = cd.audio.default;
  currentMasterVolume = cd.masterVolume.default;
  currentAudioSmoothing = cd.audioSmoothing.default;
  currentBurnMarks = cd.burnMarks.default;
  currentLocomotionMarks = cd.locomotionMarks.default;
  currentSmokeTrails = cd.smokeTrails.default;
  currentSmokeSoftEdges = cd.smokeSoftEdges.default;
  currentFogClouds = cd.fogClouds.default;
  currentMaterialExplosions = cd.materialExplosions.default;
  currentBeamSnapToTurret = cd.beamSnapToTurret.default;
  applyResourceBallDensity(DEFAULT_BALLS_PER_RESOURCE_PER_SECOND);
  currentTriangleDebug = cd.triangleDebug.default;
  currentBuildGridDebug = cd.buildGridDebug.default;
  currentMetalMap = cd.metalMap.default;
  currentElevationMap = cd.elevationMap.default;
  currentPathingMap = cd.pathingMap.default;
  currentPathingDebugUnit = cd.pathingDebugUnit.default;
  currentSightBoundary = cd.sightBoundary.default;
  currentRadarBoundary = cd.radarBoundary.default;
  currentMovementPosEma = cd.movementPosEma.default;
  currentMovementVelEma = cd.movementVelEma.default;
  currentRotationPosEma = cd.rotationPosEma.default;
  currentRotationVelEma = cd.rotationVelEma.default;
  currentPredictionMode = cd.predictionMode.default;
  currentClientUnitGroundNormalEmaMode = cd.unitGroundNormalEma.default;
  for (const cat of SOUND_CATEGORIES) currentSoundToggles[cat] = cd.sounds.default[cat];
  currentEdgeScrollEnabled = cd.edgeScroll.default;
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
  const storedFogClouds = readPersisted(keys.fogClouds);
  if (storedFogClouds !== null) {
    currentFogClouds = storedFogClouds === 'true';
  }
  const storedMaterialExplosions = readPersisted(keys.materialExplosions);
  if (storedMaterialExplosions !== null) {
    currentMaterialExplosions = storedMaterialExplosions === 'true';
  }
  const storedBeamSnapToTurret = readPersisted(keys.beamSnapToTurret);
  if (storedBeamSnapToTurret !== null) {
    currentBeamSnapToTurret = storedBeamSnapToTurret === 'true';
  }
  const storedResourceBallDensity = readPersisted(keys.resourceBallDensity);
  if (storedResourceBallDensity !== null) {
    const parsed = Number(storedResourceBallDensity);
    if (Number.isFinite(parsed) && isResourceBallDensityOption(parsed)) {
      applyResourceBallDensity(parsed);
    }
  }
  const storedTriangleDebug = readPersisted(keys.triangleDebug);
  if (storedTriangleDebug !== null) {
    currentTriangleDebug = storedTriangleDebug === 'true';
  }
  const storedBuildGridDebug = readPersisted(keys.buildGridDebug);
  if (storedBuildGridDebug !== null) {
    currentBuildGridDebug = storedBuildGridDebug === 'true';
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
  currentMovementPosEma = readPositionDriftChannelMode(
    keys.movementPosEma,
    currentMovementPosEma,
  );
  currentMovementVelEma = readDriftChannelMode(
    keys.movementVelEma,
    currentMovementVelEma,
  );
  currentRotationPosEma = readPositionDriftChannelMode(
    keys.rotationPosEma,
    currentRotationPosEma,
  );
  currentRotationVelEma = readDriftChannelMode(
    keys.rotationVelEma,
    currentRotationVelEma,
  );
  const storedPredictionMode = readPersisted(keys.predictionMode);
  if (
    storedPredictionMode === 'pos' ||
    storedPredictionMode === 'vel'
  ) {
    currentPredictionMode = storedPredictionMode;
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
  const storedEdgeScroll = readPersisted(keys.edgeScroll);
  if (storedEdgeScroll !== null) {
    currentEdgeScrollEnabled = storedEdgeScroll === 'true';
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

// "Only show proxies" debug-view toggle: force every unit / building / tower to
// render as its level-of-detail PROXY (the hitbox-style simplified mesh)
// regardless of camera distance. Standalone + global (not per-mode) — it is a
// pure inspection aid, so it uses a fixed storage key rather than the per-mode
// client-bar config structure.
const FORCE_LOD_PROXY_STORAGE_KEY = 'client-force-lod-proxy';
let currentForceLodProxy: boolean = readPersisted(FORCE_LOD_PROXY_STORAGE_KEY) === 'true';

export function getForceLodProxyToggle(): boolean {
  return currentForceLodProxy;
}

export function setForceLodProxyToggle(show: boolean): void {
  currentForceLodProxy = show;
  persist(FORCE_LOD_PROXY_STORAGE_KEY, String(show));
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
  currentCameraFovDegrees = fov;
  persist(activeStorageKeys().cameraFov, String(fov));
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
  currentMasterVolume = volume;
  persist(activeStorageKeys().masterVolume, String(volume));
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

/** Fog-cloud toggle: soft fog-of-war cloud puffs only. This does not
 *  change battle-level fog truth, snapshot filtering, or entity
 *  visibility. */
export function getFogClouds(): boolean {
  return currentFogClouds;
}

export function setFogClouds(enabled: boolean): void {
  currentFogClouds = enabled;
  persist(activeStorageKeys().fogClouds, String(enabled));
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

export function getBeamSnapToTurret(): boolean {
  return currentBeamSnapToTurret;
}

export function setBeamSnapToTurret(enabled: boolean): void {
  currentBeamSnapToTurret = enabled;
  persist(activeStorageKeys().beamSnapToTurret, String(enabled));
}

export function getResourceBallDensity(): number {
  return currentResourceBallDensity;
}

export function setResourceBallDensity(value: number): void {
  if (!isResourceBallDensityOption(value)) return;
  applyResourceBallDensity(value);
  persist(activeStorageKeys().resourceBallDensity, String(value));
}

export function getTriangleDebug(): boolean {
  return currentTriangleDebug;
}

export function setTriangleDebug(enabled: boolean): void {
  currentTriangleDebug = enabled;
  persist(activeStorageKeys().triangleDebug, String(enabled));
}

export function getBuildGridDebug(): boolean {
  return currentBuildGridDebug;
}

export function setBuildGridDebug(enabled: boolean): void {
  currentBuildGridDebug = enabled;
  persist(activeStorageKeys().buildGridDebug, String(enabled));
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
  currentPathingDebugUnit = isPathingDebugUnitId(unitBlueprintId) ? unitBlueprintId : 'none';
  persist(activeStorageKeys().pathingDebugUnit, currentPathingDebugUnit);
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

export function getMovementPosEmaMode(): PositionDriftChannelMode {
  return currentMovementPosEma;
}

export function setMovementPosEmaMode(mode: PositionDriftChannelMode): void {
  currentMovementPosEma = mode;
  persist(activeStorageKeys().movementPosEma, mode);
}

export function getMovementVelEmaMode(): DriftChannelMode {
  return currentMovementVelEma;
}

export function setMovementVelEmaMode(mode: DriftChannelMode): void {
  currentMovementVelEma = mode;
  persist(activeStorageKeys().movementVelEma, mode);
}

export function getRotationPosEmaMode(): PositionDriftChannelMode {
  return currentRotationPosEma;
}

export function setRotationPosEmaMode(mode: PositionDriftChannelMode): void {
  currentRotationPosEma = mode;
  persist(activeStorageKeys().rotationPosEma, mode);
}

export function getRotationVelEmaMode(): DriftChannelMode {
  return currentRotationVelEma;
}

export function setRotationVelEmaMode(mode: DriftChannelMode): void {
  currentRotationVelEma = mode;
  persist(activeStorageKeys().rotationVelEma, mode);
}

export function getPredictionMode(): PredictionMode {
  return currentPredictionMode;
}

export function setPredictionMode(mode: PredictionMode): void {
  currentPredictionMode = mode;
  persist(activeStorageKeys().predictionMode, mode);
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

export function getEdgeScrollEnabled(): boolean {
  return currentEdgeScrollEnabled;
}

export function setEdgeScrollEnabled(enabled: boolean): void {
  currentEdgeScrollEnabled = enabled;
  persist(activeStorageKeys().edgeScroll, String(enabled));
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
