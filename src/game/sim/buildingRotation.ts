/** Building facings are discrete simulation state, not free camera angles.
 * Keeping the canonical value here prevents placement, collision, rendering,
 * and factory output from disagreeing about which way a structure faces. */
export const BUILDING_ROTATION_STEP_RAD = Math.PI / 2;

/** Return the clockwise-normalized quarter-turn index in [0, 3]. */
export function getBuildingRotationQuarterTurns(rotation: number): number {
  if (!Number.isFinite(rotation)) return 0;
  return ((Math.round(rotation / BUILDING_ROTATION_STEP_RAD) % 4) + 4) % 4;
}

/** Snap a rotation to one of four exact, stable values.
 *
 * The fourth facing is represented as -PI/2 (instead of 3PI/2), matching the
 * game's normalized-angle convention while avoiding floating-point drift from
 * repeated build-facing key presses.
 */
export function snapBuildingRotation(rotation: number): number {
  switch (getBuildingRotationQuarterTurns(rotation)) {
    case 1:
      return BUILDING_ROTATION_STEP_RAD;
    case 2:
      return Math.PI;
    case 3:
      return -BUILDING_ROTATION_STEP_RAD;
    default:
      return 0;
  }
}
