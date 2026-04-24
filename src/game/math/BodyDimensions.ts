import { TURRET_HEIGHT } from '../../config';

// BodyDimensions — sim-safe (no-THREE) body-shape height math.
//
// The 3D renderer builds each unit's chassis as spheres/spheroids
// (smooth shapes) or extruded prisms (angled shapes) with heights
// proportional to the horizontal dimensions — see BodyShape3D.ts for
// the render-side implementation.
//
// This module exposes just the dimension math: given a 2D renderer id
// and a unit radius, return the world-space top Y of the unit's body.
// The sim code uses that to compute per-unit muzzle altitudes (turret
// sits on top of the body, barrel mid-height is the visible tip) so
// projectile spawn Z lines up with the drawn barrel tip regardless of
// how tall the unit's body happens to be.

/** Renderer IDs — mirror the `renderer` field on UnitBlueprint. */
export type BodyRendererId =
  | 'scout' | 'brawl' | 'tank' | 'burst' | 'mortar'
  | 'hippo'
  | 'beam' | 'arachnid' | 'snipe' | 'commander' | 'forceField' | 'loris';

type CompositePart =
  | { kind: 'circle'; offsetForward: number; radiusFrac: number }
  | { kind: 'oval'; offsetForward: number; xFrac: number; zFrac: number };

type ShapeSpec =
  | { kind: 'polygon'; sides: number; radiusFrac: number; rotation: number }
  | { kind: 'rect'; widthFrac: number; lengthFrac: number }
  | { kind: 'circle'; radiusFrac: number }
  | { kind: 'oval'; xFrac: number; zFrac: number }
  | { kind: 'composite'; parts: CompositePart[] };

// Keep in sync with SHAPES in BodyShape3D.ts — the two tables describe
// the same per-renderer body. Duplicating the constants (instead of
// importing them from BodyShape3D) keeps the sim free of any THREE
// transitively-pulled dependency.
const SHAPES: Record<BodyRendererId, ShapeSpec> = {
  scout:      { kind: 'polygon', sides: 4, radiusFrac: 0.55, rotation: Math.PI / 4 },
  brawl:      { kind: 'polygon', sides: 4, radiusFrac: 0.8,  rotation: 0 },
  tank:       { kind: 'polygon', sides: 5, radiusFrac: 0.85, rotation: 0 },
  burst:      { kind: 'polygon', sides: 3, radiusFrac: 0.6,  rotation: Math.PI },
  mortar:     { kind: 'polygon', sides: 6, radiusFrac: 0.55, rotation: 0 },
  hippo:      { kind: 'rect', lengthFrac: 0.7, widthFrac: 1.6 },
  beam: {
    kind: 'composite',
    parts: [
      { kind: 'oval',   offsetForward: -0.65, xFrac: 0.9,  zFrac: 0.65 },
      { kind: 'circle', offsetForward:  0.30, radiusFrac: 0.6 },
    ],
  },
  arachnid: {
    kind: 'composite',
    parts: [
      { kind: 'circle', offsetForward: -1.1, radiusFrac: 1.15 },
      { kind: 'circle', offsetForward:  0.3, radiusFrac: 0.55 },
    ],
  },
  snipe: { kind: 'oval', xFrac: 0.5, zFrac: 0.35 },
  commander: {
    kind: 'composite',
    parts: [
      { kind: 'oval',   offsetForward: -0.45, xFrac: 0.7, zFrac: 0.65 },
      { kind: 'circle', offsetForward:  0.4,  radiusFrac: 0.5 },
    ],
  },
  forceField: { kind: 'circle', radiusFrac: 0.55 },
  loris:      { kind: 'circle', radiusFrac: 0.55 },
};

function polygonHeight(radiusFrac: number, sides: number): number {
  return 2 * radiusFrac * Math.cos(Math.PI / sides);
}

function rectHeight(lengthFrac: number, widthFrac: number): number {
  return (lengthFrac + widthFrac) / 2;
}

function spheroidRy(xFrac: number, zFrac: number): number {
  return (xFrac + zFrac) / 2;
}

const TOP_Y_CACHE: Map<string, number> = new Map();

/** Body-top height in unit-radius-1 space for the given renderer id.
 *  Multiply by a unit's render radius to get the world-space Y where
 *  the turret mounts (and therefore the barrel base height). */
export function getBodyTopFrac(renderer: string): number {
  const cached = TOP_Y_CACHE.get(renderer);
  if (cached !== undefined) return cached;
  const spec = SHAPES[renderer as BodyRendererId] ?? SHAPES.arachnid;
  let topY = 0;
  if (spec.kind === 'polygon') {
    topY = polygonHeight(spec.radiusFrac, spec.sides);
  } else if (spec.kind === 'rect') {
    topY = rectHeight(spec.lengthFrac, spec.widthFrac);
  } else if (spec.kind === 'circle') {
    topY = 2 * spec.radiusFrac;
  } else if (spec.kind === 'oval') {
    topY = 2 * spheroidRy(spec.xFrac, spec.zFrac);
  } else {
    for (const p of spec.parts) {
      const segTop = p.kind === 'circle'
        ? 2 * p.radiusFrac
        : 2 * spheroidRy(p.xFrac, p.zFrac);
      if (segTop > topY) topY = segTop;
    }
  }
  TOP_Y_CACHE.set(renderer, topY);
  return topY;
}

/** World-space body-top Y for a unit with the given renderer and
 *  physical radius (unit.unitRadiusCollider.push). */
export function getBodyTopY(renderer: string, unitRadius: number): number {
  return getBodyTopFrac(renderer) * unitRadius;
}

/** World-space altitude of the barrel tip above the unit's ground
 *  footprint at pitch=0. Turret head sits atop the body; barrels pivot
 *  through the head's mid-height — so muzzle ≈ body top + TURRET_HEIGHT/2.
 *  Replaces the old shared MUZZLE_HEIGHT_ABOVE_GROUND constant so fire
 *  altitude tracks each unit's actual visible turret. */
export function getMuzzleHeightAboveGround(renderer: string, unitRadius: number): number {
  return getBodyTopY(renderer, unitRadius) + TURRET_HEIGHT / 2;
}
