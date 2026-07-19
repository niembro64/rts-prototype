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

export function isUnitGroundPenetrationInContact(penetration: number): boolean {
  return penetration >= -UNIT_GROUND_CONTACT_EPSILON;
}
