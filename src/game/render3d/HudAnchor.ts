import type { Entity, Turret } from '../sim/types';
import { getUnitBlueprint } from '../sim/blueprints';
import { getBuildingBlueprint } from '../sim/blueprints/buildings';
import { getBodyTopY, getChassisLiftY } from '../math/BodyDimensions';
import type { EntityHudBlueprint } from '@/types/blueprints';
import {
  getConeBarrelTipOrbitRadius,
  getSimpleMultiBarrelOrbitRadius,
  getTurretBarrelCenterToTipLength,
  getTurretBarrelDiameter,
  getTurretHeadRadius,
} from '../math';
import { getBuildingVisualTopZ } from '../sim/buildingAnchors';
import { getUnitGroundZ } from '../sim/unitGeometry';
import {
  DEFAULT_BUILDING_HUD_LAYOUT,
  ENTITY_HUD_BAR_STACK_GAP,
  ENTITY_HUD_BAR_STACK_ROWS,
  ENTITY_HUD_NAME_GAP_ABOVE_BARS,
  DEFAULT_UNIT_HUD_LAYOUT,
} from '@/entityHudConfig';
import { SHELL_BAR_WORLD_HEIGHT } from '@/shellConfig';
import { NAME_LABEL_WORLD_HEIGHT } from '@/nameLabelConfig';

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
    orbitUp = Math.abs(Math.cos(pitch))
      * getSimpleMultiBarrelOrbitRadius(barrel, headRadius);
  } else if (barrel.type === 'coneMultiBarrel') {
    const tipOrbitR = getConeBarrelTipOrbitRadius(
      barrel,
      headRadius,
      barrelLen,
      turret.config.spread?.angle,
    );
    orbitUp = Math.abs(Math.cos(pitch)) * tipOrbitR;
  }
  return mountY + forwardUp + orbitUp + getBarrelRadius(turret);
}

export function getUnitHudTopY(unit: Entity): number {
  if (!unit.unit) return unit.transform.z;
  const unitRadius = unit.unit.radius.body;
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
  const turrets = unit.combat?.turrets ?? [];
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

function getHudNameYFromBarsY(barsY: number): number {
  const rows = Math.max(1, Math.floor(ENTITY_HUD_BAR_STACK_ROWS));
  const topBarCenterOffset = (rows - 1) * (SHELL_BAR_WORLD_HEIGHT + ENTITY_HUD_BAR_STACK_GAP);
  const topBarTopOffset = topBarCenterOffset + SHELL_BAR_WORLD_HEIGHT / 2;
  return (
    barsY +
    topBarTopOffset +
    ENTITY_HUD_NAME_GAP_ABOVE_BARS +
    NAME_LABEL_WORLD_HEIGHT / 2
  );
}

export function getUnitHudNameY(unit: Entity): number {
  return getHudNameYFromBarsY(getUnitHudBarsY(unit));
}

export function getBuildingHudNameY(building: Entity): number {
  return getHudNameYFromBarsY(getBuildingHudBarsY(building));
}
