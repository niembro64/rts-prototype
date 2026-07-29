import {
  UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
} from '../../config';
import type { UnitBlueprint } from './blueprints/types';
import {
  fabricatorTorusHoverHeight,
  getUnitBlueprint,
} from './blueprints';
import type { Entity } from './types';
import type { EntityHoldSpec } from './entityHolds';
import { productionHoldRingRadiusForUnitRadius } from './productionHoldGeometry';

const FACTORY_SHELL_MIN_HOLD_CLEARANCE = 36;

export type FactoryProductionHoldVisual = {
  localOffsetX: number;
  localOffsetY: number;
  localBaseZ: number;
  ringRadius: number;
  ringOrientation: FactoryProductionHoldRingOrientation;
};

export type FactoryProductionHoldRingOrientation = 'horizontal' | 'forward';

export type FactoryProductionPylonVisual = {
  localOffsetX: number;
  localOffsetY: number;
  localBaseZ: number;
};

export function getFactoryShellSpawnClearanceAboveSurface(
  bp: Pick<UnitBlueprint, 'supportPointOffsetZ' | 'radius'>,
): number {
  return Math.max(
    FACTORY_SHELL_MIN_HOLD_CLEARANCE,
    UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
    bp.supportPointOffsetZ,
    bp.radius.collision * 0.75,
  );
}

export function productionHoldRingRadiusForProducedUnit(
  unitBlueprintId: string,
): number {
  const bp = getUnitBlueprint(unitBlueprintId);
  return productionHoldRingRadiusForUnitRadius(bp.radius);
}

function productionHoldLocalBaseZ(factory: Entity, produced: UnitBlueprint): number {
  if (factory.buildingBlueprintId === 'towerFabricator') {
    return fabricatorTorusHoverHeight();
  }
  if (factory.unit !== null) return factory.unit.supportPointOffsetZ;
  return getFactoryShellSpawnClearanceAboveSurface(produced);
}

function productionHoldRingOrientation(factory: Entity): FactoryProductionHoldRingOrientation {
  return factory.unit !== null ? 'forward' : 'horizontal';
}

function productionHoldLocalOffset(factory: Entity, producedUnitBlueprintId: string): {
  x: number;
  y: number;
  slotIndex: number;
  hostAnchored: boolean;
} {
  const hostUnit = factory.unit;
  if (hostUnit === null) return { x: 0, y: 0, slotIndex: 0, hostAnchored: false };
  const hostBp = getUnitBlueprint(hostUnit.unitBlueprintId);
  if (hostBp.factoryProducedUnitBlueprintId !== producedUnitBlueprintId) {
    return { x: 0, y: 0, slotIndex: 0, hostAnchored: false };
  }
  const point = hostBp.workEmitter?.points[0] ?? { x: 0, y: 0, z: 0 };
  const radius = hostUnit.radius.other;
  return {
    x: point.x * radius,
    y: point.y * radius,
    slotIndex: 0,
    hostAnchored: true,
  };
}

export function createFactoryProductionHoldSpec(
  factory: Entity,
  producedUnitBlueprintId: string,
): EntityHoldSpec {
  const produced = getUnitBlueprint(producedUnitBlueprintId);
  const localOffset = productionHoldLocalOffset(factory, producedUnitBlueprintId);
  const isMobileFactory = factory.unit !== null && localOffset.hostAnchored;
  return {
    kind: 'production',
    slotIndex: localOffset.slotIndex,
    localOffsetX: localOffset.x,
    localOffsetY: localOffset.y,
    localBaseZ: productionHoldLocalBaseZ(factory, produced),
    rotateWithHolder: isMobileFactory,
    inheritHolderRotation: isMobileFactory,
    inheritHolderVelocity: isMobileFactory,
  };
}

export function getFactoryProductionHoldVisual(
  factory: Entity,
  producedUnitBlueprintId: string | null,
): FactoryProductionHoldVisual | null {
  if (producedUnitBlueprintId === null) return null;
  const produced = getUnitBlueprint(producedUnitBlueprintId);
  const localOffset = productionHoldLocalOffset(factory, producedUnitBlueprintId);
  return {
    localOffsetX: localOffset.x,
    localOffsetY: localOffset.y,
    localBaseZ: productionHoldLocalBaseZ(factory, produced),
    ringRadius: productionHoldRingRadiusForProducedUnit(producedUnitBlueprintId),
    ringOrientation: productionHoldRingOrientation(factory),
  };
}

export function getFactoryProductionPylonVisual(
  factory: Entity,
  producedUnitBlueprintId: string | null,
  turretIndex: number,
): FactoryProductionPylonVisual | null {
  void factory;
  void producedUnitBlueprintId;
  void turretIndex;
  // Construction pylons no longer exist. Retain the compatibility query for
  // callers compiled against the old render helper; it intentionally yields
  // no visual.
  return null;
}
