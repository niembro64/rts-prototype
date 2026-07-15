import type {
  LocomotionMediumNavigation,
  UnitLocomotion,
  UnitLocomotionMediumPhysics,
} from '@/types/locomotionTypes';

export const LOCOMOTION_MEDIUM_NAVIGATION_VALUES = [
  'air-only',
  'water-only',
  'air-and-water',
] as const satisfies readonly LocomotionMediumNavigation[];

const MEDIUM_POLICY: Record<
  LocomotionMediumNavigation,
  Readonly<{ air: boolean; water: boolean }>
> = {
  'air-only': { air: true, water: false },
  'water-only': { air: false, water: true },
  'air-and-water': { air: true, water: true },
};

export type LocomotionRouteCapabilities = Readonly<{
  allowOnGround: boolean;
  allowInAir: boolean;
  allowInWater: boolean;
}>;

export function isLocomotionMediumNavigation(
  value: unknown,
): value is LocomotionMediumNavigation {
  return (LOCOMOTION_MEDIUM_NAVIGATION_VALUES as readonly unknown[]).includes(value);
}

function hasHorizontalRouteAuthority(physics: UnitLocomotionMediumPhysics): boolean {
  return physics.driveForce > 0 && physics.traction > 0;
}

function hasAirLiftAuthority(physics: UnitLocomotionMediumPhysics): boolean {
  return physics.buoyancy > 0 || physics.heightUpwardForce > 0;
}

/** Resolve the single effective route-domain contract used by pathfinding,
 * validation, UI diagnostics, and primary-drive selection. */
export function resolveLocomotionRouteCapabilities(
  locomotion: UnitLocomotion,
): LocomotionRouteCapabilities {
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

export function hasAnyLocomotionRouteCapability(
  capabilities: LocomotionRouteCapabilities,
): boolean {
  return capabilities.allowOnGround || capabilities.allowInAir || capabilities.allowInWater;
}
