import type { TurretBlueprint } from '@/types/blueprints';
import { getRayBlueprint } from '../sim/blueprints';
import {
  TURRET_BARREL_MIN_DIAMETER,
  getConeBarrelBaseOrbitRadius,
  getConeBarrelTipOrbitRadius,
  getSimpleMultiBarrelOrbitRadius,
  getTurretBarrelCenterToTipLength,
} from '../math';

export type DebrisBarrelProfile =
  | {
      type: 'singleCylinderBarrel';
      length: number;
      thickness: number;
    }
  | {
      type: 'singleConeBarrel';
      length: number;
      thickness: number;
    }
  | {
      type: 'simpleMultiBarrel';
      length: number;
      thickness: number;
      barrelCount: number;
      orbit: number;
    }
  | {
      type: 'coneMultiBarrel';
      length: number;
      thickness: number;
      barrelCount: number;
      baseOrbit: number;
      tipOrbit: number;
    };

export function getDebrisBarrelProfile(
  turret: TurretBlueprint,
  headRadius: number,
): DebrisBarrelProfile | null {
  const barrel = turret.barrel;
  const length = getTurretBarrelCenterToTipLength(turret);
  if (length < 1) return null;

  if (barrel.type === 'singleCylinderBarrel' || barrel.type === 'singleConeBarrel') {
    const diameter = getRayConfigWidth(turret) ??
      barrel.barrelThickness ??
      TURRET_BARREL_MIN_DIAMETER;
    return {
      type: barrel.type,
      length,
      thickness: Math.max(diameter, TURRET_BARREL_MIN_DIAMETER) / 2,
    };
  }

  if (barrel.type === 'simpleMultiBarrel') {
    const diameter = barrel.barrelThickness ?? TURRET_BARREL_MIN_DIAMETER;
    return {
      type: 'simpleMultiBarrel',
      length,
      thickness: Math.max(diameter, TURRET_BARREL_MIN_DIAMETER) / 2,
      barrelCount: barrel.barrelCount,
      orbit: getSimpleMultiBarrelOrbitRadius(barrel, headRadius),
    };
  }

  if (barrel.type === 'coneMultiBarrel') {
    const diameter = barrel.barrelThickness ?? TURRET_BARREL_MIN_DIAMETER;
    return {
      type: 'coneMultiBarrel',
      length,
      thickness: Math.max(diameter, TURRET_BARREL_MIN_DIAMETER) / 2,
      barrelCount: barrel.barrelCount,
      baseOrbit: getConeBarrelBaseOrbitRadius(barrel, headRadius),
      tipOrbit: getConeBarrelTipOrbitRadius(
        barrel,
        headRadius,
        length,
        turret.spread?.angle,
      ),
    };
  }

  return null;
}

function getRayConfigWidth(turret: TurretBlueprint): number | undefined {
  if (turret.emissionKind !== 'ray' || !turret.emissionBlueprintId) return undefined;
  try {
    return getRayBlueprint(turret.emissionBlueprintId).width;
  } catch {
    return undefined;
  }
}
