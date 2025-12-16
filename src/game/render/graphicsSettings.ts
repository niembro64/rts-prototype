/**
 * Graphics Quality Settings
 *
 * Controls visual fidelity vs performance tradeoffs.
 * Settings are persisted to localStorage.
 */

export type GraphicsQuality = 'low' | 'medium' | 'high';

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

const GRAPHICS_CONFIGS: Record<GraphicsQuality, GraphicsConfig> = {
  low: {
    legs: 'none',
    explosionLayers: 0,
    treadsAnimated: false,
    beamGlow: false,
    antialias: false,
  },
  medium: {
    legs: 'none', // Legs require continuous updates to track unit position, so off for performance
    explosionLayers: 2,
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

const STORAGE_KEY = 'rts-graphics-quality';

// Current quality level
let currentQuality: GraphicsQuality = 'high';

// Load from localStorage on module init
function loadFromStorage(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (stored === 'low' || stored === 'medium' || stored === 'high')) {
      currentQuality = stored;
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
 * Get the config for current quality level
 */
export function getGraphicsConfig(): GraphicsConfig {
  return GRAPHICS_CONFIGS[currentQuality];
}

/**
 * Get config for a specific quality level
 */
export function getGraphicsConfigFor(quality: GraphicsQuality): GraphicsConfig {
  return GRAPHICS_CONFIGS[quality];
}

/**
 * Cycle to next quality level (low -> medium -> high -> low)
 */
export function cycleGraphicsQuality(): GraphicsQuality {
  const cycle: GraphicsQuality[] = ['low', 'medium', 'high'];
  const currentIndex = cycle.indexOf(currentQuality);
  const nextIndex = (currentIndex + 1) % cycle.length;
  setGraphicsQuality(cycle[nextIndex]);
  return cycle[nextIndex];
}
