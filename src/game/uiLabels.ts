// Renderer-agnostic HUD colors used by waypoint and action overlays.
// Lifted out of render/types.ts so the HUD doesn't depend on the 2D module.

import type { WaypointType, ActionType } from './sim/types';

/** Waypoint marker colors by type — legacy factory rally points. */
export const WAYPOINT_COLORS: Record<WaypointType, number> = {
  move: 0x00ff00,    // Green
  patrol: 0x0088ff,  // Blue
  fight: 0xff4444,   // Red
};

/** Unit action queue colors. */
export const ACTION_COLORS: Record<ActionType, number> = {
  move: 0x00ff00,    // Green
  patrol: 0x0088ff,  // Blue
  fight: 0xff4444,   // Red
  build: 0xffcc00,   // Yellow for building
  repair: 0x44ff44,  // Light green for repair
  attack: 0xff0000,  // Red for attack
  guard: 0x9ef28d,   // Soft green for guard
};
