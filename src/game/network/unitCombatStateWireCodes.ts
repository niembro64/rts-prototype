import type {
  CombatFireState,
  CombatTrajectoryMode,
  UnitMoveState,
} from '../sim/types';

/**
 * Unit combat/move-state wire codes shared by the snapshot encode and
 * decode paths so the positional mappings cannot drift apart.
 * Append-only: wire codes are positional. Unknown values encode as 0
 * and unknown codes decode to the code-0 state.
 */

export function fireStateToWireCode(value: CombatFireState | null | undefined): number {
  return value === 'fireAtAll'
    ? 4
    : value === 'defend'
      ? 3
      : value === 'holdFire'
        ? 2
        : value === 'returnFire'
          ? 1
          : 0;
}

export function unitFireStateFromWireCode(code: number): CombatFireState {
  return code === 4
    ? 'fireAtAll'
    : code === 3
      ? 'defend'
      : code === 2
        ? 'holdFire'
        : code === 1
          ? 'returnFire'
          : 'fireAtWill';
}

export function trajectoryModeToWireCode(value: CombatTrajectoryMode | null | undefined): number {
  return value === 'auto' ? 2 : value === 'high' ? 1 : 0;
}

export function trajectoryModeFromWireCode(code: number): CombatTrajectoryMode {
  return code === 2 ? 'auto' : code === 1 ? 'high' : 'low';
}

/** Shared by the unit moveState and factory moveState fields; both ride
 *  the same maneuver/holdPosition/roam mapping. */
export function moveStateToWireCode(value: UnitMoveState | null | undefined): number {
  return value === 'roam' ? 2 : value === 'holdPosition' ? 1 : 0;
}

export function unitMoveStateFromWireCode(code: number): UnitMoveState {
  return code === 2 ? 'roam' : code === 1 ? 'holdPosition' : 'maneuver';
}
