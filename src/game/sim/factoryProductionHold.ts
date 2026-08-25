import {
  UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
} from '../../config';
import { deterministicMath as DMath } from './deterministicMath';
import type { UnitBlueprint } from './blueprints/types';
import {
  fabricatorProductionPlaneHeight,
  getUnitBlueprint,
} from './blueprints';
import { fabricatorTorusRingRadius } from './fabricatorGeometry';
import {
  isDirectionalFabricatorBuildingBlueprintId,
  isFabricatorBuildingBlueprintId,
  isRadialFabricatorBuildingBlueprintId,
} from './blueprints/buildings';
import type { Entity } from './types';
import type { EntityHoldSpec } from './entityHolds';
import { productionHoldRingRadiusForUnitRadius } from './productionHoldGeometry';
import { getUnitGroundZ } from './unitGeometry';
import { writeWorkEmitterOriginWorld } from './workEmitterOrigin';
import { getBuildingConfig } from './buildConfigs';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { getConstructionHostMarkingProfiles } from '@/constructionVisualConfig';
import {
  fabricatorConstructionBoxAngle,
  fabricatorConstructionEmitterHeight,
  fabricatorConstructionRingPhase,
} from './fabricatorConstructionRing';

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
 * Pick the fabricator's work-spray origin from one visible telescoping emitter
 * head on the rotating outer race. The hash is deterministic simulation
 * presentation: every active tick selects a new random-looking head without
 * consuming gameplay RNG or making replay state depend on a cosmetic effect.
 */
export function writeFabricatorProductionSprayOrigin(
  factory: Entity,
  tick: number,
  simulationTickRateHz: number,
  targetId: number,
  pointIndex: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const building = factory.building;
  if (building === null || !isFabricatorBuildingBlueprintId(factory.buildingBlueprintId)) {
    out.x = factory.transform.x;
    out.y = factory.transform.y;
    out.z = factory.transform.z;
    return out;
  }
  if (isDirectionalFabricatorBuildingBlueprintId(factory.buildingBlueprintId)) {
    // Specialists own paired (or advanced four-point) nano arms on the two
    // sides of their open bay. Unlike a Universal ring, their work origin is
    // a real authored socket that rotates with the building facing.
    return writeWorkEmitterOriginWorld(factory, pointIndex, out);
  }
  const seed = mixFactorySpraySeed(
    Math.imul(factory.id, 0x45d9f3b) ^
      Math.imul(targetId, 0x27d4eb2d) ^
      Math.imul(tick + 1, 0x9e3779b9) ^
      Math.imul(pointIndex + 1, 0x632be5ab),
  );
  const ringBoxes = getConstructionHostMarkingProfiles(factory.buildingBlueprintId!)
    .find((profile) => profile.kind === 'ringBoxes');
  if (ringBoxes === undefined) {
    throw new Error(`${factory.buildingBlueprintId} requires construction ring boxes`);
  }
  const boxIndex = seed % ringBoxes.boxCount;
  const angle = factory.transform.rotation + fabricatorConstructionBoxAngle(
    fabricatorConstructionRingPhase(tick, simulationTickRateHz, factory.id),
    boxIndex,
    ringBoxes.boxCount,
  );
  // Footprint dims: width/height are horizontal; depth is vertical and was
  // wrongly passed here (benign only because the torus footprint is square).
  const ringRadius = fabricatorTorusRingRadius(building.width, building.height);
  const boxCenterRadius = ringRadius * (
    ringBoxes.ringRadius + ringBoxes.tubeRadius - ringBoxes.mountInset +
      ringBoxes.boxDepth * 0.5
  );
  out.x = factory.transform.x + DMath.cos(angle) * boxCenterRadius;
  out.y = factory.transform.y + DMath.sin(angle) * boxCenterRadius;
  out.z = getUnitGroundZ(factory) +
    fabricatorProductionPlaneHeight(factory.buildingBlueprintId!) +
    fabricatorConstructionEmitterHeight(ringRadius, ringBoxes.boxHeight);
  return out;
}

function productionHoldLocalBaseZ(
  factory: Entity,
  produced: UnitBlueprint,
  hostOffsetZ: number,
): number {
  if (isRadialFabricatorBuildingBlueprintId(factory.buildingBlueprintId)) {
    // EntityHold adds the produced unit's support-point offset when resolving
    // its transform. Subtract it here so the unit's actual body center, not
    // its footprint/support plane, is pinned to the torus center plane.
    return fabricatorProductionPlaneHeight(factory.buildingBlueprintId!) - produced.supportPointOffsetZ;
  }
  if (isDirectionalFabricatorBuildingBlueprintId(factory.buildingBlueprintId)) {
    const planeHeight = fabricatorProductionPlaneHeight(factory.buildingBlueprintId!);
    return factory.building?.hoveringType === 'directionalFabricator'
      ? planeHeight - produced.supportPointOffsetZ
      : planeHeight;
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
  if (hostUnit === null) {
    if (isDirectionalFabricatorBuildingBlueprintId(factory.buildingBlueprintId)) {
      const config = getBuildingConfig(factory.buildingBlueprintId!);
      return {
        x: config.gridWidth * BUILD_GRID_CELL_SIZE * 0.08,
        y: 0,
        z: 0,
        slotIndex: 0,
        hostAnchored: true,
      };
    }
    return { x: 0, y: 0, z: 0, slotIndex: 0, hostAnchored: false };
  }
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
  const rotatesWithFactory = localOffset.hostAnchored;
  const isMobileFactory = factory.unit !== null && rotatesWithFactory;
  return {
    kind: 'production',
    slotIndex: localOffset.slotIndex,
    localOffsetX: localOffset.x,
    localOffsetY: localOffset.y,
    localBaseZ: productionHoldLocalBaseZ(factory, produced, localOffset.z),
    rotateWithHolder: rotatesWithFactory,
    inheritHolderRotation: rotatesWithFactory,
    inheritHolderVelocity: isMobileFactory,
  };
}

/** First safe point beyond a specialist's open +X mouth. The held shell can
 * overlap its static factory while being built (the physics spawn path owns a
 * temporary ignore pair), then this point makes it leave that body before
 * following the player-authored rally route. */
export function getDirectionalFactoryExitPoint(
  factory: Entity,
  produced: Entity,
  mapWidth: number,
  mapHeight: number,
): { x: number; y: number; z: number } | null {
  const buildingBlueprintId = factory.buildingBlueprintId;
  const unit = produced.unit;
  if (
    unit === null ||
    !isDirectionalFabricatorBuildingBlueprintId(buildingBlueprintId)
  ) return null;
  const config = getBuildingConfig(buildingBlueprintId!);
  const localHalfWidth = config.gridWidth * BUILD_GRID_CELL_SIZE * 0.5;
  const distance = localHalfWidth + unit.radius.collision + BUILD_GRID_CELL_SIZE;
  const cos = factory.transform.rotCos ?? DMath.cos(factory.transform.rotation);
  const sin = factory.transform.rotSin ?? DMath.sin(factory.transform.rotation);
  const margin = Math.max(BUILD_GRID_CELL_SIZE, unit.radius.collision);
  const x = Math.max(margin, Math.min(mapWidth - margin, factory.transform.x + cos * distance));
  const y = Math.max(margin, Math.min(mapHeight - margin, factory.transform.y + sin * distance));
  return { x, y, z: getUnitGroundZ(factory) };
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
