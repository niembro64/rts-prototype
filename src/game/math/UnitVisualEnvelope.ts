// Sim-safe vertical envelope math shared by gameplay geometry and layout
// contracts. This describes authored visible geometry rather than collision
// spheres: a tall, narrow unit must still fit below a factory.

import type { UnitBlueprint } from '@/types/blueprints';
import {
  getTurretBarrelCenterToTipLength,
  getTurretHeadRadius,
} from './BarrelGeometry';
import { getBodyTopY, getChassisLiftY } from './BodyDimensions';

/** Conservative maximum visible height above the unit's support plane.
 * Turret barrels are allowed their full center-to-tip rise so the result
 * remains correct for vertical launchers and articulated weapons without
 * coupling factory geometry to a turret's current pose. */
export function getUnitVisualTopAboveSupport(blueprint: UnitBlueprint): number {
  const radius = blueprint.radius.other;
  let top = Math.max(
    radius,
    getChassisLiftY(blueprint, radius) + getBodyTopY(blueprint.bodyShape, radius),
  );

  for (let i = 0; i < blueprint.turrets.length; i++) {
    const mount = blueprint.turrets[i];
    const presentation = mount.presentation;
    if (presentation === null) continue;
    const mountZ = mount.mount.z * radius;
    top = Math.max(
      top,
      mountZ + getTurretHeadRadius(presentation),
      mountZ + getTurretBarrelCenterToTipLength(presentation),
    );
  }

  return top;
}
