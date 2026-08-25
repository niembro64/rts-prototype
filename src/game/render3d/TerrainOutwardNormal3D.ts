// TerrainOutwardNormal3D — undo three's back-face normal flip on the terrain.
//
// The authoritative terrain mesh is drawn by its BACK faces. Set its material
// to FrontSide and the ground vanishes, leaving only the world-box side walls
// (which are wound the other way); a debug pass colouring by gl_FrontFacing
// reads back-facing on 53,288 of 53,290 sampled terrain pixels. Its authored
// vertex normals all point up, so three's DOUBLE_SIDED `normal *= faceDirection`
// hands the lighting an inverted, downward normal.
//
// Ordinary ground hid that while its relief came from the baked `terrainShade`,
// computed at build time from the TRUE normal. The former ore-only correction
// then produced a sharper failure: ore received the live directional sun and
// its shadow map, while biome grass kept the flipped normal and received no
// direct sun for a unit silhouette to occlude. The production scope therefore
// restores the authored normal across the whole terrain; the narrower scopes
// remain useful only as diagnostic bisects.
//
// faceDirection squared is 1, so multiplying by it a second time restores the
// authored outward normal. Side-wall fragments are front-facing and therefore
// pass through untouched, which is what they want.

import { TERRAIN_OUTWARD_NORMAL_SCOPE_LEVEL } from '@/config';

export const TERRAIN_OUTWARD_NORMAL_UNIFORM = 'uTerrainOutwardNormalScope';

/** Scope levels, matching TERRAIN_OUTWARD_NORMAL_SCOPE_LEVEL in config.ts. */
export const TERRAIN_OUTWARD_NORMAL_LEVELS = {
  off: 0,
  ore: 1,
  terrain: 2,
} as const;

export function terrainOutwardNormalUniformDeclaration(): string {
  return `uniform float ${TERRAIN_OUTWARD_NORMAL_UNIFORM};`;
}

/** Injected immediately after `#include <normal_fragment_maps>`, where
 *  `faceDirection` and `normal` are both live and `metalCoverage` has already
 *  been computed in `color_fragment`.
 *
 *  The ore scope STEPS on coverage instead of interpolating. Interpolating
 *  would mix the MULTIPLIER between 1 and -1, which passes through zero and
 *  hands the lighting a zero-length normal in the middle of the ore edge —
 *  a whole band of black fragments, from code that compiles perfectly. The
 *  step lands inside a boundary that is already a hard material change, and
 *  measures at 0.1% of non-ore pixels touched. */
export function terrainOutwardNormalFragment(): string {
  const u = TERRAIN_OUTWARD_NORMAL_UNIFORM;
  return [
    `float terrainOutward = ${u} >= 2.0`,
    '  ? 1.0',
    `  : (${u} >= 1.0 ? step(0.5, metalCoverage) : 0.0);`,
    'normal *= mix(1.0, faceDirection, terrainOutward);',
  ].join('\n');
}

export function terrainOutwardNormalScopeLevel(): number {
  return TERRAIN_OUTWARD_NORMAL_SCOPE_LEVEL;
}
