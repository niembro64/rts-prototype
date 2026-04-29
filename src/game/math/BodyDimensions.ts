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

import type { UnitBlueprint, UnitBodyShape, UnitBodyShapePart } from '@/types/blueprints';

function circleYFrac(radiusFrac: number, yFrac?: number): number {
  return yFrac ?? radiusFrac;
}

const TOP_Y_CACHE: Map<string, number> = new Map();
const BODY_PART_CONTAIN_EPS = 1e-6;

export const TREAD_CHASSIS_LIFT_Y = 10;
export const LEG_BODY_LIFT_FRAC = 0.5;

/** World-space lift applied to the visible body/chassis above the unit's
 *  ground footprint. This is shared by sim muzzle math and renderer
 *  scenegraph layout so projectiles leave the visual turret, not the old
 *  unlifted chassis position. */
export function getChassisLiftY(
  blueprint: Pick<UnitBlueprint, 'locomotion'> | undefined,
  unitRadius: number,
): number {
  const loc = blueprint?.locomotion;
  if (!loc) return 0;
  switch (loc.type) {
    case 'treads':
      return TREAD_CHASSIS_LIFT_Y;
    case 'wheels': {
      const wheelR = Math.max(1, unitRadius * loc.config.wheelRadius);
      return 2 * wheelR;
    }
    case 'legs':
      return unitRadius * LEG_BODY_LIFT_FRAC;
  }
}

/** Body-top height in unit-radius-1 space for the given renderer id.
 *  Multiply by a unit's render radius to get the world-space Y where
 *  the turret mounts (and therefore the barrel base height). */
export function getBodyTopFrac(bodyShape: UnitBodyShape): number {
  const key = JSON.stringify(bodyShape);
  const cached = TOP_Y_CACHE.get(key);
  if (cached !== undefined) return cached;
  const spec = bodyShape;
  let topY = 0;
  if (spec.kind === 'polygon') {
    topY = spec.heightFrac;
  } else if (spec.kind === 'rect') {
    topY = spec.heightFrac;
  } else if (spec.kind === 'circle') {
    topY = 2 * circleYFrac(spec.radiusFrac, spec.yFrac);
  } else if (spec.kind === 'oval') {
    topY = 2 * spec.yFrac;
  } else {
    for (const p of spec.parts) {
      const segTop = p.kind === 'circle'
        ? 2 * circleYFrac(p.radiusFrac, p.yFrac)
        : 2 * p.yFrac;
      if (segTop > topY) topY = segTop;
    }
  }
  TOP_Y_CACHE.set(key, topY);
  return topY;
}

/** World-space body-top Y for a unit with the given renderer and
 *  physical radius (unit.unitRadiusCollider.push). */
export function getBodyTopY(bodyShape: UnitBodyShape, unitRadius: number): number {
  return getBodyTopFrac(bodyShape) * unitRadius;
}

function bodyPartTopFrac(part: UnitBodyShapePart): number {
  return part.kind === 'circle'
    ? 2 * circleYFrac(part.radiusFrac, part.yFrac)
    : 2 * part.yFrac;
}

function bodyPartNormalizedDistanceSq(
  part: UnitBodyShapePart,
  forwardX: number,
  lateralY: number,
): number {
  const dx = forwardX - part.offsetForward;
  const dy = lateralY - (part.offsetLateral ?? 0);
  if (part.kind === 'circle') {
    const r = Math.max(part.radiusFrac, BODY_PART_CONTAIN_EPS);
    return (dx * dx + dy * dy) / (r * r);
  }
  const rx = Math.max(part.xFrac, BODY_PART_CONTAIN_EPS);
  const ry = Math.max(part.zFrac, BODY_PART_CONTAIN_EPS);
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
}

/** World-space Y of the body top under a chassis-local mount point.
 *  Composite bodies select the body segment whose horizontal footprint
 *  contains the mount. That keeps widow beam turrets on the abdomen
 *  edge while allowing Formik's centered mortar to sit on its own
 *  thorax instead of the tallest rear segment. */
export function getBodyMountTopY(
  bodyShape: UnitBodyShape,
  unitRadius: number,
  mountX: number,
  mountY: number,
): number {
  const spec = bodyShape;
  if (spec.kind !== 'composite') return getBodyTopY(bodyShape, unitRadius);
  if (unitRadius <= BODY_PART_CONTAIN_EPS || spec.parts.length === 0) return 0;

  const targetX = mountX / unitRadius;
  const targetY = mountY / unitRadius;
  let best = spec.parts[0];
  let bestScore = Infinity;

  for (const part of spec.parts) {
    const score = bodyPartNormalizedDistanceSq(part, targetX, targetY);
    if (score < bestScore) {
      best = part;
      bestScore = score;
    }
  }

  return bodyPartTopFrac(best) * unitRadius;
}

/** World-space Y for the mid-height of whichever body segment sits
 *  closest to the given forward offset (forwardX is in WORLD units,
 *  same space as `unit.transform.x`). Used to place leg hips at the
 *  vertical midpoint of the segment they attach to: a leg in front of
 *  a composite spider body hooks into the small prosoma, a leg far
 *  behind hooks into the tall abdomen, and simple-bodied units just
 *  hook into their single segment. */
export function getSegmentMidYAt(
  bodyShape: UnitBodyShape,
  unitRadius: number,
  forwardX: number,
): number {
  const spec = bodyShape;
  if (spec.kind === 'polygon') {
    return spec.heightFrac * unitRadius / 2;
  }
  if (spec.kind === 'rect') {
    return spec.heightFrac * unitRadius / 2;
  }
  if (spec.kind === 'circle') {
    return circleYFrac(spec.radiusFrac, spec.yFrac) * unitRadius;
  }
  if (spec.kind === 'oval') {
    return spec.yFrac * unitRadius;
  }
  // Composite: find the segment whose center is nearest the leg's
  // forward-X (in unit-local coords, so divide by unitRadius to get
  // back into the same unit-radius-1 space the spec parts live in).
  const targetUL = forwardX / unitRadius;
  let best: UnitBodyShapePart = spec.parts[0];
  let bestDist = Math.abs(targetUL - best.offsetForward);
  for (const p of spec.parts) {
    const d = Math.abs(targetUL - p.offsetForward);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  if (best.kind === 'circle') return circleYFrac(best.radiusFrac, best.yFrac) * unitRadius;
  return best.yFrac * unitRadius;
}
