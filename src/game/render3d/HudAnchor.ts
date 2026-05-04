import type { Entity, Turret } from '../sim/types';
import { getUnitBlueprint } from '../sim/blueprints';
import { getBuildingBlueprint } from '../sim/blueprints/buildings';
import { getBodyTopY, getChassisLiftY } from '../math/BodyDimensions';
import type { EntityHudBlueprint } from '@/types/blueprints';
import {
  getTurretBarrelCenterToTipLength,
  getTurretBarrelDiameter,
  getTurretHeadRadius,
} from '../math';
import { BARREL_ORBIT_CLAMP_FRAC } from '../math/BarrelGeometry';
import { TURRET_HEIGHT } from '../../config';
import { getBuildingVisualTopZ } from '../sim/buildingAnchors';
import { getUnitGroundZ } from '../sim/unitGeometry';
import {
  DEFAULT_BUILDING_HUD_LAYOUT,
  DEFAULT_UNIT_HUD_LAYOUT,
} from '@/entityHudConfig';

function getBarrelRadius(turret: Turret): number {
  const barrel = turret.config.barrel;
  if (!barrel || barrel.type === 'complexSingleEmitter') return 0;
  return getTurretBarrelDiameter(turret.config) / 2;
}

function getBarrelTopAboveGround(turret: Turret, mountY: number): number {
  const barrel = turret.config.barrel;
  if (!barrel || barrel.type === 'complexSingleEmitter') return mountY;
  const pitch = turret.pitch ?? 0;
  const headRadius = getTurretHeadRadius(turret.config);
  const barrelLen = getTurretBarrelCenterToTipLength(turret.config);
  const forwardUp = Math.max(0, Math.sin(pitch)) * barrelLen;
  let orbitUp = 0;
  if (barrel.type === 'simpleMultiBarrel') {
    orbitUp = Math.abs(Math.cos(pitch)) * Math.min(
      barrel.orbitRadius * headRadius,
      TURRET_HEIGHT * BARREL_ORBIT_CLAMP_FRAC.parallel,
    );
  } else if (barrel.type === 'coneMultiBarrel') {
    const baseOrbitR = Math.min(barrel.baseOrbit * headRadius, TURRET_HEIGHT * BARREL_ORBIT_CLAMP_FRAC.coneBase);
    const tipOrbitR = barrel.tipOrbit !== undefined
      ? barrel.tipOrbit * headRadius
      : Math.min(
          baseOrbitR + barrelLen * Math.tan((turret.config.spread?.angle ?? Math.PI / 5) / 2),
          TURRET_HEIGHT * BARREL_ORBIT_CLAMP_FRAC.coneTip,
        );
    orbitUp = Math.abs(Math.cos(pitch)) * tipOrbitR;
  }
  return mountY + forwardUp + orbitUp + getBarrelRadius(turret);
}

export function getUnitHudTopY(unit: Entity): number {
  if (!unit.unit) return unit.transform.z;
  const unitRadius = unit.unit.bodyRadius;
  const groundY = getUnitGroundZ(unit);
  let topAboveGround = unitRadius;

  try {
    const bp = getUnitBlueprint(unit.unit.unitType);
    topAboveGround = Math.max(
      topAboveGround,
      getChassisLiftY(bp, unitRadius) + getBodyTopY(bp.bodyShape, unitRadius),
    );
  } catch {
    // Keep the radius fallback for partial/network-only unit records.
  }

  for (const panel of unit.unit.mirrorPanels ?? []) {
    topAboveGround = Math.max(topAboveGround, panel.topY);
  }

  const hasMirrors = (unit.unit.mirrorPanels?.length ?? 0) > 0;
  const turrets = unit.turrets ?? [];
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    const isForceField = turret.config.barrel?.type === 'complexSingleEmitter';
    const isMirrorHost = hasMirrors && i === 0;
    const mountY = turret.mount.z;
    const headRadius = getTurretHeadRadius(turret.config);
    if (!isForceField && !isMirrorHost) {
      topAboveGround = Math.max(topAboveGround, mountY + headRadius);
    }
    topAboveGround = Math.max(topAboveGround, getBarrelTopAboveGround(turret, mountY));
  }

  return groundY + topAboveGround;
}

export function getBuildingHudTopY(building: Entity): number {
  if (!building.building) return building.transform.z;
  return getBuildingVisualTopZ(building);
}

function getUnitHudLayout(unit: Entity): EntityHudBlueprint {
  const unitType = unit.unit?.unitType;
  if (!unitType) return DEFAULT_UNIT_HUD_LAYOUT;
  try {
    return getUnitBlueprint(unitType).hud ?? DEFAULT_UNIT_HUD_LAYOUT;
  } catch {
    return DEFAULT_UNIT_HUD_LAYOUT;
  }
}

function getBuildingHudLayout(building: Entity): EntityHudBlueprint {
  const buildingType = building.buildingType;
  if (!buildingType) return DEFAULT_BUILDING_HUD_LAYOUT;
  try {
    return getBuildingBlueprint(buildingType).hud ?? DEFAULT_BUILDING_HUD_LAYOUT;
  } catch {
    return DEFAULT_BUILDING_HUD_LAYOUT;
  }
}

export function getUnitHudBarsY(unit: Entity): number {
  return getUnitHudTopY(unit) + getUnitHudLayout(unit).barsOffsetAboveTop;
}

export function getBuildingHudBarsY(building: Entity): number {
  return getBuildingHudTopY(building) + getBuildingHudLayout(building).barsOffsetAboveTop;
}

export function getUnitHudNameY(unit: Entity): number {
  return getUnitHudTopY(unit) + getUnitHudLayout(unit).nameOffsetAboveTop;
}

export function getBuildingHudNameY(building: Entity): number {
  return getBuildingHudTopY(building) + getBuildingHudLayout(building).nameOffsetAboveTop;
}
