// Beam-weapon explosion magnitude. Pure data lives in
// explosionConfig.json so both TypeScript and (eventually) Rust/WASM
// can load the same source of truth.
//
// Historical note: this file used to ship a much larger
// EXPLOSION_MOMENTUM / FIRE_EXPLOSION / DEATH_EXPLOSION / DEBRIS_CONFIG
// surface, but the renderer migrated to graphics-tier-driven configs
// (see playerClientGraphicsConfig.fireExplosionStyle /
// deathExplosionStyle and the per-style branches in
// Debris3D / SprayRenderer3D / SmokeTrail3D). Everything except
// BEAM_EXPLOSION_MAGNITUDE became dead code and has been removed
// under Delete The Old Path.

import explosionConfig from './explosionConfig.json';

/**
 * Magnitude for beam weapon explosion effects. Since beams don't have
 * velocity like projectiles, this provides a base magnitude for the
 * attacker direction in death-momentum calculations.
 * Higher = more "push" effect from beam kills.
 */
export const BEAM_EXPLOSION_MAGNITUDE = explosionConfig.beamExplosionMagnitude;
