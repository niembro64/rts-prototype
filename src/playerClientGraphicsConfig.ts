// Player-client max-graphics preset. Pure data lives in
// playerClientGraphicsConfig.json so both TypeScript and (eventually)
// Rust/WASM can load the same source of truth.
//
// `waterOpacity` in the JSON intentionally mirrors
// colors_config.json.world.water.opacity. It remains here because this
// graphics preset is pure data consumed independently from render
// material construction.

import type { GraphicsConfig } from './types/graphics';
import rawConfig from './playerClientGraphicsConfig.json';

export const PLAYER_CLIENT_MAX_GRAPHICS_CONFIG: GraphicsConfig =
  rawConfig as GraphicsConfig;
