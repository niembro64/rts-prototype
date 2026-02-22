/**
 * Graphics Quality Settings
 *
 * Controls visual fidelity vs performance tradeoffs.
 * Settings are persisted to localStorage.
 * All detail level definitions are centralized in config.ts GRAPHICS_DETAIL_DEFINITIONS.
 */

import { PLAYER_CLIENT_GRAPHICS_LEVEL_OF_DETAIL } from '@/lodConfig';
import {
  ZOOM_MIN,
  ZOOM_MAX,
} from '../../config';

export type GraphicsQuality =
  | 'auto'
  | 'min'
  | 'low'
  | 'medium'
  | 'high'
  | 'max';
export type RenderMode = 'window' | 'padded' | 'all';

export type BeamStyle = 'simple' | 'standard' | 'detailed' | 'complex';
export type ForceFieldStyle = 'minimal' | 'simple' | 'normal' | 'enhanced';
export type ProjectileStyle = 'dot' | 'core' | 'trail' | 'glow' | 'full';
export type FireExplosionStyle =
  | 'flash'
  | 'spark'
  | 'burst'
  | 'blaze'
  | 'inferno';
export type DeathExplosionStyle =
  | 'puff'
  | 'scatter'
  | 'shatter'
  | 'detonate'
  | 'obliterate';
export type TurretStyle = 'none' | 'simple' | 'full';
export type ForceTurretStyle = 'none' | 'simple' | 'full';
export type UnitShape = 'circles' | 'full';

export interface GraphicsConfig {
  unitShape: UnitShape;
  legs: 'none' | 'simple' | 'animated' | 'full';
  treadsAnimated: boolean;
  chassisDetail: boolean;
  paletteShading: boolean;
  turretStyle: TurretStyle;
  forceTurretStyle: ForceTurretStyle;
  barrelSpin: boolean;
  beamStyle: BeamStyle;
  beamGlow: boolean;
  antialias: boolean;
  burnMarkAlphaCutoff: number;
  burnMarkFramesSkip: number;
  forceFieldStyle: ForceFieldStyle;
  projectileStyle: ProjectileStyle;
  fireExplosionStyle: FireExplosionStyle;
  deathExplosionStyle: DeathExplosionStyle;
}

// Build configs from centralized definitions
const D = PLAYER_CLIENT_GRAPHICS_LEVEL_OF_DETAIL;
const GRAPHICS_CONFIGS: Record<
  Exclude<GraphicsQuality, 'auto'>,
  GraphicsConfig
> = {
  min: {
    unitShape: D.UNIT_SHAPE.min as UnitShape,
    legs: D.LEGS.min as 'none' | 'simple' | 'animated' | 'full',
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
    forceFieldStyle: D.FORCE_FIELD_STYLE.min as ForceFieldStyle,
    projectileStyle: D.PROJECTILE_STYLE.min as ProjectileStyle,
    fireExplosionStyle: D.FIRE_EXPLOSION_STYLE.min as FireExplosionStyle,
    deathExplosionStyle: D.DEATH_EXPLOSION_STYLE.min as DeathExplosionStyle,
  },
  low: {
    unitShape: D.UNIT_SHAPE.low as UnitShape,
    legs: D.LEGS.low as 'none' | 'simple' | 'animated' | 'full',
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
    forceFieldStyle: D.FORCE_FIELD_STYLE.low as ForceFieldStyle,
    projectileStyle: D.PROJECTILE_STYLE.low as ProjectileStyle,
    fireExplosionStyle: D.FIRE_EXPLOSION_STYLE.low as FireExplosionStyle,
    deathExplosionStyle: D.DEATH_EXPLOSION_STYLE.low as DeathExplosionStyle,
  },
  medium: {
    unitShape: D.UNIT_SHAPE.medium as UnitShape,
    legs: D.LEGS.medium as 'none' | 'simple' | 'animated' | 'full',
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
    forceFieldStyle: D.FORCE_FIELD_STYLE.medium as ForceFieldStyle,
    projectileStyle: D.PROJECTILE_STYLE.medium as ProjectileStyle,
    fireExplosionStyle: D.FIRE_EXPLOSION_STYLE.medium as FireExplosionStyle,
    deathExplosionStyle: D.DEATH_EXPLOSION_STYLE.medium as DeathExplosionStyle,
  },
  high: {
    unitShape: D.UNIT_SHAPE.high as UnitShape,
    legs: D.LEGS.high as 'none' | 'simple' | 'animated' | 'full',
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
    forceFieldStyle: D.FORCE_FIELD_STYLE.high as ForceFieldStyle,
    projectileStyle: D.PROJECTILE_STYLE.high as ProjectileStyle,
    fireExplosionStyle: D.FIRE_EXPLOSION_STYLE.high as FireExplosionStyle,
    deathExplosionStyle: D.DEATH_EXPLOSION_STYLE.high as DeathExplosionStyle,
  },
  max: {
    unitShape: D.UNIT_SHAPE.max as UnitShape,
    legs: D.LEGS.max as 'none' | 'simple' | 'animated' | 'full',
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
    forceFieldStyle: D.FORCE_FIELD_STYLE.max as ForceFieldStyle,
    projectileStyle: D.PROJECTILE_STYLE.max as ProjectileStyle,
    fireExplosionStyle: D.FIRE_EXPLOSION_STYLE.max as FireExplosionStyle,
    deathExplosionStyle: D.DEATH_EXPLOSION_STYLE.max as DeathExplosionStyle,
  },
};

export type AudioScope = 'off' | 'window' | 'padded' | 'all';
export type DriftMode = 'snap' | 'fast' | 'slow';

export type SoundCategory =
  | 'fire'
  | 'hit'
  | 'dead'
  | 'beam'
  | 'field'
  | 'music';
export const SOUND_CATEGORIES: SoundCategory[] = [
  'fire',
  'hit',
  'dead',
  'beam',
  'field',
  'music',
];

const STORAGE_KEY = 'rts-graphics-quality';
const RENDER_MODE_STORAGE_KEY = 'rts-render-mode';
const AUDIO_SCOPE_STORAGE_KEY = 'rts-audio-scope';
const AUDIO_SMOOTHING_STORAGE_KEY = 'rts-audio-smoothing';
const DRIFT_MODE_STORAGE_KEY = 'rts-drift-mode';
const SOUND_TOGGLES_STORAGE_KEY = 'rts-sound-toggles';
const RANGE_TOGGLES_STORAGE_KEY = 'rts-range-toggles';
const PROJ_RANGE_TOGGLES_STORAGE_KEY = 'rts-proj-range-toggles';
const UNIT_RADIUS_TOGGLES_STORAGE_KEY = 'rts-unit-radius-toggles';
const EDGE_SCROLL_STORAGE_KEY = 'rts-edge-scroll';

export type RangeType =
  | 'trackAcquire'
  | 'trackRelease'
  | 'engageAcquire'
  | 'engageRelease'
  | 'build';
export const RANGE_TYPES: RangeType[] = [
  'trackAcquire',
  'trackRelease',
  'engageAcquire',
  'engageRelease',
  'build',
];

export type ProjRangeType = 'collision' | 'primary' | 'secondary';
export const PROJ_RANGE_TYPES: ProjRangeType[] = [
  'collision',
  'primary',
  'secondary',
];

export type UnitRadiusType = 'visual' | 'shot' | 'push';
export const UNIT_RADIUS_TYPES: UnitRadiusType[] = ['visual', 'shot', 'push'];

// Current settings
// Default to 'auto' - adjusts quality based on zoom level
let currentQuality: GraphicsQuality = 'auto';
let currentRenderMode: RenderMode = 'padded';
const currentRangeToggles: Record<RangeType, boolean> = {
  trackAcquire: false,
  trackRelease: false,
  engageAcquire: false,
  engageRelease: false,
  build: false,
};
const currentProjRangeToggles: Record<ProjRangeType, boolean> = {
  collision: false,
  primary: false,
  secondary: false,
};
const currentUnitRadiusToggles: Record<UnitRadiusType, boolean> = {
  visual: false,
  shot: false,
  push: false,
};
let currentAudioScope: AudioScope = 'padded';
let currentAudioSmoothing: boolean = true;
let currentDriftMode: DriftMode = 'slow';
const currentSoundToggles: Record<SoundCategory, boolean> = {
  fire: true,
  hit: true,
  dead: true,
  beam: true,
  field: true,
  music: false,
};
let currentEdgeScrollEnabled: boolean = false;
let currentZoom: number = 1.0; // Updated by renderer

// Load from localStorage on module init
function loadFromStorage(): void {
  try {
    const storedQuality = localStorage.getItem(STORAGE_KEY);
    if (
      storedQuality &&
      (storedQuality === 'auto' ||
        storedQuality === 'min' ||
        storedQuality === 'low' ||
        storedQuality === 'medium' ||
        storedQuality === 'high' ||
        storedQuality === 'max')
    ) {
      currentQuality = storedQuality;
    }
    const storedRenderMode = localStorage.getItem(RENDER_MODE_STORAGE_KEY);
    if (
      storedRenderMode &&
      (storedRenderMode === 'window' ||
        storedRenderMode === 'padded' ||
        storedRenderMode === 'all')
    ) {
      currentRenderMode = storedRenderMode;
    }
    const storedAudioScope = localStorage.getItem(AUDIO_SCOPE_STORAGE_KEY);
    if (
      storedAudioScope &&
      (storedAudioScope === 'off' ||
        storedAudioScope === 'window' ||
        storedAudioScope === 'padded' ||
        storedAudioScope === 'all')
    ) {
      currentAudioScope = storedAudioScope;
    }
    const storedAudioSmoothing = localStorage.getItem(
      AUDIO_SMOOTHING_STORAGE_KEY,
    );
    if (storedAudioSmoothing !== null) {
      currentAudioSmoothing = storedAudioSmoothing === 'true';
    }
    const storedDriftMode = localStorage.getItem(DRIFT_MODE_STORAGE_KEY);
    if (
      storedDriftMode &&
      (storedDriftMode === 'snap' ||
        storedDriftMode === 'fast' ||
        storedDriftMode === 'slow')
    ) {
      currentDriftMode = storedDriftMode;
    }
    const storedSoundToggles = localStorage.getItem(SOUND_TOGGLES_STORAGE_KEY);
    if (storedSoundToggles) {
      const parsed = JSON.parse(storedSoundToggles);
      for (const cat of SOUND_CATEGORIES) {
        if (typeof parsed[cat] === 'boolean') {
          currentSoundToggles[cat] = parsed[cat];
        }
      }
    }
    const storedRangeToggles = localStorage.getItem(RANGE_TOGGLES_STORAGE_KEY);
    if (storedRangeToggles) {
      const parsed = JSON.parse(storedRangeToggles);
      for (const rt of RANGE_TYPES) {
        if (typeof parsed[rt] === 'boolean') {
          currentRangeToggles[rt] = parsed[rt];
        }
      }
    }
    const storedProjRangeToggles = localStorage.getItem(PROJ_RANGE_TOGGLES_STORAGE_KEY);
    if (storedProjRangeToggles) {
      const parsed = JSON.parse(storedProjRangeToggles);
      for (const prt of PROJ_RANGE_TYPES) {
        if (typeof parsed[prt] === 'boolean') {
          currentProjRangeToggles[prt] = parsed[prt];
        }
      }
    }
    const storedUnitRadiusToggles = localStorage.getItem(UNIT_RADIUS_TOGGLES_STORAGE_KEY);
    if (storedUnitRadiusToggles) {
      const parsed = JSON.parse(storedUnitRadiusToggles);
      for (const urt of UNIT_RADIUS_TYPES) {
        if (typeof parsed[urt] === 'boolean') {
          currentUnitRadiusToggles[urt] = parsed[urt];
        }
      }
    }
    const storedEdgeScroll = localStorage.getItem(EDGE_SCROLL_STORAGE_KEY);
    if (storedEdgeScroll !== null) {
      currentEdgeScrollEnabled = storedEdgeScroll === 'true';
    }
  } catch {
    // localStorage not available, use default
  }
}

// Initialize on load
loadFromStorage();

/**
 * Get current graphics quality level
 */
export function getGraphicsQuality(): GraphicsQuality {
  return currentQuality;
}

/**
 * Set graphics quality level (persists to localStorage)
 */
export function setGraphicsQuality(quality: GraphicsQuality): void {
  currentQuality = quality;
  try {
    localStorage.setItem(STORAGE_KEY, quality);
  } catch {
    // localStorage not available
  }
}

/**
 * Update the current zoom level (called by renderer each frame)
 * Used for auto quality mode
 */
export function setCurrentZoom(zoom: number): void {
  currentZoom = zoom;
}

/**
 * Get the effective quality level based on current settings and zoom
 * If quality is 'auto', returns the appropriate level based on zoom
 * Exported so UI can show which quality level is actually active
 */
// Auto-quality zoom thresholds: 4 logarithmically-spaced boundaries
// dividing [ZOOM_MIN, ZOOM_MAX] into 5 equal bands on a log scale.
// threshold[i] = ZOOM_MIN * (ZOOM_MAX/ZOOM_MIN)^(i/5), i=1..4
const _zoomRatio = ZOOM_MAX / ZOOM_MIN;
const _autoZoomLow = ZOOM_MIN * Math.pow(_zoomRatio, 1 / 5); // ~0.91
const _autoZoomMedium = ZOOM_MIN * Math.pow(_zoomRatio, 2 / 5); // ~1.66
const _autoZoomHigh = ZOOM_MIN * Math.pow(_zoomRatio, 3 / 5); // ~3.02
const _autoZoomMax = ZOOM_MIN * Math.pow(_zoomRatio, 4 / 5); // ~5.49

export function getEffectiveQuality(): Exclude<GraphicsQuality, 'auto'> {
  if (currentQuality !== 'auto') {
    return currentQuality;
  }

  // Auto mode: determine quality based on zoom level
  // Logarithmic spacing gives equal perceived zoom range per tier
  if (currentZoom >= _autoZoomMax) {
    return 'max';
  } else if (currentZoom >= _autoZoomHigh) {
    return 'high';
  } else if (currentZoom >= _autoZoomMedium) {
    return 'medium';
  } else if (currentZoom >= _autoZoomLow) {
    return 'low';
  }
  return 'min';
}

/**
 * Get the config for current quality level (respects auto mode)
 */
export function getGraphicsConfig(): GraphicsConfig {
  return GRAPHICS_CONFIGS[getEffectiveQuality()];
}

/**
 * Get config for a specific quality level
 */
export function getGraphicsConfigFor(
  quality: Exclude<GraphicsQuality, 'auto'>,
): GraphicsConfig {
  return GRAPHICS_CONFIGS[quality];
}

/**
 * Get current render mode
 */
export function getRenderMode(): RenderMode {
  return currentRenderMode;
}

/**
 * Set render mode (persists to localStorage)
 */
export function setRenderMode(mode: RenderMode): void {
  currentRenderMode = mode;
  try {
    localStorage.setItem(RENDER_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage not available
  }
}

/**
 * Get whether a specific range type is shown for all units
 */
export function getRangeToggle(type: RangeType): boolean {
  return currentRangeToggles[type];
}

/**
 * Set whether a specific range type is shown for all units
 */
export function setRangeToggle(type: RangeType, show: boolean): void {
  currentRangeToggles[type] = show;
  try {
    localStorage.setItem(RANGE_TOGGLES_STORAGE_KEY, JSON.stringify(currentRangeToggles));
  } catch { /* localStorage not available */ }
}

/**
 * Check if any range toggle is active
 */
export function anyRangeToggleActive(): boolean {
  return RANGE_TYPES.some((rt) => currentRangeToggles[rt]);
}

/**
 * Get whether a specific proj range type is shown for all projectiles
 */
export function getProjRangeToggle(type: ProjRangeType): boolean {
  return currentProjRangeToggles[type];
}

/**
 * Set whether a specific proj range type is shown for all projectiles
 */
export function setProjRangeToggle(type: ProjRangeType, show: boolean): void {
  currentProjRangeToggles[type] = show;
  try {
    localStorage.setItem(PROJ_RANGE_TOGGLES_STORAGE_KEY, JSON.stringify(currentProjRangeToggles));
  } catch { /* localStorage not available */ }
}

/**
 * Check if any proj range toggle is active
 */
export function anyProjRangeToggleActive(): boolean {
  return PROJ_RANGE_TYPES.some((prt) => currentProjRangeToggles[prt]);
}

/**
 * Get whether a specific unit radius type is shown
 */
export function getUnitRadiusToggle(type: UnitRadiusType): boolean {
  return currentUnitRadiusToggles[type];
}

/**
 * Set whether a specific unit radius type is shown
 */
export function setUnitRadiusToggle(type: UnitRadiusType, show: boolean): void {
  currentUnitRadiusToggles[type] = show;
  try {
    localStorage.setItem(UNIT_RADIUS_TOGGLES_STORAGE_KEY, JSON.stringify(currentUnitRadiusToggles));
  } catch { /* localStorage not available */ }
}

/**
 * Check if any unit radius toggle is active
 */
export function anyUnitRadiusToggleActive(): boolean {
  return UNIT_RADIUS_TYPES.some((urt) => currentUnitRadiusToggles[urt]);
}

/**
 * Get current audio scope
 */
export function getAudioScope(): AudioScope {
  return currentAudioScope;
}

/**
 * Set audio scope (persists to localStorage)
 */
export function setAudioScope(scope: AudioScope): void {
  currentAudioScope = scope;
  try {
    localStorage.setItem(AUDIO_SCOPE_STORAGE_KEY, scope);
  } catch {
    // localStorage not available
  }
}

/**
 * Get current audio smoothing setting
 */
export function getAudioSmoothing(): boolean {
  return currentAudioSmoothing;
}

/**
 * Set audio smoothing (persists to localStorage)
 */
export function setAudioSmoothing(enabled: boolean): void {
  currentAudioSmoothing = enabled;
  try {
    localStorage.setItem(AUDIO_SMOOTHING_STORAGE_KEY, String(enabled));
  } catch {
    // localStorage not available
  }
}

/**
 * Get current drift mode
 */
export function getDriftMode(): DriftMode {
  return currentDriftMode;
}

/**
 * Set drift mode (persists to localStorage)
 */
export function setDriftMode(mode: DriftMode): void {
  currentDriftMode = mode;
  try {
    localStorage.setItem(DRIFT_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage not available
  }
}

/**
 * Get whether a sound category is enabled
 */
export function getSoundToggle(category: SoundCategory): boolean {
  return currentSoundToggles[category];
}

/**
 * Set whether a sound category is enabled (persists to localStorage)
 */
export function setSoundToggle(
  category: SoundCategory,
  enabled: boolean,
): void {
  currentSoundToggles[category] = enabled;
  try {
    localStorage.setItem(
      SOUND_TOGGLES_STORAGE_KEY,
      JSON.stringify(currentSoundToggles),
    );
  } catch {
    // localStorage not available
  }
}

/**
 * Get whether edge scroll is enabled
 */
export function getEdgeScrollEnabled(): boolean {
  return currentEdgeScrollEnabled;
}

/**
 * Set whether edge scroll is enabled (persists to localStorage)
 */
export function setEdgeScrollEnabled(enabled: boolean): void {
  currentEdgeScrollEnabled = enabled;
  try {
    localStorage.setItem(EDGE_SCROLL_STORAGE_KEY, String(enabled));
  } catch {
    // localStorage not available
  }
}

