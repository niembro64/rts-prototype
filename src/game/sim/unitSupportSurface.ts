import type { UnitSupportSurface } from './types';

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

