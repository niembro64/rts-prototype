const FABRICATOR_CONSTRUCTION_RING_SPIN_RADIANS_PER_SECOND = 0.9;
const FABRICATOR_CONSTRUCTION_RING_LIFT_FRACTION = 0.035;
const FABRICATOR_CONSTRUCTION_RING_MIN_LIFT = 4;
/** The physically thinner stationary race nests just inside the mobile outer
 *  race with a narrow visible clearance. The outer edge meets the authored
 *  construction-box backs. Fractions are of the authoritative ring radius. */
export const FABRICATOR_INNER_RING_RADIUS_FRACTION = 0.94;
export const FABRICATOR_INNER_RING_TUBE_RADIUS_FRACTION = 0.055;
export const FABRICATOR_OUTER_RING_RADIUS_FRACTION = 1.08;
export const FABRICATOR_OUTER_RING_TUBE_RADIUS_FRACTION = 0.08;
const FABRICATOR_CONSTRUCTION_HEAD_BOX_HEIGHT_FRACTION = 0.22;
const FABRICATOR_CONSTRUCTION_HEAD_MIN_HEIGHT = 2;

export function fabricatorConstructionRingLift(ringRadius: number): number {
  return Math.max(
    FABRICATOR_CONSTRUCTION_RING_MIN_LIFT,
    ringRadius * FABRICATOR_CONSTRUCTION_RING_LIFT_FRACTION,
  );
}

/** Height of the compact emitter head seated on top of each construction box. */
export function fabricatorConstructionHeadHeight(
  ringRadius: number,
  authoredBoxHeightFraction: number,
): number {
  return Math.max(
    FABRICATOR_CONSTRUCTION_HEAD_MIN_HEIGHT,
    ringRadius * authoredBoxHeightFraction *
      FABRICATOR_CONSTRUCTION_HEAD_BOX_HEIGHT_FRACTION,
  );
}

/** Active spray socket above the rotating race's center plane. The box body
 *  stays attached to the race; its top emitter head rises by the piston lift. */
export function fabricatorConstructionEmitterHeight(
  ringRadius: number,
  authoredBoxHeightFraction: number,
): number {
  return ringRadius * authoredBoxHeightFraction * 0.5 +
    fabricatorConstructionHeadHeight(ringRadius, authoredBoxHeightFraction) +
    fabricatorConstructionRingLift(ringRadius);
}

/** Tick-derived phase shared by the authoritative spray socket and the
 * frontend rig, so every emitted particle starts on a visible moving box. */
export function fabricatorConstructionRingPhase(
  tick: number,
  simulationTickRateHz: number,
  entityId: number,
): number {
  const rate = Number.isFinite(simulationTickRateHz) && simulationTickRateHz > 0
    ? simulationTickRateHz
    : 20;
  const initialPhase = ((entityId * 0.6180339887498949) % 1) * Math.PI * 2;
  return initialPhase + tick / rate * FABRICATOR_CONSTRUCTION_RING_SPIN_RADIANS_PER_SECOND;
}

export function fabricatorConstructionBoxAngle(
  phase: number,
  boxIndex: number,
  boxCount: number,
): number {
  return phase + (boxIndex / Math.max(1, boxCount)) * Math.PI * 2;
}
