// BodyDimensions — sim-safe (no-THREE) body-shape height math.
//
// The 3D renderer builds each unit's chassis as spheres/spheroids
// (smooth shapes) or extruded prisms (angled shapes) with heights
// proportional to the horizontal dimensions — see BodyShape3D.ts for
// the render-side implementation.
//
// This module exposes body dimension math for chassis, legs, debris,
// and fallback helpers. Authoritative turret pivots are authored
// directly in unit blueprints as 3D mount points.

import type { TurretMount, UnitBlueprint, UnitBodyShape, UnitBodyShapePart } from '@/types/blueprints';

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

const TOP_Y_CACHE: Map<string, number> = new Map();
const BODY_PART_CONTAIN_EPS = 1e-6;

export const TREAD_CHASSIS_LIFT_Y = 10;

/** Stable identity for a unit body shape. This is the only render/cache
 *  key for chassis geometry; unit blueprints author bodyShape, not a
 *  second renderer id that can drift from the actual geometry. */
export function getUnitBodyShapeKey(bodyShape: UnitBodyShape): string {
  return JSON.stringify(bodyShape);
}


/** Chassis-local Y of the visible body's vertical center. Unit body
 *  shapes are built from terrain-up: bottoms at local Y=0 and tops at
 *  getBodyTopY, so the center is the midpoint of that authored volume. */
function getBodyCenterLocalY(
  bodyShape: UnitBodyShape,
  unitRadius: number,
): number {
  return getBodyTopY(bodyShape, unitRadius) * 0.5;
}






/** World-space lift applied to the visible body/chassis above the unit's
 *  ground footprint. This is derived from bodyCenterHeight so the
 *  authored unit center is a hard contract shared by simulation,
 *  targeting, chassis rendering, and locomotion. */
export function getChassisLiftY(
  blueprint: Pick<UnitBlueprint, 'locomotion' | 'bodyShape' | 'bodyCenterHeight'> | undefined,
  unitRadius: number,
): number {
  if (!blueprint) return 0;
  return blueprint.bodyCenterHeight - getBodyCenterLocalY(blueprint.bodyShape, unitRadius);
}

/** Body-top height in unit-radius-1 space for the given body shape.
 *  Multiply by a unit's render radius to get the world-space Y where
 *  the turret mounts (and therefore the barrel base height). */
export function getBodyTopFrac(bodyShape: UnitBodyShape): number {
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
export function getBodyTopY(bodyShape: UnitBodyShape, unitRadius: number): number {
  return getBodyTopFrac(bodyShape) * unitRadius;
}

function bodyPartTopFrac(part: UnitBodyShapePart): number {
  if (part.kind === 'circle') return circleCenterYFrac(part) + circleYFrac(part.radiusFrac, part.yFrac);
  if (part.kind === 'oval') return 2 * part.yFrac;
  return (part.centerYFrac ?? part.radiusFrac) + part.radiusFrac;
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
  if (part.kind === 'cylinder' || part.kind === 'cone') {
    const halfLength = Math.max(part.lengthFrac * 0.5, BODY_PART_CONTAIN_EPS);
    const r = Math.max(part.radiusFrac, BODY_PART_CONTAIN_EPS);
    return (dx * dx) / (halfLength * halfLength) + (dy * dy) / (r * r);
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

/** Chassis-local Y where a turret root should be placed. Blueprint
 *  turret mounts can pin the turret-head center directly; callers pass
 *  headRadius so root + headRadius lands on the authored 3D mount. */
export function getTurretRootY(
  bodyShape: UnitBodyShape,
  unitRadius: number,
  mountX: number,
  mountY: number,
  headRadius: number,
  mount?: Pick<TurretMount, 'mount'>,
): number {
  if (mount?.mount !== undefined) {
    return mount.mount.z * unitRadius - headRadius;
  }
  return getBodyMountTopY(bodyShape, unitRadius, mountX, mountY);
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
  if (spec.kind === 'rect' || spec.kind === 'rhombus') {
    return spec.heightFrac * unitRadius / 2;
  }
  if (spec.kind === 'circle') {
    return circleCenterYFrac(spec) * unitRadius;
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
  if (best.kind === 'circle') return circleCenterYFrac(best) * unitRadius;
  if (best.kind === 'cylinder' || best.kind === 'cone') return (best.centerYFrac ?? best.radiusFrac) * unitRadius;
  return best.yFrac * unitRadius;
}
