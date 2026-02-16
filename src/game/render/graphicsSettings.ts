/**
 * Graphics Quality Settings
 *
 * Controls visual fidelity vs performance tradeoffs.
 * Settings are persisted to localStorage.
 * All detail level definitions are centralized in config.ts GRAPHICS_DETAIL_DEFINITIONS.
 */

import { GRAPHICS_DETAIL_DEFINITIONS } from '../../config';

export type GraphicsQuality = 'auto' | 'min' | 'low' | 'medium' | 'high' | 'max';
export type RenderMode = 'window' | 'all';

export type ExplosionStyle = 'one-simple-circle' | 'three-velocity-circles' | 'three-velocity-chunks' | 'three-velocity-complex';
export type BeamStyle = 'simple' | 'standard' | 'detailed' | 'complex';
export type ForceFieldStyle = 'simple' | 'detailed';

export interface GraphicsConfig {
  legs: 'none' | 'animated';
  explosions: ExplosionStyle;
  treadsAnimated: boolean;
  beamStyle: BeamStyle;
  beamGlow: boolean;
  antialias: boolean;
  forceFieldStyle: ForceFieldStyle;
}

// Build configs from centralized definitions
const D = GRAPHICS_DETAIL_DEFINITIONS;
const GRAPHICS_CONFIGS: Record<Exclude<GraphicsQuality, 'auto'>, GraphicsConfig> = {
  min: {
    legs: D.LEGS.min as 'none' | 'animated',
    explosions: D.EXPLOSIONS.min as ExplosionStyle,
    treadsAnimated: D.TREADS_ANIMATED.min,
    beamStyle: D.BEAM_STYLE.min as BeamStyle,
    beamGlow: D.BEAM_GLOW.min,
    antialias: D.ANTIALIAS.min,
    forceFieldStyle: D.FORCE_FIELD_STYLE.min as ForceFieldStyle,
  },
  low: {
    legs: D.LEGS.low as 'none' | 'animated',
    explosions: D.EXPLOSIONS.low as ExplosionStyle,
    treadsAnimated: D.TREADS_ANIMATED.low,
    beamStyle: D.BEAM_STYLE.low as BeamStyle,
    beamGlow: D.BEAM_GLOW.low,
    antialias: D.ANTIALIAS.low,
    forceFieldStyle: D.FORCE_FIELD_STYLE.low as ForceFieldStyle,
  },
  medium: {
    legs: D.LEGS.medium as 'none' | 'animated',
    explosions: D.EXPLOSIONS.medium as ExplosionStyle,
    treadsAnimated: D.TREADS_ANIMATED.medium,
    beamStyle: D.BEAM_STYLE.medium as BeamStyle,
    beamGlow: D.BEAM_GLOW.medium,
    antialias: D.ANTIALIAS.medium,
    forceFieldStyle: D.FORCE_FIELD_STYLE.medium as ForceFieldStyle,
  },
  high: {
    legs: D.LEGS.high as 'none' | 'animated',
    explosions: D.EXPLOSIONS.high as ExplosionStyle,
    treadsAnimated: D.TREADS_ANIMATED.high,
    beamStyle: D.BEAM_STYLE.high as BeamStyle,
    beamGlow: D.BEAM_GLOW.high,
    antialias: D.ANTIALIAS.high,
    forceFieldStyle: D.FORCE_FIELD_STYLE.high as ForceFieldStyle,
  },
  max: {
    legs: D.LEGS.max as 'none' | 'animated',
    explosions: D.EXPLOSIONS.max as ExplosionStyle,
    treadsAnimated: D.TREADS_ANIMATED.max,
    beamStyle: D.BEAM_STYLE.max as BeamStyle,
    beamGlow: D.BEAM_GLOW.max,
    antialias: D.ANTIALIAS.max,
    forceFieldStyle: D.FORCE_FIELD_STYLE.max as ForceFieldStyle,
  },
};

const STORAGE_KEY = 'rts-graphics-quality';
const RENDER_MODE_STORAGE_KEY = 'rts-render-mode';
const RANGE_TOGGLE_STORAGE_PREFIX = 'rts-range-';

export type RangeType = 'see' | 'fire' | 'release' | 'lock' | 'fightstop' | 'build';
export const RANGE_TYPES: RangeType[] = ['see', 'fire', 'release', 'lock', 'fightstop', 'build'];

// Current settings
// Default to 'low' for performance - 'high' and 'max' explosion rendering is extremely expensive
let currentQuality: GraphicsQuality = 'low';
let currentRenderMode: RenderMode = 'window';
const currentRangeToggles: Record<RangeType, boolean> = {
  see: false,
  fire: false,
  release: false,
  lock: false,
  fightstop: false,
  build: false,
};
let currentZoom: number = 1.0; // Updated by renderer

// Load from localStorage on module init
function loadFromStorage(): void {
  try {
    const storedQuality = localStorage.getItem(STORAGE_KEY);
    if (storedQuality && (storedQuality === 'auto' || storedQuality === 'min' || storedQuality === 'low' || storedQuality === 'medium' || storedQuality === 'high' || storedQuality === 'max')) {
      currentQuality = storedQuality;
    }
    const storedRenderMode = localStorage.getItem(RENDER_MODE_STORAGE_KEY);
    if (storedRenderMode && (storedRenderMode === 'window' || storedRenderMode === 'all')) {
      currentRenderMode = storedRenderMode;
    }
    for (const rt of RANGE_TYPES) {
      const stored = localStorage.getItem(RANGE_TOGGLE_STORAGE_PREFIX + rt);
      if (stored === 'true') {
        currentRangeToggles[rt] = true;
      }
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
export function getEffectiveQuality(): Exclude<GraphicsQuality, 'auto'> {
  if (currentQuality !== 'auto') {
    return currentQuality;
  }

  // Auto mode: determine quality based on zoom level
  // Uses AUTO_ZOOM_START thresholds from config
  const zoomStart = D.AUTO_ZOOM_START;
  if (currentZoom >= zoomStart.max) {
    return 'max';
  } else if (currentZoom >= zoomStart.high) {
    return 'high';
  } else if (currentZoom >= zoomStart.medium) {
    return 'medium';
  } else if (currentZoom >= zoomStart.low) {
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
export function getGraphicsConfigFor(quality: Exclude<GraphicsQuality, 'auto'>): GraphicsConfig {
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
 * Set whether a specific range type is shown for all units (persists to localStorage)
 */
export function setRangeToggle(type: RangeType, show: boolean): void {
  currentRangeToggles[type] = show;
  try {
    localStorage.setItem(RANGE_TOGGLE_STORAGE_PREFIX + type, String(show));
  } catch {
    // localStorage not available
  }
}

/**
 * Check if any range toggle is active
 */
export function anyRangeToggleActive(): boolean {
  return RANGE_TYPES.some(rt => currentRangeToggles[rt]);
}
