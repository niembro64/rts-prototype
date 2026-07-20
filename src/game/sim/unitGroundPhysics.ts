import { UNIT_GROUND_CONTACT_EPSILON } from '../../config';
import type { Unit } from './types';

export { UNIT_GROUND_CONTACT_EPSILON };

function getUnitGroundPointZ(unit: Unit, bodyCenterZ: number): number {
  return bodyCenterZ - unit.supportPointOffsetZ;
}

export function getUnitGroundPenetration(
  unit: Unit,
  bodyCenterZ: number,
  groundZ: number,
): number {
  return groundZ - getUnitGroundPointZ(unit, bodyCenterZ);
}

/**
 * Locomotion considers a support reachable before the unit's authored
 * support point physically touches it. The reach is the body collision
 * radius, which lets a large hull engage its ground drive and align to a
 * shoreline while its collision spring is still closing the final gap.
 *
 * This is intentionally distinct from the physics integrator's actual
 * collision test: that one remains at `UNIT_GROUND_CONTACT_EPSILON` so this
 * classification cannot create a hovering collision response.
 */
export function isUnitGroundPenetrationInContact(
  penetration: number,
  collisionRadius: number,
): boolean {
  const locomotionReach = Number.isFinite(collisionRadius) && collisionRadius > 0
    ? collisionRadius
    : UNIT_GROUND_CONTACT_EPSILON;
  return penetration >= -locomotionReach;
}
