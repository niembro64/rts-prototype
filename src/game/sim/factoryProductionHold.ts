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

const FACTORY_SHELL_MIN_HOLD_CLEARANCE = 36;

export type FactoryProductionHoldVisual = {
  localOffsetX: number;
  localOffsetY: number;
  localBaseZ: number;
  ringRadius: number;
};

export function getFactoryShellSpawnClearanceAboveSurface(
  bp: Pick<UnitBlueprint, 'bodyCenterHeight' | 'radius'>,
): number {
  return Math.max(
    FACTORY_SHELL_MIN_HOLD_CLEARANCE,
    UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
    bp.bodyCenterHeight,
    bp.radius.collision * 0.75,
  );
}

export function productionHoldRingRadiusForProducedUnit(
  unitBlueprintId: string,
): number {
  const bp = getUnitBlueprint(unitBlueprintId);
  return Math.max(16, bp.radius.other * 2.1, bp.radius.collision * 1.75);
}

function productionHoldLocalBaseZ(factory: Entity, produced: UnitBlueprint): number {
  if (factory.buildingBlueprintId === 'towerFabricator') {
    return fabricatorTorusHoverHeight();
  }
  return (factory.unit?.bodyCenterHeight ?? 0) + getFactoryShellSpawnClearanceAboveSurface(produced);
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
  const mountIndex = hostBp.turrets.findIndex((mount) =>
    mount.producedBlueprintId === producedUnitBlueprintId);
  if (mountIndex < 0) return { x: 0, y: 0, slotIndex: 0, hostAnchored: false };
  const mount = hostBp.turrets[mountIndex];
  const hostAnchored = mount.productionHoldAnchor === 'host';
  const runtimeMount = factory.combat?.turrets[mountIndex]?.mount;
  if (runtimeMount !== undefined) {
    return { x: runtimeMount.x, y: runtimeMount.y, slotIndex: mountIndex, hostAnchored };
  }
  const blueprintMount = mount.mount;
  const radius = hostUnit.radius.other;
  return {
    x: blueprintMount.x * radius,
    y: blueprintMount.y * radius,
    slotIndex: mountIndex,
    hostAnchored,
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
  };
}
