import type {
  ConcreteGraphicsQuality,
  GraphicsConfig,
  RenderMode,
} from './types/graphics';
import type { ClientBarConfig } from './types/client';
import type {
  AudioScope,
  CameraFovDegrees,
  CameraSmoothMode,
  DriftMode,
  PredictionMode,
  SoundCategory,
  RangeType,
  ProjRangeType,
  UnitRadiusType,
  WaypointDetail,
} from './types/client';
import { CAMERA_FOV_DEGREES } from './config';
import { persist, persistJson, readPersisted, migrateKey } from './persistence';
import { PLAYER_CLIENT_MAX_GRAPHICS_CONFIG } from './playerClientGraphicsConfig';

export type { CameraSmoothMode } from './types/client';

export const CLIENT_CONFIG = {
  render: {
    default: 'padded' as const,
    options: [
      { value: 'window' as const, label: 'WIN' },
      { value: 'padded' as const, label: 'PAD' },
      { value: 'all' as const, label: 'ALL' },
    ],
  },
  audio: {
    default: 'padded' as const,
    options: [
      { value: 'window' as const, label: 'WIN' },
      { value: 'padded' as const, label: 'PAD' },
      { value: 'all' as const, label: 'ALL' },
    ],
  },
  audioSmoothing: { default: true },
  burnMarks: { default: false },
  locomotionMarks: { default: true },
  beamSnapToTurret: { default: true },
  triangleDebug: { default: false },
  buildGridDebug: { default: false },
  driftMode: { default: 'mid' as const },
  /** Prediction physics order: POS / VEL / ACC. Default 'acc' (full
   *  F=ma extrapolation — matches the original behaviour); 'vel'
   *  ignores reported acceleration when extrapolating; 'pos' skips
   *  integration entirely and snaps straight to snapshot position. */
  predictionMode: {
    default: 'acc' as const,
    options: [
      { value: 'pos' as const, label: 'POS' },
      { value: 'vel' as const, label: 'VEL' },
      { value: 'acc' as const, label: 'ACC' },
    ],
  },
  /** Client-side chassis-tilt EMA. Layered ON TOP of the host's
   *  HOST SERVER TILT EMA — sim-side smoothing reduces triangle-jump
   *  noise before serialization, then this knob smooths further on
   *  the receiving client (per render frame, gliding toward each
   *  snapshot's value the same way position drift glides toward
   *  target.x). SNAP = no client smoothing, identical to the
   *  pre-feature behavior. */
  tiltEma: {
    default: 'fast' as const,
    options: [
      { value: 'snap' as const, label: 'SNAP' },
      { value: 'fast' as const, label: 'FAST' },
      { value: 'mid' as const, label: 'MED' },
      { value: 'slow' as const, label: 'SLOW' },
    ],
  },
  legsRadius: { default: false },
  cameraSmooth: {
    default: 'mid' as const,
    options: [
      { value: 'snap' as const, label: 'SNAP' },
      { value: 'fast' as const, label: 'FAST' },
      { value: 'mid' as const, label: 'MID' },
      { value: 'slow' as const, label: 'SLOW' },
    ],
  },
  cameraFov: {
    default: CAMERA_FOV_DEGREES,
    options: [
      { value: 10 as const, label: '10' },
      { value: 20 as const, label: '20' },
      { value: 30 as const, label: '30' },
      { value: 60 as const, label: '60' },
      { value: 120 as const, label: '120' },
    ],
  },
  edgeScroll: { default: false },
  dragPan: { default: true },
  sounds: {
    default: {
      fire: false,
      hit: false,
      dead: false,
      beam: false,
      field: false,
      music: false,
    },
  },
  rangeToggles: { default: false },
  projRangeToggles: { default: false },
  unitRadiusToggles: { default: false },
  lobbyVisible: { default: { mobile: true, desktop: true } },
  waypointDetail: {
    default: 'simple' as const,
    options: [
      { value: 'simple' as const, label: 'SIMPLE' },
      { value: 'detailed' as const, label: 'DETAILED' },
    ],
  },
} as const satisfies ClientBarConfig;

// ── Constant arrays ──
export const SOUND_CATEGORIES: SoundCategory[] = [
  'fire',
  'hit',
  'dead',
  'beam',
  'field',
  'music',
];

export const RANGE_TYPES: RangeType[] = [
  'trackAcquire',
  'trackRelease',
  'engageAcquire',
  'engageRelease',
  'engageMinAcquire',
  'engageMinRelease',
  'build',
];

export const PROJ_RANGE_TYPES: ProjRangeType[] = [
  'collision',
  'explosion',
];

export const UNIT_RADIUS_TYPES: UnitRadiusType[] = ['visual', 'shot', 'push'];

// ── localStorage keys (module-private) ──
// Every key in this file is for the PLAYER CLIENT bar — namespace
// prefix `player-client-` makes that explicit in DevTools and lets
// the four bar namespaces (demo-battle, real-battle, host-server,
// player-client) be wiped/inspected independently. The previous
// `rts-*` keys are migrated on first load via `migrateKey()` so
// existing users don't lose their preferences across this rename.
const RENDER_MODE_STORAGE_KEY = 'player-client-render-mode';
const AUDIO_SCOPE_STORAGE_KEY = 'player-client-audio-scope';
const AUDIO_SMOOTHING_STORAGE_KEY = 'player-client-audio-smoothing';
const BURN_MARKS_STORAGE_KEY = 'player-client-burn-marks-v2';
const LOCOMOTION_MARKS_STORAGE_KEY = 'player-client-locomotion-marks';
const BEAM_SNAP_TO_TURRET_STORAGE_KEY = 'player-client-beam-snap-to-turret';
const TRIANGLE_DEBUG_STORAGE_KEY = 'player-client-triangle-debug';
const BUILD_GRID_DEBUG_STORAGE_KEY = 'player-client-build-grid-debug';
const DRIFT_MODE_STORAGE_KEY = 'player-client-drift-mode';
const PREDICTION_MODE_STORAGE_KEY = 'player-client-prediction-mode';
const TILT_EMA_MODE_STORAGE_KEY = 'player-client-tilt-ema-mode';
const SOUND_TOGGLES_STORAGE_KEY = 'player-client-sound-toggles';
const RANGE_TOGGLES_STORAGE_KEY = 'player-client-range-toggles';
const PROJ_RANGE_TOGGLES_STORAGE_KEY = 'player-client-proj-range-toggles';
const UNIT_RADIUS_TOGGLES_STORAGE_KEY = 'player-client-unit-radius-toggles';
const LEGS_RADIUS_STORAGE_KEY = 'player-client-legs-radius';
const CAMERA_SMOOTH_STORAGE_KEY = 'player-client-camera-smooth';
const CAMERA_FOV_STORAGE_KEY = 'player-client-camera-fov-degrees';
const EDGE_SCROLL_STORAGE_KEY = 'player-client-edge-scroll';
const DRAG_PAN_STORAGE_KEY = 'player-client-drag-pan';
// The "BUDGET ANNIHILATION" lobby modal IS the demo-battle pre-game
// view — its visibility belongs to the demo-battle namespace.
// Migration table below covers both prior locations (`rts-lobby-visible`
// from the original prefix and `player-client-lobby-visible` from the
// brief stop during the namespace rename).
const LOBBY_VISIBLE_STORAGE_KEY = 'demo-battle-lobby-visible';
const WAYPOINT_DETAIL_STORAGE_KEY = 'player-client-waypoint-detail';

// Migration table — old `rts-*` keys → new `player-client-*` keys.
// Run once at module init (inside `loadFromStorage` below) so the
// rename is invisible to existing users.
const LEGACY_KEY_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['rts-render-mode', RENDER_MODE_STORAGE_KEY],
  ['rts-audio-scope', AUDIO_SCOPE_STORAGE_KEY],
  ['rts-audio-smoothing', AUDIO_SMOOTHING_STORAGE_KEY],
  // The unified "ground marks" toggle was split into separate burn /
  // locomotion controls (with their own defaults), so the prior
  // single-key value is intentionally NOT migrated — each new toggle
  // starts from its own default. The legacy keys
  // `rts-burn-marks`, `player-client-burn-marks`, and
  // `player-client-ground-marks` are left as dead localStorage data;
  // they will eventually fall out as users press RESET CLIENT.
  ['rts-triangle-debug', TRIANGLE_DEBUG_STORAGE_KEY],
  ['rts-build-grid-debug', BUILD_GRID_DEBUG_STORAGE_KEY],
  ['rts-drift-mode', DRIFT_MODE_STORAGE_KEY],
  ['rts-sound-toggles', SOUND_TOGGLES_STORAGE_KEY],
  ['rts-range-toggles', RANGE_TOGGLES_STORAGE_KEY],
  ['rts-proj-range-toggles', PROJ_RANGE_TOGGLES_STORAGE_KEY],
  ['rts-unit-radius-toggles', UNIT_RADIUS_TOGGLES_STORAGE_KEY],
  ['rts-legs-radius', LEGS_RADIUS_STORAGE_KEY],
  ['rts-camera-smooth', CAMERA_SMOOTH_STORAGE_KEY],
  ['rts-camera-fov-degrees', CAMERA_FOV_STORAGE_KEY],
  ['rts-edge-scroll', EDGE_SCROLL_STORAGE_KEY],
  ['rts-drag-pan', DRAG_PAN_STORAGE_KEY],
  // Lobby visibility migrated from BOTH historical homes — the
  // original `rts-` prefix AND the brief stop in `player-client-`.
  ['rts-lobby-visible', LOBBY_VISIBLE_STORAGE_KEY],
  ['player-client-lobby-visible', LOBBY_VISIBLE_STORAGE_KEY],
  ['rts-waypoint-detail', WAYPOINT_DETAIL_STORAGE_KEY],
];

// ── Runtime state ──
const _cd = CLIENT_CONFIG;
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
  visual: _cd.unitRadiusToggles.default,
  shot: _cd.unitRadiusToggles.default,
  push: _cd.unitRadiusToggles.default,
};
// Whether to render the per-leg "rest circle" (the chassis-local
// circle each foot wanders inside before snapping to the opposite
// edge).
let currentLegsRadius: boolean = _cd.legsRadius.default;
// 3D orbit camera EMA mode for zoom AND pan:
//   'snap' = inputs apply immediately, no animation.
//   'fast' = small EMA tau (~50 ms) — quick settle, still eased.
//   'mid'  = medium EMA tau (~120 ms) — default-feeling smoothness.
//   'slow' = large EMA tau (~400 ms) — deliberate, weighty feel.
//
// Both wheel zoom and pan-drag feed the same EMA, so they animate
// simultaneously without fighting each other.
let currentCameraSmoothMode: CameraSmoothMode = _cd.cameraSmooth.default;
let currentCameraFovDegrees: CameraFovDegrees = _cd.cameraFov.default;
let currentAudioScope: AudioScope = _cd.audio.default;
let currentAudioSmoothing: boolean = _cd.audioSmoothing.default;
let currentBurnMarks: boolean = _cd.burnMarks.default;
let currentLocomotionMarks: boolean = _cd.locomotionMarks.default;
let currentBeamSnapToTurret: boolean = _cd.beamSnapToTurret.default;
let currentTriangleDebug: boolean = _cd.triangleDebug.default;
let currentBuildGridDebug: boolean = _cd.buildGridDebug.default;
let currentDriftMode: DriftMode = _cd.driftMode.default;
let currentPredictionMode: PredictionMode = _cd.predictionMode.default;
let currentClientTiltEmaMode: DriftMode = _cd.tiltEma.default;
const currentSoundToggles: Record<SoundCategory, boolean> = {
  ..._cd.sounds.default,
};
let currentEdgeScrollEnabled: boolean = _cd.edgeScroll.default;
let currentDragPanEnabled: boolean = _cd.dragPan.default;
const _isMobile = typeof navigator !== 'undefined' &&
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
let currentLobbyVisible: boolean = _isMobile
  ? _cd.lobbyVisible.default.mobile
  : _cd.lobbyVisible.default.desktop;

function isCameraFovDegrees(value: number): value is CameraFovDegrees {
  return _cd.cameraFov.options.some((opt) => opt.value === value);
}

// ── Load from localStorage on module init ──
// Each read is independent — a bad JSON value or throw from ONE key
// must not prevent every later key from loading. (Previous revision
// wrapped every read in one try/catch and the renderer-mode load was
// dead last, so corrupted sound-toggles JSON silently disabled the
// 2D/3D persistence.) readPersisted swallows getItem exceptions; the
// JSON.parse blocks get their own per-key try so a malformed entry is
// just ignored instead of poisoning the loader.
function loadFromStorage(): void {
  // Run the legacy `rts-*` → `player-client-*` migration once before
  // we read anything. Idempotent: if the new key already exists the
  // old one is just deleted; if neither exists nothing happens.
  for (const [oldK, newK] of LEGACY_KEY_MIGRATIONS) migrateKey(oldK, newK);
  const storedRenderMode = readPersisted(RENDER_MODE_STORAGE_KEY);
  if (
    storedRenderMode &&
    (storedRenderMode === 'window' ||
      storedRenderMode === 'padded' ||
      storedRenderMode === 'all')
  ) {
    currentRenderMode = storedRenderMode;
  }
  const storedAudioScope = readPersisted(AUDIO_SCOPE_STORAGE_KEY);
  if (
    storedAudioScope &&
    (storedAudioScope === 'off' ||
      storedAudioScope === 'window' ||
      storedAudioScope === 'padded' ||
      storedAudioScope === 'all')
  ) {
    currentAudioScope = storedAudioScope;
  }
  const storedAudioSmoothing = readPersisted(AUDIO_SMOOTHING_STORAGE_KEY);
  if (storedAudioSmoothing !== null) {
    currentAudioSmoothing = storedAudioSmoothing === 'true';
  }
  const storedBurnMarks = readPersisted(BURN_MARKS_STORAGE_KEY);
  if (storedBurnMarks !== null) {
    currentBurnMarks = storedBurnMarks === 'true';
  }
  const storedLocomotionMarks = readPersisted(LOCOMOTION_MARKS_STORAGE_KEY);
  if (storedLocomotionMarks !== null) {
    currentLocomotionMarks = storedLocomotionMarks === 'true';
  }
  const storedBeamSnapToTurret = readPersisted(BEAM_SNAP_TO_TURRET_STORAGE_KEY);
  if (storedBeamSnapToTurret !== null) {
    currentBeamSnapToTurret = storedBeamSnapToTurret === 'true';
  }
  const storedTriangleDebug = readPersisted(TRIANGLE_DEBUG_STORAGE_KEY);
  if (storedTriangleDebug !== null) {
    currentTriangleDebug = storedTriangleDebug === 'true';
  }
  const storedBuildGridDebug = readPersisted(BUILD_GRID_DEBUG_STORAGE_KEY);
  if (storedBuildGridDebug !== null) {
    currentBuildGridDebug = storedBuildGridDebug === 'true';
  }
  const storedLegsRadius = readPersisted(LEGS_RADIUS_STORAGE_KEY);
  if (storedLegsRadius !== null) {
    currentLegsRadius = storedLegsRadius === 'true';
  }
  const storedCameraSmooth = readPersisted(CAMERA_SMOOTH_STORAGE_KEY);
  if (
    storedCameraSmooth === 'snap'
    || storedCameraSmooth === 'fast'
    || storedCameraSmooth === 'mid'
    || storedCameraSmooth === 'slow'
  ) {
    currentCameraSmoothMode = storedCameraSmooth;
  } else if (storedCameraSmooth === 'true') {
    // Backward-compat: the old boolean toggle wrote 'true' / 'false';
    // map 'true' (smooth-on) to the configured smooth default.
    currentCameraSmoothMode = _cd.cameraSmooth.default;
  } else if (storedCameraSmooth === 'false') {
    currentCameraSmoothMode = 'snap';
  }
  const storedCameraFov = readPersisted(CAMERA_FOV_STORAGE_KEY);
  if (storedCameraFov !== null) {
    const parsed = Number(storedCameraFov);
    if (Number.isFinite(parsed) && isCameraFovDegrees(parsed)) {
      currentCameraFovDegrees = parsed;
    }
  }
  const storedDriftMode = readPersisted(DRIFT_MODE_STORAGE_KEY);
  if (
    storedDriftMode &&
    (storedDriftMode === 'snap' ||
      storedDriftMode === 'fast' ||
      storedDriftMode === 'mid' ||
      storedDriftMode === 'slow')
  ) {
    currentDriftMode = storedDriftMode;
  }
  const storedPredictionMode = readPersisted(PREDICTION_MODE_STORAGE_KEY);
  if (
    storedPredictionMode === 'pos' ||
    storedPredictionMode === 'vel' ||
    storedPredictionMode === 'acc'
  ) {
    currentPredictionMode = storedPredictionMode;
  }
  const storedClientTilt = readPersisted(TILT_EMA_MODE_STORAGE_KEY);
  if (
    storedClientTilt &&
    (storedClientTilt === 'snap' ||
      storedClientTilt === 'fast' ||
      storedClientTilt === 'mid' ||
      storedClientTilt === 'slow')
  ) {
    currentClientTiltEmaMode = storedClientTilt;
  }
  const storedSoundToggles = readPersisted(SOUND_TOGGLES_STORAGE_KEY);
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
  const storedRangeToggles = readPersisted(RANGE_TOGGLES_STORAGE_KEY);
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
  const storedProjRangeToggles = readPersisted(PROJ_RANGE_TOGGLES_STORAGE_KEY);
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
  const storedUnitRadiusToggles = readPersisted(UNIT_RADIUS_TOGGLES_STORAGE_KEY);
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
  const storedEdgeScroll = readPersisted(EDGE_SCROLL_STORAGE_KEY);
  if (storedEdgeScroll !== null) {
    currentEdgeScrollEnabled = storedEdgeScroll === 'true';
  }
  const storedDragPan = readPersisted(DRAG_PAN_STORAGE_KEY);
  if (storedDragPan !== null) {
    currentDragPanEnabled = storedDragPan === 'true';
  }
  const storedLobbyVisible = readPersisted(LOBBY_VISIBLE_STORAGE_KEY);
  if (storedLobbyVisible !== null) {
    currentLobbyVisible = storedLobbyVisible === 'true';
  }
  const storedWaypointDetail = readPersisted(WAYPOINT_DETAIL_STORAGE_KEY);
  if (storedWaypointDetail === 'simple' || storedWaypointDetail === 'detailed') {
    currentWaypointDetail = storedWaypointDetail;
  }
}

// NOTE: loadFromStorage() is invoked at the very bottom of this file,
// after every module-level `let current*` declaration — otherwise the
// waypoint-detail block below would hit a temporal-dead-zone
// ReferenceError because that state variable is declared later in the file.

export function getGraphicsConfig(): GraphicsConfig {
  return PLAYER_CLIENT_MAX_GRAPHICS_CONFIG;
}

export function getGraphicsConfigFor(
  _quality: ConcreteGraphicsQuality,
): GraphicsConfig {
  return getGraphicsConfig();
}

export function getRenderMode(): RenderMode {
  return currentRenderMode;
}

export function setRenderMode(mode: RenderMode): void {
  currentRenderMode = mode;
  persist(RENDER_MODE_STORAGE_KEY, mode);
}

export function getRangeToggle(type: RangeType): boolean {
  return currentRangeToggles[type];
}

export function setRangeToggle(type: RangeType, show: boolean): void {
  currentRangeToggles[type] = show;
  persistJson(RANGE_TOGGLES_STORAGE_KEY, currentRangeToggles);
}

export function anyRangeToggleActive(): boolean {
  return RANGE_TYPES.some((rt) => currentRangeToggles[rt]);
}

export function getProjRangeToggle(type: ProjRangeType): boolean {
  return currentProjRangeToggles[type];
}

export function setProjRangeToggle(type: ProjRangeType, show: boolean): void {
  currentProjRangeToggles[type] = show;
  persistJson(PROJ_RANGE_TOGGLES_STORAGE_KEY, currentProjRangeToggles);
}

export function anyProjRangeToggleActive(): boolean {
  return PROJ_RANGE_TYPES.some((prt) => currentProjRangeToggles[prt]);
}

export function getUnitRadiusToggle(type: UnitRadiusType): boolean {
  return currentUnitRadiusToggles[type];
}

export function setUnitRadiusToggle(type: UnitRadiusType, show: boolean): void {
  currentUnitRadiusToggles[type] = show;
  persistJson(UNIT_RADIUS_TOGGLES_STORAGE_KEY, currentUnitRadiusToggles);
}

export function anyUnitRadiusToggleActive(): boolean {
  return UNIT_RADIUS_TYPES.some((urt) => currentUnitRadiusToggles[urt]);
}

export function getLegsRadiusToggle(): boolean {
  return currentLegsRadius;
}

export function setLegsRadiusToggle(show: boolean): void {
  currentLegsRadius = show;
  persist(LEGS_RADIUS_STORAGE_KEY, String(show));
}

export function getCameraSmoothMode(): CameraSmoothMode {
  return currentCameraSmoothMode;
}

export function setCameraSmoothMode(mode: CameraSmoothMode): void {
  currentCameraSmoothMode = mode;
  persist(CAMERA_SMOOTH_STORAGE_KEY, mode);
}

export function getCameraFovDegrees(): CameraFovDegrees {
  return currentCameraFovDegrees;
}

export function setCameraFovDegrees(fov: CameraFovDegrees): void {
  currentCameraFovDegrees = fov;
  persist(CAMERA_FOV_STORAGE_KEY, String(fov));
}

export function getAudioScope(): AudioScope {
  return currentAudioScope;
}

export function setAudioScope(scope: AudioScope): void {
  currentAudioScope = scope;
  persist(AUDIO_SCOPE_STORAGE_KEY, scope);
}

export function getAudioSmoothing(): boolean {
  return currentAudioSmoothing;
}

export function setAudioSmoothing(enabled: boolean): void {
  currentAudioSmoothing = enabled;
  persist(AUDIO_SMOOTHING_STORAGE_KEY, String(enabled));
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
  persist(BURN_MARKS_STORAGE_KEY, String(enabled));
}

/** Locomotion-mark toggle: wheel, tread, and footstep prints from
 *  unit movement. Default on — these decay quickly (≈1s base) and
 *  the motion cues read as part of the unit silhouettes. */
export function getLocomotionMarks(): boolean {
  return currentLocomotionMarks;
}

export function setLocomotionMarks(enabled: boolean): void {
  currentLocomotionMarks = enabled;
  persist(LOCOMOTION_MARKS_STORAGE_KEY, String(enabled));
}

export function getBeamSnapToTurret(): boolean {
  return currentBeamSnapToTurret;
}

export function setBeamSnapToTurret(enabled: boolean): void {
  currentBeamSnapToTurret = enabled;
  persist(BEAM_SNAP_TO_TURRET_STORAGE_KEY, String(enabled));
}

export function getTriangleDebug(): boolean {
  return currentTriangleDebug;
}

export function setTriangleDebug(enabled: boolean): void {
  currentTriangleDebug = enabled;
  persist(TRIANGLE_DEBUG_STORAGE_KEY, String(enabled));
}

export function getBuildGridDebug(): boolean {
  return currentBuildGridDebug;
}

export function setBuildGridDebug(enabled: boolean): void {
  currentBuildGridDebug = enabled;
  persist(BUILD_GRID_DEBUG_STORAGE_KEY, String(enabled));
}

export function getDriftMode(): DriftMode {
  return currentDriftMode;
}

export function setDriftMode(mode: DriftMode): void {
  currentDriftMode = mode;
  persist(DRIFT_MODE_STORAGE_KEY, mode);
}

export function getPredictionMode(): PredictionMode {
  return currentPredictionMode;
}

export function setPredictionMode(mode: PredictionMode): void {
  currentPredictionMode = mode;
  persist(PREDICTION_MODE_STORAGE_KEY, mode);
}

/** Active client-side chassis-tilt EMA mode. Returns the user's bar
 *  selection on the PLAYER CLIENT bar; reads as 'snap' (no smoothing)
 *  by default. Reused for the per-frame predict-side EMA in
 *  ClientViewState that glides each unit's tilt toward the snapshot's
 *  target.surfaceNormal. */
export function getClientTiltEmaMode(): DriftMode {
  return currentClientTiltEmaMode;
}

export function setClientTiltEmaMode(mode: DriftMode): void {
  currentClientTiltEmaMode = mode;
  persist(TILT_EMA_MODE_STORAGE_KEY, mode);
}

export function getSoundToggle(category: SoundCategory): boolean {
  return currentSoundToggles[category];
}

export function setSoundToggle(
  category: SoundCategory,
  enabled: boolean,
): void {
  currentSoundToggles[category] = enabled;
  persistJson(SOUND_TOGGLES_STORAGE_KEY, currentSoundToggles);
}

export function getEdgeScrollEnabled(): boolean {
  return currentEdgeScrollEnabled;
}

export function setEdgeScrollEnabled(enabled: boolean): void {
  currentEdgeScrollEnabled = enabled;
  persist(EDGE_SCROLL_STORAGE_KEY, String(enabled));
}

export function getDragPanEnabled(): boolean {
  return currentDragPanEnabled;
}

export function setDragPanEnabled(enabled: boolean): void {
  currentDragPanEnabled = enabled;
  persist(DRAG_PAN_STORAGE_KEY, String(enabled));
}

export function getLobbyVisible(): boolean {
  return currentLobbyVisible;
}

export function setLobbyVisible(visible: boolean): void {
  currentLobbyVisible = visible;
  persist(LOBBY_VISIBLE_STORAGE_KEY, String(visible));
}

// ── Waypoint detail mode ──

let currentWaypointDetail: WaypointDetail = _cd.waypointDetail.default;

export function getWaypointDetail(): WaypointDetail {
  return currentWaypointDetail;
}

export function setWaypointDetail(mode: WaypointDetail): void {
  currentWaypointDetail = mode;
  persist(WAYPOINT_DETAIL_STORAGE_KEY, mode);
}

// Run the localStorage loader AFTER every state variable above has
// been declared. Keeping this at the bottom is load-bearing — moving
// it back near the loader definition will crash on module init.
loadFromStorage();
