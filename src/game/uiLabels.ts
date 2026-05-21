// Renderer-agnostic HUD colors used by waypoint and action overlays.
// Lifted out of render/types.ts so the HUD doesn't depend on the 2D module.

import type { WaypointType, ActionType } from './sim/types';
import { ACTION_COLOR_HEX, WAYPOINT_COLOR_HEX } from '@/colorsConfig';

/** Waypoint marker colors by type — legacy factory rally points. */
export const WAYPOINT_COLORS: Record<WaypointType, number> = WAYPOINT_COLOR_HEX;

/** Unit action queue colors. */
export const ACTION_COLORS: Record<ActionType, number> = ACTION_COLOR_HEX;
