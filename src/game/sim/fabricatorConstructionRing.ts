const FABRICATOR_CONSTRUCTION_RING_SPIN_RADIANS_PER_SECOND = 0.9;
const FABRICATOR_CONSTRUCTION_RING_LIFT_FRACTION = 0.035;
const FABRICATOR_CONSTRUCTION_RING_MIN_LIFT = 4;

export function fabricatorConstructionRingLift(ringRadius: number): number {
  return Math.max(
    FABRICATOR_CONSTRUCTION_RING_MIN_LIFT,
    ringRadius * FABRICATOR_CONSTRUCTION_RING_LIFT_FRACTION,
  );
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
