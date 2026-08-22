// BodyDimensions — sim-safe (no-THREE) body-shape height math.
//
// The 3D renderer builds each unit's chassis as spheres/spheroids
// (smooth shapes) or extruded prisms (angled shapes) with heights
// proportional to the horizontal dimensions — see BodyShape3D.ts for
// the render-side implementation.
//
// This module exposes body dimension math for chassis and legs,
// and fallback helpers. Authoritative turret pivots are authored
// directly in unit blueprints as 3D mount points.

import type { UnitBlueprint, UnitBodyShape, UnitBodyShapePart } from '@/types/blueprints';
import { deterministicMath as DMath } from '../sim/deterministicMath';

function circleYFrac(radiusFrac: number, yFrac?: number): number {
  return yFrac ?? radiusFrac;
}

function circleCenterYFrac(part: {
  radiusFrac: number;
  yFrac?: number;
  centerYFrac?: number;
}): number {
  return part.centerYFrac ?? circleYFrac(part.radiusFrac, part.yFrac);
}

const BODY_SHAPE_KEY_CACHE: WeakMap<UnitBodyShape, string> = new WeakMap();
const TOP_Y_CACHE: Map<string, number> = new Map();

export const TREAD_CHASSIS_LIFT_Y = 10;

/** Stable identity for a unit body shape. This is the only render/cache
 *  key for chassis geometry; unit blueprints author bodyShape, not a
 *  second renderer id that can drift from the actual geometry. */
export function getUnitBodyShapeKey(bodyShape: UnitBodyShape | null): string {
  if (bodyShape === null) return 'none';
  const cached = BODY_SHAPE_KEY_CACHE.get(bodyShape);
  if (cached !== undefined) return cached;
  const key = JSON.stringify(bodyShape);
  BODY_SHAPE_KEY_CACHE.set(bodyShape, key);
  return key;
}

/** Chassis-local Y of the visible body's vertical center. Unit body
 *  shapes are built from terrain-up: bottoms at local Y=0 and tops at
 *  getBodyTopY, so the center is the midpoint of that authored volume. */
function getBodyCenterLocalY(
  bodyShape: UnitBodyShape | null,
  unitRadius: number,
): number {
  if (bodyShape === null) return 0;
  return getBodyTopY(bodyShape, unitRadius) * 0.5;
}

/** World-space lift applied to the visible body/chassis above the unit's
 *  ground footprint. This is derived from supportPointOffsetZ so the
 *  authored unit center is a hard contract shared by simulation,
 *  targeting, chassis rendering, and locomotion. */
export function getChassisLiftY(
  blueprint: Pick<UnitBlueprint, 'unitLocomotion' | 'bodyShape' | 'supportPointOffsetZ'> | undefined,
  unitRadius: number,
): number {
  if (!blueprint) return 0;
  return blueprint.supportPointOffsetZ - getBodyCenterLocalY(blueprint.bodyShape, unitRadius);
}

/** Body-top height in unit-radius-1 space for the given body shape.
 *  Multiply by a unit's render radius to get the world-space Y where
 *  the turret mounts (and therefore the barrel base height). */
export function getBodyTopFrac(bodyShape: UnitBodyShape | null): number {
  if (bodyShape === null) return 0;
  const key = getUnitBodyShapeKey(bodyShape);
  const cached = TOP_Y_CACHE.get(key);
  if (cached !== undefined) return cached;
  const spec = bodyShape;
  let topY = 0;
  if (spec.kind === 'polygon') {
    topY = spec.heightFrac;
  } else if (spec.kind === 'rect' || spec.kind === 'rhombus') {
    topY = spec.heightFrac;
  } else if (spec.kind === 'circle') {
    topY = circleCenterYFrac(spec) + circleYFrac(spec.radiusFrac, spec.yFrac);
  } else if (spec.kind === 'oval') {
    topY = 2 * spec.yFrac;
  } else {
    for (const p of spec.parts) {
      const segTop = bodyPartTopFrac(p);
      if (segTop > topY) topY = segTop;
    }
  }
  TOP_Y_CACHE.set(key, topY);
  return topY;
}

/** World-space body-top Y for a unit with the given body shape and
 *  visual unit radius. */
/**
 * Half the body's LATERAL extent, in unit-radius-1 space.
 *
 * The mirror of getBodyTopFrac for the other axis, and the number a
 * locomotion mount has to clear: a wheel or a track whose inner face sits
 * inside this is rendering inside the hull it is carrying. Sim-side rather
 * than renderer-side on purpose — the blueprint contract test needs it, and
 * it must not have to import a THREE module to ask how wide a body is.
 */
export function getBodyHalfWidthFrac(bodyShape: UnitBodyShape | null): number {
  if (bodyShape === null) return 0;
  return bodyPartHalfWidthFrac(bodyShape);
}

function bodyPartHalfWidthFrac(part: UnitBodyShape | UnitBodyShapePart): number {
  switch (part.kind) {
    // A polygon is built at circumradius 1 and scaled by radiusFrac, and a
    // sphere at radius 1 scaled by its own frac, so those fracs ARE the half
    // extent.
    case 'polygon':
      return part.radiusFrac;
    case 'circle':
      return part.radiusFrac;
    case 'oval':
      return part.zFrac;
    case 'box':
      return part.widthFrac * 0.5;
    // A rect/rhombus is built at FULL extent 1 — half extents of 0.5 — and
    // then scaled, so its frac is a full width and has to be halved. Reading
    // it as a half extent is what pushed the one rect-bodied tracked unit's
    // belts twice as far out as they needed to be.
    case 'rect':
    case 'rhombus':
      return part.widthFrac / 2;
    case 'composite': {
      let half = 0;
      for (const child of part.parts) {
        // A composite's segments carry their own lateral offset, so a narrow
        // segment slung outboard reaches further than a wide one on the axis.
        const offset = Math.abs(child.offsetLateral ?? 0);
        half = Math.max(half, offset + bodyPartHalfWidthFrac(child));
      }
      return half;
    }
    default:
      return 0;
  }
}

export function getBodyTopY(bodyShape: UnitBodyShape | null, unitRadius: number): number {
  return getBodyTopFrac(bodyShape) * unitRadius;
}

function bodyPartTopFrac(part: UnitBodyShapePart): number {
  if (part.kind === 'circle') return circleCenterYFrac(part) + circleYFrac(part.radiusFrac, part.yFrac);
  if (part.kind === 'oval') return (part.centerYFrac ?? part.yFrac) + part.yFrac;
  if (part.kind === 'box') return (part.centerYFrac ?? part.heightFrac * 0.5) + part.heightFrac * 0.5;
  if (part.kind === 'cylinder') {
    // A tilted rod's highest point is its RAISED END, not its middle. Reading
    // the centre alone let a boom swing up through the height every other
    // system measures the hull by.
    const pose = getCylinderSegmentPose(part);
    return Math.max(pose.startYFrac, pose.endYFrac) + part.radiusFrac;
  }
  return (part.centerYFrac ?? part.radiusFrac) + part.radiusFrac;
}

type CylinderSegmentPose = {
  /** Mid-height of the rod, in unit-radius-1 space. */
  centerYFrac: number;
  /** Tilt about the lateral axis; positive lifts the forward (+X) end. */
  pitchRad: number;
  /** Height of the forward (+X) end. */
  startYFrac: number;
  /** Height of the rearward (-X) end. */
  endYFrac: number;
};

/**
 * A CYLINDER SEGMENT'S TWO ENDS.
 *
 * A rod — the Dragonfly's tail boom, a drone's spine — is placed by saying
 * where each of its ends sits. Centre-plus-pitch cannot say that: the tip's
 * height is hidden behind a sine of two other numbers, and nudging either one
 * moves BOTH ends, so "drop the tail a little" is a solve rather than an edit.
 * Segments may author either form and this resolves whichever was used into
 * all four numbers, so the renderer and the height math read one description.
 *
 * `start` is the FORWARD end (+X, toward the nose) and `end` the rearward one,
 * matching the direction offsetForward already measures. Tilting preserves the
 * rod's own lengthFrac: raising one end SWINGS the rod about its middle rather
 * than stretching it, which is exactly what pitchRad did.
 */
export function getCylinderSegmentPose(part: {
  lengthFrac: number;
  radiusFrac: number;
  centerYFrac?: number;
  pitchRad?: number;
  startYFrac?: number;
  endYFrac?: number;
}): CylinderSegmentPose {
  const length = Math.max(1e-6, part.lengthFrac);
  if (part.startYFrac !== undefined || part.endYFrac !== undefined) {
    const seated = part.centerYFrac ?? part.radiusFrac;
    const startYFrac = part.startYFrac ?? seated;
    const endYFrac = part.endYFrac ?? seated;
    // Rotation about +Z lifts the +X end, so the rise the ends ask for is
    // (start - end) over the rod's length. Clamping keeps a rod asked to rise
    // further than it is long standing vertical instead of resolving to NaN.
    const sinPitch = Math.max(-1, Math.min(1, (startYFrac - endYFrac) / length));
    return {
      centerYFrac: (startYFrac + endYFrac) / 2,
      pitchRad: DMath.asin(sinPitch),
      startYFrac,
      endYFrac,
    };
  }
  const centerYFrac = part.centerYFrac ?? part.radiusFrac;
  const pitchRad = part.pitchRad ?? 0;
  const rise = DMath.sin(pitchRad) * length * 0.5;
  return {
    centerYFrac,
    pitchRad,
    startYFrac: centerYFrac + rise,
    endYFrac: centerYFrac - rise,
  };
}
