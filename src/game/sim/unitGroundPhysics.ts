import {
  UNIT_GROUND_FRICTION_PER_60HZ_FRAME,
} from '../../config';
import sharedSimConstants from '../../sharedSimConstants.json';
import type { Unit } from './types';

export type GroundNormal = { nx: number; ny: number; nz: number };

export const UNIT_GROUND_CONTACT_EPSILON = sharedSimConstants.unitGroundContactEpsilon;

let cachedGroundDampDtSec = -1;
let cachedGroundDamp = 1;

export function getUnitGroundPointZ(unit: Unit, bodyCenterZ: number): number {
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

export function isUnitGroundPointAtOrBelowTerrain(
  unit: Unit,
  bodyCenterZ: number,
  groundZ: number,
): boolean {
  return isUnitGroundPenetrationInContact(
    getUnitGroundPenetration(unit, bodyCenterZ, groundZ),
  );
}

export function getUnitGroundFrictionDamp(dtSec: number): number {
  if (dtSec === cachedGroundDampDtSec) return cachedGroundDamp;
  if (dtSec <= 0) return 1;
  const friction = UNIT_GROUND_FRICTION_PER_60HZ_FRAME;
  if (!Number.isFinite(friction) || friction <= 0) return 1;
  if (friction >= 1) return 0;
  cachedGroundDampDtSec = dtSec;
  cachedGroundDamp = Math.pow(1 - friction, dtSec * 60);
  return cachedGroundDamp;
}

