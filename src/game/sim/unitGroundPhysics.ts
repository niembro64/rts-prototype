import {
  UNIT_GROUND_CONTACT_EPSILON,
  UNIT_GROUND_FRICTION_PER_60HZ_FRAME,
} from '../../config';
import type { Unit } from './types';
import { dampFromFrictionPer60HzFrame } from './motionFriction';

export type GroundNormal = { nx: number; ny: number; nz: number };
export { UNIT_GROUND_CONTACT_EPSILON };

let cachedGroundDampDtSec = -1;
let cachedGroundDamp = 1;

function getUnitGroundPointZ(unit: Unit, bodyCenterZ: number): number {
  return bodyCenterZ - unit.bodyCenterHeight;
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


export function getUnitGroundFrictionDamp(dtSec: number): number {
  if (dtSec === cachedGroundDampDtSec) return cachedGroundDamp;
  if (dtSec <= 0) return 1;
  cachedGroundDampDtSec = dtSec;
  cachedGroundDamp = dampFromFrictionPer60HzFrame(
    UNIT_GROUND_FRICTION_PER_60HZ_FRAME,
    dtSec,
  );
  return cachedGroundDamp;
}
