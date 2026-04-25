// Lod3D — LOD state tracking for the 3D renderer.
//
// The 2D renderer reads getGraphicsConfig() on the fly for every draw call.
// The 3D renderer builds meshes once and animates transforms per frame, so
// it needs explicit state: which LOD did we build this unit at, and does
// that match the current global LOD? When they diverge, the entity's mesh
// gets torn down and rebuilt at the new level.
//
// To avoid comparing every GraphicsConfig field, we compress the subset of
// LOD axes that affect 3D geometry into a single string `lodKey`. Unit
// meshes store their build-time key; Render3DEntities compares it to the
// current key each frame.

import { getGraphicsConfig } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';

/** Stringified LOD key covering every GraphicsConfig axis that affects 3D
 *  geometry (not just runtime transforms). Two meshes share a key iff they
 *  were built against equivalent graphics settings. */
export function lodKey(gfx: GraphicsConfig): string {
  return [
    // Tier first — at min/low the 3D path collapses to a sphere only,
    // skipping turrets/legs/mirrors entirely. Tier flips MUST trigger a
    // mesh rebuild even if the per-axis fields happen to coincide.
    gfx.tier,
    gfx.unitShape,
    gfx.legs,
    gfx.treadsAnimated ? 'tw' : 'ts',
    gfx.chassisDetail ? 'cd' : '-',
    gfx.turretStyle,
    gfx.forceTurretStyle,
    gfx.paletteShading ? 'ps' : '-',
    // MED+ flag controlling animated accents that cost setup (e.g. mirror
    // sparkles). In key so toggling the LOD tier rebuilds affected meshes.
    gfx.barrelSpin ? 'bs' : '-',
    // MAX-only intensifier (e.g. secondary mirror glint). Same reason.
    gfx.beamGlow ? 'bg' : '-',
  ].join('|');
}

/** Current LOD snapshot — read once per frame, not per draw. */
export type Lod3DState = {
  gfx: GraphicsConfig;
  key: string;
};

export function snapshotLod(): Lod3DState {
  const gfx = getGraphicsConfig();
  return { gfx, key: lodKey(gfx) };
}
