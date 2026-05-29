// Stable blueprint ids shared by config, network coding, and event routing.
// Keep these arrays append-only where they are used for wire codes.

export const UNIT_TYPE_IDS = [
  'jackal', 'lynx', 'badger', 'mongoose', 'mammoth',
  'tick', 'tarantula', 'loris', 'daddy', 'widow',
  'formik', 'hippo', 'commander', 'mosquito', 'dragonfly',
  'eagle', 'constructionDrone',
] as const;
export type UnitTypeId = typeof UNIT_TYPE_IDS[number];

export const BUILDING_TYPE_IDS = [
  'solar', 'wind', 'factory', 'extractor', 'megaBeamTower', 'cannonTower', 'radar', 'resourceConverter',
] as const;

export const SHOT_IDS = [
  'lightShot',
  'mediumShot',
  'lightRocket',
  'heavyShot',
  'mortarShot',
  'disruptorShot',
  'beamShot',
  'megaBeamShot',
  'towerBeamShot',
  'miniBeamShot',
  'fastRocket',
  'megaMortarShot',
  'forceFieldBarrierShot',
] as const;
export type ShotId = typeof SHOT_IDS[number];

export const TURRET_IDS = [
  'turretGunLight',
  'turretRocketSlow',
  'turretCannon',
  'turretMortarSlow',
  'turretGunBurst',
  'turretMortarFast',
  'turretGatling',
  'turretDisruptor',
  'turretForceFieldPanel',
  'turretBeam',
  'turretBeamMega',
  'turretForceFieldSphere',
  'turretConstruction',
  'turretBeamLong',
  'turretBeamMini',
  'turretCannonLong',
  'turretMortarDrop',
  'turretRocketFast',
] as const;
export type TurretId = typeof TURRET_IDS[number];

const UNIT_TYPE_ID_SET = new Set<string>(UNIT_TYPE_IDS);
const SHOT_ID_SET = new Set<string>(SHOT_IDS);
const TURRET_ID_SET = new Set<string>(TURRET_IDS);

export function isUnitTypeId(value: string): value is UnitTypeId {
  return UNIT_TYPE_ID_SET.has(value);
}

export function isShotId(value: string): value is ShotId {
  return SHOT_ID_SET.has(value);
}

export function isTurretId(value: string): value is TurretId {
  return TURRET_ID_SET.has(value);
}
