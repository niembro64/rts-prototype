import type {
  GraphicsQuality,
  ConcreteGraphicsQuality,
  GraphicsConfig,
  RenderMode,
  LegStyle,
  BeamStyle,
  ForceFieldStyle,
  ProjectileStyle,
  FireExplosionStyle,
  DeathExplosionStyle,
  TurretStyle,
  ForceTurretStyle,
  UnitShape,
} from './types/graphics';
import type { ClientBarConfig } from './types/client';
import type {
  AudioScope,
  DriftMode,
  GridOverlay,
  SoundCategory,
  RangeType,
  ProjRangeType,
  UnitRadiusType,
} from './types/client';
import type { RendererMode } from './types/game';
import { persist, persistJson, readPersisted } from './persistence';
import {
  PLAYER_CLIENT_GRAPHICS_LEVEL_OF_DETAIL,
  LOD_THRESHOLDS,
  LOD_HYSTERESIS,
} from '@/lodConfig';

export const CLIENT_CONFIG = {
  graphics: {
    default: 'auto' as const,
    options: [
      { value: 'min' as const, label: 'MIN' },
      { value: 'low' as const, label: 'LOW' },
      { value: 'medium' as const, label: 'MED' },
      { value: 'high' as const, label: 'HI' },
      { value: 'max' as const, label: 'MAX' },
    ],
  },
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
  burnMarks: { default: true },
  driftMode: { default: 'fast' as const },
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
  lobbyVisible: { default: { mobile: false, desktop: false } },
  gridOverlay: {
    default: 'low' as const,
    options: [
      { value: 'off' as const, label: 'OFF' },
      { value: 'low' as const, label: 'LOW' },
      { value: 'high' as const, label: 'HI' },
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
  'build',
];

export const PROJ_RANGE_TYPES: ProjRangeType[] = [
  'collision',
  'primary',
  'secondary',
];

export const UNIT_RADIUS_TYPES: UnitRadiusType[] = ['visual', 'shot', 'push'];

// ── Graphics quality configs (built from lodConfig) ──
const D = PLAYER_CLIENT_GRAPHICS_LEVEL_OF_DETAIL;
const GRAPHICS_CONFIGS: Record<ConcreteGraphicsQuality, GraphicsConfig> = {
  min: {
    unitShape: D.UNIT_SHAPE.min as UnitShape,
    legs: D.LEGS.min as LegStyle,
    treadsAnimated: D.TREADS_ANIMATED.min,
    chassisDetail: D.CHASSIS_DETAIL.min,
    paletteShading: D.PALETTE_SHADING.min,
    turretStyle: D.TURRET_STYLE.min as TurretStyle,
    forceTurretStyle: D.FORCE_TURRET_STYLE.min as ForceTurretStyle,
    barrelSpin: D.BARREL_SPIN.min,
    beamStyle: D.BEAM_STYLE.min as BeamStyle,
    beamGlow: D.BEAM_GLOW.min,
    antialias: D.ANTIALIAS.min,
    burnMarkAlphaCutoff: D.BURN_MARK_ALPHA_CUTOFF.min,
    burnMarkFramesSkip: D.BURN_MARK_FRAMES_SKIP.min,
    beamPathFramesSkip: D.BEAM_PATH_FRAMES_SKIP.min,
    forceFieldStyle: D.FORCE_FIELD_STYLE.min as ForceFieldStyle,
    projectileStyle: D.PROJECTILE_STYLE.min as ProjectileStyle,
    fireExplosionStyle: D.FIRE_EXPLOSION_STYLE.min as FireExplosionStyle,
    deathExplosionStyle: D.DEATH_EXPLOSION_STYLE.min as DeathExplosionStyle,
  },
  low: {
    unitShape: D.UNIT_SHAPE.low as UnitShape,
    legs: D.LEGS.low as LegStyle,
    treadsAnimated: D.TREADS_ANIMATED.low,
    chassisDetail: D.CHASSIS_DETAIL.low,
    paletteShading: D.PALETTE_SHADING.low,
    turretStyle: D.TURRET_STYLE.low as TurretStyle,
    forceTurretStyle: D.FORCE_TURRET_STYLE.low as ForceTurretStyle,
    barrelSpin: D.BARREL_SPIN.low,
    beamStyle: D.BEAM_STYLE.low as BeamStyle,
    beamGlow: D.BEAM_GLOW.low,
    antialias: D.ANTIALIAS.low,
    burnMarkAlphaCutoff: D.BURN_MARK_ALPHA_CUTOFF.low,
    burnMarkFramesSkip: D.BURN_MARK_FRAMES_SKIP.low,
    beamPathFramesSkip: D.BEAM_PATH_FRAMES_SKIP.low,
    forceFieldStyle: D.FORCE_FIELD_STYLE.low as ForceFieldStyle,
    projectileStyle: D.PROJECTILE_STYLE.low as ProjectileStyle,
    fireExplosionStyle: D.FIRE_EXPLOSION_STYLE.low as FireExplosionStyle,
    deathExplosionStyle: D.DEATH_EXPLOSION_STYLE.low as DeathExplosionStyle,
  },
  medium: {
    unitShape: D.UNIT_SHAPE.medium as UnitShape,
    legs: D.LEGS.medium as LegStyle,
    treadsAnimated: D.TREADS_ANIMATED.medium,
    chassisDetail: D.CHASSIS_DETAIL.medium,
    paletteShading: D.PALETTE_SHADING.medium,
    turretStyle: D.TURRET_STYLE.medium as TurretStyle,
    forceTurretStyle: D.FORCE_TURRET_STYLE.medium as ForceTurretStyle,
    barrelSpin: D.BARREL_SPIN.medium,
    beamStyle: D.BEAM_STYLE.medium as BeamStyle,
    beamGlow: D.BEAM_GLOW.medium,
    antialias: D.ANTIALIAS.medium,
    burnMarkAlphaCutoff: D.BURN_MARK_ALPHA_CUTOFF.medium,
    burnMarkFramesSkip: D.BURN_MARK_FRAMES_SKIP.medium,
    beamPathFramesSkip: D.BEAM_PATH_FRAMES_SKIP.medium,
    forceFieldStyle: D.FORCE_FIELD_STYLE.medium as ForceFieldStyle,
    projectileStyle: D.PROJECTILE_STYLE.medium as ProjectileStyle,
    fireExplosionStyle: D.FIRE_EXPLOSION_STYLE.medium as FireExplosionStyle,
    deathExplosionStyle: D.DEATH_EXPLOSION_STYLE.medium as DeathExplosionStyle,
  },
  high: {
    unitShape: D.UNIT_SHAPE.high as UnitShape,
    legs: D.LEGS.high as LegStyle,
    treadsAnimated: D.TREADS_ANIMATED.high,
    chassisDetail: D.CHASSIS_DETAIL.high,
    paletteShading: D.PALETTE_SHADING.high,
    turretStyle: D.TURRET_STYLE.high as TurretStyle,
    forceTurretStyle: D.FORCE_TURRET_STYLE.high as ForceTurretStyle,
    barrelSpin: D.BARREL_SPIN.high,
    beamStyle: D.BEAM_STYLE.high as BeamStyle,
    beamGlow: D.BEAM_GLOW.high,
    antialias: D.ANTIALIAS.high,
    burnMarkAlphaCutoff: D.BURN_MARK_ALPHA_CUTOFF.high,
    burnMarkFramesSkip: D.BURN_MARK_FRAMES_SKIP.high,
    beamPathFramesSkip: D.BEAM_PATH_FRAMES_SKIP.high,
    forceFieldStyle: D.FORCE_FIELD_STYLE.high as ForceFieldStyle,
    projectileStyle: D.PROJECTILE_STYLE.high as ProjectileStyle,
    fireExplosionStyle: D.FIRE_EXPLOSION_STYLE.high as FireExplosionStyle,
    deathExplosionStyle: D.DEATH_EXPLOSION_STYLE.high as DeathExplosionStyle,
  },
  max: {
    unitShape: D.UNIT_SHAPE.max as UnitShape,
    legs: D.LEGS.max as LegStyle,
    treadsAnimated: D.TREADS_ANIMATED.max,
    chassisDetail: D.CHASSIS_DETAIL.max,
    paletteShading: D.PALETTE_SHADING.max,
    turretStyle: D.TURRET_STYLE.max as TurretStyle,
    forceTurretStyle: D.FORCE_TURRET_STYLE.max as ForceTurretStyle,
    barrelSpin: D.BARREL_SPIN.max,
    beamStyle: D.BEAM_STYLE.max as BeamStyle,
    beamGlow: D.BEAM_GLOW.max,
    antialias: D.ANTIALIAS.max,
    burnMarkAlphaCutoff: D.BURN_MARK_ALPHA_CUTOFF.max,
    burnMarkFramesSkip: D.BURN_MARK_FRAMES_SKIP.max,
    beamPathFramesSkip: D.BEAM_PATH_FRAMES_SKIP.max,
    forceFieldStyle: D.FORCE_FIELD_STYLE.max as ForceFieldStyle,
    projectileStyle: D.PROJECTILE_STYLE.max as ProjectileStyle,
    fireExplosionStyle: D.FIRE_EXPLOSION_STYLE.max as FireExplosionStyle,
    deathExplosionStyle: D.DEATH_EXPLOSION_STYLE.max as DeathExplosionStyle,
  },
};

// ── localStorage keys (module-private) ──
const STORAGE_KEY = 'rts-graphics-quality';
const RENDER_MODE_STORAGE_KEY = 'rts-render-mode';
const AUDIO_SCOPE_STORAGE_KEY = 'rts-audio-scope';
const AUDIO_SMOOTHING_STORAGE_KEY = 'rts-audio-smoothing';
const BURN_MARKS_STORAGE_KEY = 'rts-burn-marks';
const DRIFT_MODE_STORAGE_KEY = 'rts-drift-mode';
const SOUND_TOGGLES_STORAGE_KEY = 'rts-sound-toggles';
const RANGE_TOGGLES_STORAGE_KEY = 'rts-range-toggles';
const PROJ_RANGE_TOGGLES_STORAGE_KEY = 'rts-proj-range-toggles';
const UNIT_RADIUS_TOGGLES_STORAGE_KEY = 'rts-unit-radius-toggles';
const EDGE_SCROLL_STORAGE_KEY = 'rts-edge-scroll';
const DRAG_PAN_STORAGE_KEY = 'rts-drag-pan';
const LOBBY_VISIBLE_STORAGE_KEY = 'rts-lobby-visible';
const GRID_OVERLAY_STORAGE_KEY = 'rts-grid-overlay';
const RENDERER_MODE_STORAGE_KEY = 'rts-renderer-mode';

// ── Runtime state ──
const _cd = CLIENT_CONFIG;
let currentQuality: GraphicsQuality = _cd.graphics.default;
let currentRenderMode: RenderMode = _cd.render.default;
const currentRangeToggles: Record<RangeType, boolean> = {
  trackAcquire: _cd.rangeToggles.default,
  trackRelease: _cd.rangeToggles.default,
  engageAcquire: _cd.rangeToggles.default,
  engageRelease: _cd.rangeToggles.default,
  build: _cd.rangeToggles.default,
};
const currentProjRangeToggles: Record<ProjRangeType, boolean> = {
  collision: _cd.projRangeToggles.default,
  primary: _cd.projRangeToggles.default,
  secondary: _cd.projRangeToggles.default,
};
const currentUnitRadiusToggles: Record<UnitRadiusType, boolean> = {
  visual: _cd.unitRadiusToggles.default,
  shot: _cd.unitRadiusToggles.default,
  push: _cd.unitRadiusToggles.default,
};
let currentAudioScope: AudioScope = _cd.audio.default;
let currentAudioSmoothing: boolean = _cd.audioSmoothing.default;
let currentBurnMarks: boolean = _cd.burnMarks.default;
let currentDriftMode: DriftMode = _cd.driftMode.default;
const currentSoundToggles: Record<SoundCategory, boolean> = {
  ..._cd.sounds.default,
};
let currentEdgeScrollEnabled: boolean = _cd.edgeScroll.default;
let currentDragPanEnabled: boolean = _cd.dragPan.default;
// Renderer mode (2d Pixi / 3d Three.js). No default in CLIENT_CONFIG
// because the initial mode is resolved by App.vue (URL path → localStorage
// → fallback '2d'); App.vue calls setRendererMode before this module's
// first read so `currentRendererMode` always reflects the chosen value.
let currentRendererMode: RendererMode = '2d';
const _isMobile = typeof navigator !== 'undefined' &&
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
let currentLobbyVisible: boolean = _isMobile
  ? _cd.lobbyVisible.default.mobile
  : _cd.lobbyVisible.default.desktop;
let currentBottomBarsHeight: number = 0;
let currentZoom: number = 1.0;
let currentTpsRatio: number = 1.0;
let currentFpsRatio: number = 1.0;
let prevZoomRank: number = 4;
let prevTpsRank: number = 4;
let prevFpsRank: number = 4;
let localServerRunning: boolean = false;

// ── Load from localStorage on module init ──
// Each read is independent — a bad JSON value or throw from ONE key
// must not prevent every later key from loading. (Previous revision
// wrapped every read in one try/catch and the renderer-mode load was
// dead last, so corrupted sound-toggles JSON silently disabled the
// 2D/3D persistence.) readPersisted swallows getItem exceptions; the
// JSON.parse blocks get their own per-key try so a malformed entry is
// just ignored instead of poisoning the loader.
function loadFromStorage(): void {
  const storedQuality = readPersisted(STORAGE_KEY);
  if (
    storedQuality &&
    (storedQuality === 'auto' ||
      storedQuality === 'auto-zoom' ||
      storedQuality === 'auto-tps' ||
      storedQuality === 'auto-fps' ||
      storedQuality === 'min' ||
      storedQuality === 'low' ||
      storedQuality === 'medium' ||
      storedQuality === 'high' ||
      storedQuality === 'max')
  ) {
    currentQuality = storedQuality;
  }
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
  const storedGridOverlay = readPersisted(GRID_OVERLAY_STORAGE_KEY);
  if (
    storedGridOverlay &&
    (storedGridOverlay === 'off' ||
      storedGridOverlay === 'low' ||
      storedGridOverlay === 'high')
  ) {
    currentGridOverlay = storedGridOverlay;
  }
  const storedRendererMode = readPersisted(RENDERER_MODE_STORAGE_KEY);
  if (storedRendererMode === '2d' || storedRendererMode === '3d') {
    currentRendererMode = storedRendererMode;
  }
}

loadFromStorage();

// ── Getters / setters ──

export function getGraphicsQuality(): GraphicsQuality {
  return currentQuality;
}

export function setGraphicsQuality(quality: GraphicsQuality): void {
  currentQuality = quality;
  persist(STORAGE_KEY, quality);
}

export function setCurrentZoom(zoom: number): void {
  currentZoom = zoom;
}

export function setCurrentTpsRatio(ratio: number): void {
  currentTpsRatio = ratio;
}

export function setCurrentFpsRatio(ratio: number): void {
  currentFpsRatio = ratio;
}

export function setLocalServerRunning(running: boolean): void {
  localServerRunning = running;
}

export function getLocalServerRunning(): boolean {
  return localServerRunning;
}

const RANK_TO_QUALITY: ConcreteGraphicsQuality[] = [
  'min', 'low', 'medium', 'high', 'max',
];

function toArray(t: { low: number; medium: number; high: number; max: number }): number[] {
  return [t.low, t.medium, t.high, t.max];
}

const ZOOM_THRESHOLDS = toArray(LOD_THRESHOLDS.zoom);
const TPS_THRESHOLDS = toArray(LOD_THRESHOLDS.tps);
const FPS_THRESHOLDS = toArray(LOD_THRESHOLDS.fps);

function ratioToRank(
  ratio: number,
  thresholds: number[],
  prevRank: number,
  hysteresis: number,
): number {
  let rank = 0;
  for (let i = 0; i < thresholds.length; i++) {
    const threshold = thresholds[i];
    const effectiveThreshold = i + 1 > prevRank
      ? threshold + hysteresis
      : threshold - hysteresis;
    if (ratio >= effectiveThreshold) rank = i + 1;
  }
  return rank;
}

function zoomToRank(prevRank: number): number {
  const h = LOD_HYSTERESIS.zoom;
  let rank = 0;
  for (let i = 0; i < ZOOM_THRESHOLDS.length; i++) {
    const threshold = ZOOM_THRESHOLDS[i];
    const ratio = currentZoom / threshold;
    const effectiveRatio = i + 1 > prevRank ? 1 + h : 1 - h;
    if (ratio >= effectiveRatio) rank = i + 1;
  }
  return rank;
}

export function getEffectiveQuality(): ConcreteGraphicsQuality {
  switch (currentQuality) {
    case 'auto': {
      prevZoomRank = zoomToRank(prevZoomRank);
      prevFpsRank = ratioToRank(currentFpsRatio, FPS_THRESHOLDS, prevFpsRank, LOD_HYSTERESIS.fps);
      if (localServerRunning) {
        prevTpsRank = ratioToRank(currentTpsRatio, TPS_THRESHOLDS, prevTpsRank, LOD_HYSTERESIS.tps);
        return RANK_TO_QUALITY[Math.min(prevZoomRank, prevTpsRank, prevFpsRank)];
      }
      return RANK_TO_QUALITY[Math.min(prevZoomRank, prevFpsRank)];
    }
    case 'auto-zoom':
      prevZoomRank = zoomToRank(prevZoomRank);
      return RANK_TO_QUALITY[prevZoomRank];
    case 'auto-tps':
      prevTpsRank = ratioToRank(currentTpsRatio, TPS_THRESHOLDS, prevTpsRank, LOD_HYSTERESIS.tps);
      return RANK_TO_QUALITY[prevTpsRank];
    case 'auto-fps':
      prevFpsRank = ratioToRank(currentFpsRatio, FPS_THRESHOLDS, prevFpsRank, LOD_HYSTERESIS.fps);
      return RANK_TO_QUALITY[prevFpsRank];
    case 'min':
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return currentQuality;
  }
}

export function getGraphicsConfig(): GraphicsConfig {
  return GRAPHICS_CONFIGS[getEffectiveQuality()];
}

export function getGraphicsConfigFor(
  quality: ConcreteGraphicsQuality,
): GraphicsConfig {
  return GRAPHICS_CONFIGS[quality];
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

export function getBurnMarks(): boolean {
  return currentBurnMarks;
}

export function setBurnMarks(enabled: boolean): void {
  currentBurnMarks = enabled;
  persist(BURN_MARKS_STORAGE_KEY, String(enabled));
}

export function getDriftMode(): DriftMode {
  return currentDriftMode;
}

export function setDriftMode(mode: DriftMode): void {
  currentDriftMode = mode;
  persist(DRIFT_MODE_STORAGE_KEY, mode);
}

/** Persisted renderer choice (2d Pixi / 3d Three.js). Read at module
 *  init from localStorage; App.vue calls setRendererMode when the URL
 *  is /2d or /3d to let the path override the stored value. */
export function getRendererMode(): RendererMode {
  return currentRendererMode;
}

export function setRendererMode(mode: RendererMode): void {
  currentRendererMode = mode;
  persist(RENDERER_MODE_STORAGE_KEY, mode);
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

export function getBottomBarsHeight(): number {
  return currentBottomBarsHeight;
}

export function setBottomBarsHeight(height: number): void {
  currentBottomBarsHeight = height;
}

export function getLobbyVisible(): boolean {
  return currentLobbyVisible;
}

export function setLobbyVisible(visible: boolean): void {
  currentLobbyVisible = visible;
  persist(LOBBY_VISIBLE_STORAGE_KEY, String(visible));
}

// ── Grid Overlay ──

const GRID_OVERLAY_INTENSITIES: Record<GridOverlay, number> = {
  off: 0.0,
  low: 0.1,
  high: 0.8,
};

let currentGridOverlay: GridOverlay = _cd.gridOverlay.default;

export function getGridOverlay(): GridOverlay {
  return currentGridOverlay;
}

export function getGridOverlayIntensity(): number {
  return GRID_OVERLAY_INTENSITIES[currentGridOverlay];
}

export function setGridOverlay(mode: GridOverlay): void {
  currentGridOverlay = mode;
  persist(GRID_OVERLAY_STORAGE_KEY, mode);
}
