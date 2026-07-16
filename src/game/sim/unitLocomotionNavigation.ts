import type {
  UnitLocomotionMediumNavigation,
  UnitLocomotion,
  UnitLocomotionFluidPhysics,
  UnitLocomotionMediumPhysics,
} from '@/types/unitLocomotionTypes';

export const UNIT_LOCOMOTION_MEDIUM_NAVIGATION_VALUES = [
  'air-only',
  'water-only',
  'air-and-water',
] as const satisfies readonly UnitLocomotionMediumNavigation[];

const MEDIUM_POLICY: Record<
  UnitLocomotionMediumNavigation,
  Readonly<{ air: boolean; water: boolean }>
> = {
  'air-only': { air: true, water: false },
  'water-only': { air: false, water: true },
  'air-and-water': { air: true, water: true },
};

export type UnitLocomotionRouteCapabilities = Readonly<{
  allowOnGround: boolean;
  allowInAir: boolean;
  allowInWater: boolean;
}>;

export function isUnitLocomotionMediumNavigation(
  value: unknown,
): value is UnitLocomotionMediumNavigation {
  return (UNIT_LOCOMOTION_MEDIUM_NAVIGATION_VALUES as readonly unknown[]).includes(value);
}

function hasHorizontalRouteAuthority(physics: UnitLocomotionMediumPhysics): boolean {
  return physics.propulsion.driveForce > 0 && physics.propulsion.forceCoupling > 0;
}

function hasAirLiftAuthority(physics: UnitLocomotionFluidPhysics): boolean {
  return physics.lift.gravityCounterRatio > 0 ||
    physics.lift.liftForceFromGroundSurface > 0 ||
    physics.lift.liftForceFromWaterSurface > 0;
}

/** Resolve the single effective route-domain contract used by pathfinding,
 * validation, UI diagnostics, and primary-drive selection. */
export function resolveUnitLocomotionRouteCapabilities(
  locomotion: UnitLocomotion,
): UnitLocomotionRouteCapabilities {
  const mediumPolicy = MEDIUM_POLICY[locomotion.navigation.allowInMedium];
  return {
    allowOnGround:
      locomotion.navigation.allowOnGround &&
      hasHorizontalRouteAuthority(locomotion.physics.ground),
    allowInAir:
      mediumPolicy.air &&
      hasHorizontalRouteAuthority(locomotion.physics.air) &&
      hasAirLiftAuthority(locomotion.physics.air),
    allowInWater:
      mediumPolicy.water && hasHorizontalRouteAuthority(locomotion.physics.water),
  };
}

export function hasAnyUnitLocomotionRouteCapability(
  capabilities: UnitLocomotionRouteCapabilities,
): boolean {
  return capabilities.allowOnGround || capabilities.allowInAir || capabilities.allowInWater;
}
