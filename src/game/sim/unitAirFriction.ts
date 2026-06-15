import { UNIT_AIR_FRICTION_PER_60HZ_FRAME } from '../../config';
import { dampFromFrictionPer60HzFrame } from './motionFriction';

let cachedAirDampDtSec = -1;
let cachedAirDamp = 1;

export function getUnitAirFrictionDamp(dtSec: number): number {
  if (dtSec === cachedAirDampDtSec) return cachedAirDamp;
  if (dtSec <= 0) return 1;
  cachedAirDampDtSec = dtSec;
  cachedAirDamp = dampFromFrictionPer60HzFrame(
    UNIT_AIR_FRICTION_PER_60HZ_FRAME,
    dtSec,
  );
  return cachedAirDamp;
}
