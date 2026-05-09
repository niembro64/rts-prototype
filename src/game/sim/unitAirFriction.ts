import { UNIT_AIR_FRICTION_PER_60HZ_FRAME } from '../../config';

let cachedAirDampDtSec = -1;
let cachedAirDamp = 1;

export function getUnitAirFrictionDamp(dtSec: number): number {
  if (dtSec === cachedAirDampDtSec) return cachedAirDamp;
  if (dtSec <= 0) return 1;
  const friction = UNIT_AIR_FRICTION_PER_60HZ_FRAME;
  if (!Number.isFinite(friction) || friction <= 0) return 1;
  if (friction >= 1) return 0;
  cachedAirDampDtSec = dtSec;
  cachedAirDamp = Math.pow(1 - friction, dtSec * 60);
  return cachedAirDamp;
}
