/**
 * Graphics Quality Settings
 *
 * Controls visual fidelity vs performance tradeoffs.
 * Settings are persisted to localStorage.
 */

import { AUTO_QUALITY_ZOOM_LOW, AUTO_QUALITY_ZOOM_MEDIUM } from '../../config';

export type GraphicsQuality = 'auto' | 'low' | 'medium' | 'high';
export type RenderMode = 'window' | 'all';

export interface GraphicsConfig {
  // Leg rendering for arachnid/daddy/insect units
  legs: 'none' | 'animated';

  // Explosion particle layers (0 = simple flash, 1-2 = some particles, 6 = full)
  explosionLayers: number;

  // Tread/wheel animations
  treadsAnimated: boolean;

  // Beam glow effects
  beamGlow: boolean;

  // Antialiasing (requires game restart to take effect)
  antialias: boolean;
}

// Static configs for manual quality levels
const GRAPHICS_CONFIGS: Record<Exclude<GraphicsQuality, 'auto'>, GraphicsConfig> = {
  low: {
    legs: 'none',
    explosionLayers: 0,
    treadsAnimated: false,
    beamGlow: false,
    antialias: false,
  },
  medium: {
    legs: 'animated',
    explosionLayers: 0, // Simple flash explosions
    treadsAnimated: true,
    beamGlow: false,
    antialias: true,
  },
  high: {
    legs: 'animated',
    explosionLayers: 6,
    treadsAnimated: true,
    beamGlow: true,
    antialias: true,
  },
};

// Zoom thresholds for auto quality (imported from config.ts)
// When zoomed out (low zoom value), use lower quality
const AUTO_ZOOM_THRESHOLDS = {
  low: AUTO_QUALITY_ZOOM_LOW,    // Below this zoom = low quality
  medium: AUTO_QUALITY_ZOOM_MEDIUM,  // Between low and this = medium quality
  // Above medium = high quality
};

const STORAGE_KEY = 'rts-graphics-quality';
const RENDER_MODE_STORAGE_KEY = 'rts-render-mode';

// Current settings
let currentQuality: GraphicsQuality = 'high';
let currentRenderMode: RenderMode = 'window';
let currentZoom: number = 1.0; // Updated by renderer

// Load from localStorage on module init
function loadFromStorage(): void {
  try {
    const storedQuality = localStorage.getItem(STORAGE_KEY);
    if (storedQuality && (storedQuality === 'auto' || storedQuality === 'low' || storedQuality === 'medium' || storedQuality === 'high')) {
      currentQuality = storedQuality;
    }
    const storedRenderMode = localStorage.getItem(RENDER_MODE_STORAGE_KEY);
    if (storedRenderMode && (storedRenderMode === 'window' || storedRenderMode === 'all')) {
      currentRenderMode = storedRenderMode;
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
  if (currentZoom < AUTO_ZOOM_THRESHOLDS.low) {
    return 'low';
  } else if (currentZoom < AUTO_ZOOM_THRESHOLDS.medium) {
    return 'medium';
  }
  return 'high';
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
