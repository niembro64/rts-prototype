import {
  UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
} from '../../config';
import { deterministicMath as DMath } from './deterministicMath';
import type { UnitBlueprint } from './blueprints/types';
import {
  fabricatorTorusHoverHeight,
  fabricatorTorusRingRadius,
  getUnitBlueprint,
} from './blueprints';
import type { Entity } from './types';
import type { EntityHoldSpec } from './entityHolds';
import { productionHoldRingRadiusForUnitRadius } from './productionHoldGeometry';
import { getUnitGroundZ } from './unitGeometry';

const FACTORY_SHELL_MIN_HOLD_CLEARANCE = 36;

type FactoryProductionHoldVisual = {
  localOffsetX: number;
  localOffsetY: number;
  localBaseZ: number;
  ringRadius: number;
  ringOrientation: FactoryProductionHoldRingOrientation;
};

type FactoryProductionHoldRingOrientation = 'horizontal' | 'forward';

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

function mixFactorySpraySeed(value: number): number {
  let mixed = value | 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

/**
 * Pick the fabricator's work-spray origin from the visible torus
 * circumference. The hash is deterministic simulation presentation: every
 * active tick selects a new random-looking point without consuming gameplay
 * RNG or making replay state depend on a cosmetic effect.
 */
export function writeFabricatorProductionSprayOrigin(
  factory: Entity,
  tick: number,
  targetId: number,
  pointIndex: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const building = factory.building;
  if (building === null || factory.buildingBlueprintId !== 'towerFabricator') {
    out.x = factory.transform.x;
    out.y = factory.transform.y;
    out.z = factory.transform.z;
    return out;
  }
  const seed = mixFactorySpraySeed(
    Math.imul(factory.id, 0x45d9f3b) ^
      Math.imul(targetId, 0x27d4eb2d) ^
      Math.imul(tick + 1, 0x9e3779b9) ^
      Math.imul(pointIndex + 1, 0x632be5ab),
  );
  const angle = (seed / 0x100000000) * Math.PI * 2;
  // Footprint dims: width/height are horizontal; depth is vertical and was
  // wrongly passed here (benign only because the torus footprint is square).
  const ringRadius = fabricatorTorusRingRadius(building.width, building.height);
  out.x = factory.transform.x + DMath.cos(angle) * ringRadius;
  out.y = factory.transform.y + DMath.sin(angle) * ringRadius;
  out.z = getUnitGroundZ(factory) + fabricatorTorusHoverHeight();
  return out;
}

function productionHoldLocalBaseZ(
  factory: Entity,
  produced: UnitBlueprint,
  hostOffsetZ: number,
): number {
  if (factory.buildingBlueprintId === 'towerFabricator') {
    // EntityHold adds the produced unit's support-point offset when resolving
    // its transform. Subtract it here so the unit's actual body center, not
    // its footprint/support plane, is pinned to the torus center plane.
    return fabricatorTorusHoverHeight() - produced.supportPointOffsetZ;
  }
  if (factory.unit !== null) {
    return factory.unit.supportPointOffsetZ + hostOffsetZ;
  }
  return getFactoryShellSpawnClearanceAboveSurface(produced);
}

function productionHoldRingOrientation(): FactoryProductionHoldRingOrientation {
  return 'horizontal';
}

function productionHoldLocalOffset(factory: Entity, producedUnitBlueprintId: string): {
  x: number;
  y: number;
  z: number;
  slotIndex: number;
  hostAnchored: boolean;
} {
  const hostUnit = factory.unit;
  if (hostUnit === null) return { x: 0, y: 0, z: 0, slotIndex: 0, hostAnchored: false };
  const hostBp = getUnitBlueprint(hostUnit.unitBlueprintId);
  if (hostBp.factoryProducedUnitBlueprintId !== producedUnitBlueprintId) {
    return { x: 0, y: 0, z: 0, slotIndex: 0, hostAnchored: false };
  }
  const point = hostBp.workEmitter?.points[0] ?? { x: 0, y: 0, z: 0 };
  const radius = hostUnit.radius.other;
  return {
    x: point.x * radius,
    y: point.y * radius,
    z: point.z * radius,
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
    localBaseZ: productionHoldLocalBaseZ(factory, produced, localOffset.z),
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
    localBaseZ: productionHoldLocalBaseZ(factory, produced, localOffset.z),
    ringRadius: productionHoldRingRadiusForProducedUnit(producedUnitBlueprintId),
    ringOrientation: productionHoldRingOrientation(),
  };
}
