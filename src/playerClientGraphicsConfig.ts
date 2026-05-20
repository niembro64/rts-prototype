// Player-client max-graphics preset. Pure data lives in
// playerClientGraphicsConfig.json so both TypeScript and (eventually)
// Rust/WASM can load the same source of truth.
//
// `waterOpacity` in the JSON is intentionally a literal of
// WATER_RENDER_CONFIG.opacity (currently 0.82). It's duplicated rather
// than imported because cross-config TS imports do not survive the
// move to a language-neutral JSON file. Keep the two in sync; a future
// step can hoist WATER_RENDER_CONFIG to JSON and have both configs
// reference the same source.

import type { GraphicsConfig } from './types/graphics';
import rawConfig from './playerClientGraphicsConfig.json';

export const PLAYER_CLIENT_MAX_GRAPHICS_CONFIG: GraphicsConfig =
  rawConfig as GraphicsConfig;
