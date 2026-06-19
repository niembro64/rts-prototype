import type { EntityId, UnitSupportSurface } from './types';

export type UnitSupportQueryOptions = {
  bodyZ?: number;
  groundOffset?: number;
  ignoreEntityId?: EntityId | null;
};

export function cloneUnitSupportSurface(
  surface: UnitSupportSurface | undefined,
): UnitSupportSurface {
  if (surface === undefined || surface.kind === 'none') {
    return { kind: 'none' };
  }
  return {
    kind: 'discTop',
    topZ: surface.topZ,
    radius: surface.radius,
  };
}

