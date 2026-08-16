import { deterministicMath as DMath } from './deterministicMath';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, EntityId } from './types';
import type { WorldState } from './WorldState';
import { expandPathPoints } from './Pathfinder';
import { pathTerrainFilterForLocomotion } from './pathfindingTraversal';

const MIN_GROUP_FORMATION_SPACING = 40;
const COLLISION_GROUP_FORMATION_SPACING_MULTIPLIER = 2.25;

type ResolvedFormationTarget = {
  x: number;
  y: number;
  z: number;
};

type GroupFormationSlot = {
  unit: Entity;
  offsetX: number;
  offsetY: number;
};
export function clampToMap(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, value));
}

export function resolvePathableFormationTarget(
  world: WorldState,
  unit: Entity,
  targetX: number,
  targetY: number,
): ResolvedFormationTarget {
  const unitComponent = unit.unit;
  const x = clampToMap(targetX, world.mapWidth);
  const y = clampToMap(targetY, world.mapHeight);
  if (unitComponent === null) {
    return { x, y, z: world.getTerrainBedZ(x, y) };
  }

  const points = expandPathPoints(
    unit.transform.x,
    unit.transform.y,
    x,
    y,
    world.mapWidth,
    world.mapHeight,
    world.getTerrainBedZ(x, y),
    pathTerrainFilterForLocomotion(
      unitComponent.locomotion,
      unitComponent.mass,
      unitComponent.supportPointOffsetZ,
    ),
    unitComponent.radius.collision,
    world.slopePathMode === 'symmetric',
  );
  const final = points[points.length - 1];
  return final !== undefined
    ? { x: final.x, y: final.y, z: final.z ?? world.getTerrainBedZ(final.x, final.y) }
    : { x, y, z: world.getTerrainBedZ(x, y) };
}

function groupFormationSpacing(maxCollisionRadius: number): number {
  if (!Number.isFinite(maxCollisionRadius) || maxCollisionRadius <= 0) {
    return MIN_GROUP_FORMATION_SPACING;
  }
  return Math.max(
    MIN_GROUP_FORMATION_SPACING,
    maxCollisionRadius * COLLISION_GROUP_FORMATION_SPACING_MULTIPLIER,
  );
}

type FormationLayoutUnit = {
  unit: Entity;
  originalIndex: number;
  radius: number;
  mass: number;
  placementWeight: number;
};

type FormationGridCoord = {
  row: number;
  col: number;
  centerDistanceSq: number;
};

type FormationGridAssignment = FormationGridCoord & {
  layoutUnit: FormationLayoutUnit;
};

function formationUnitRadius(unit: Entity): number {
  const radius = unit.unit?.radius.collision;
  return Number.isFinite(radius) && radius !== undefined && radius > 0
    ? radius
    : MIN_GROUP_FORMATION_SPACING / COLLISION_GROUP_FORMATION_SPACING_MULTIPLIER;
}

export function maxFormationUnitRadius(units: readonly Entity[]): number {
  let radius = 0;
  for (let i = 0; i < units.length; i++) {
    radius = Math.max(radius, formationUnitRadius(units[i]));
  }
  return radius;
}

function formationUnitMass(unit: Entity): number {
  const mass = unit.unit?.mass;
  return Number.isFinite(mass) && mass !== undefined && mass > 0 ? mass : 1;
}

function formationPlacementWeight(radius: number, mass: number): number {
  return radius * 4 + Math.log2(Math.max(1, mass) + 1);
}

function compareFormationUnits(a: FormationLayoutUnit, b: FormationLayoutUnit): number {
  if (b.placementWeight !== a.placementWeight) return b.placementWeight - a.placementWeight;
  if (b.radius !== a.radius) return b.radius - a.radius;
  if (b.mass !== a.mass) return b.mass - a.mass;
  return a.originalIndex - b.originalIndex;
}

function compareGridCoordsByCenter(a: FormationGridCoord, b: FormationGridCoord): number {
  if (a.centerDistanceSq !== b.centerDistanceSq) return a.centerDistanceSq - b.centerDistanceSq;
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

function slotPositionsFromSpans(spans: readonly number[]): number[] {
  let total = 0;
  for (let i = 0; i < spans.length; i++) total += spans[i];
  const positions: number[] = new Array(spans.length);
  let cursor = -total / 2;
  for (let i = 0; i < spans.length; i++) {
    positions[i] = cursor + spans[i] / 2;
    cursor += spans[i];
  }
  return positions;
}

export function buildMassAwareGroupFormationSlots(units: readonly Entity[]): GroupFormationSlot[] {
  const unitCount = units.length;
  if (unitCount === 0) return [];

  const colCount = Math.ceil(DMath.sqrt(unitCount));
  const rowCount = Math.ceil(unitCount / colCount);
  const rowCenter = (rowCount - 1) / 2;
  const colCenter = (colCount - 1) / 2;

  const coords: FormationGridCoord[] = [];
  for (let index = 0; index < unitCount; index++) {
    const row = Math.floor(index / colCount);
    const col = index % colCount;
    const rowDelta = row - rowCenter;
    const colDelta = col - colCenter;
    coords.push({
      row,
      col,
      centerDistanceSq: rowDelta * rowDelta + colDelta * colDelta,
    });
  }
  coords.sort(compareGridCoordsByCenter);

  const layoutUnits = new Array<FormationLayoutUnit>(units.length);
  for (let originalIndex = 0; originalIndex < units.length; originalIndex++) {
    const unit = units[originalIndex];
    const radius = formationUnitRadius(unit);
    const mass = formationUnitMass(unit);
    layoutUnits[originalIndex] = {
      unit,
      originalIndex,
      radius,
      mass,
      placementWeight: formationPlacementWeight(radius, mass),
    };
  }
  layoutUnits.sort(compareFormationUnits);

  const assignments: FormationGridAssignment[] = [];
  const colSpans = new Array<number>(colCount).fill(MIN_GROUP_FORMATION_SPACING);
  const rowSpans = new Array<number>(rowCount).fill(MIN_GROUP_FORMATION_SPACING);
  for (let i = 0; i < layoutUnits.length; i++) {
    const coord = coords[i];
    if (coord === undefined) continue;
    const layoutUnit = layoutUnits[i];
    const spacing = groupFormationSpacing(layoutUnit.radius);
    colSpans[coord.col] = Math.max(colSpans[coord.col], spacing);
    rowSpans[coord.row] = Math.max(rowSpans[coord.row], spacing);
    assignments.push({ ...coord, layoutUnit });
  }

  const colPositions = slotPositionsFromSpans(colSpans);
  const rowPositions = slotPositionsFromSpans(rowSpans);
  const slots = new Array<GroupFormationSlot>(assignments.length);
  for (let i = 0; i < assignments.length; i++) {
    const assignment = assignments[i];
    slots[i] = {
      unit: assignment.layoutUnit.unit,
      offsetX: colPositions[assignment.col],
      offsetY: rowPositions[assignment.row],
    };
  }
  return slots;
}

function unitFormationAcceleration(entity: Entity): number {
  const body = entity.body?.physicsBody;
  if (entity.unit === null || body === undefined) return 0;
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Formation acceleration requires the authoritative simulation WASM');
  }
  return sim.unitEffectiveDriveAcceleration(body.slot);
}

export function computeSlowestFormationSpeedFactors(
  world: WorldState,
  entityIds: readonly EntityId[],
): Map<EntityId, number> | null {
  let slowestAcceleration = Number.POSITIVE_INFINITY;
  for (let i = 0; i < entityIds.length; i++) {
    const entity = world.getEntity(entityIds[i]);
    if (entity === undefined || entity.type !== 'unit' || entity.unit === null) continue;
    const acceleration = unitFormationAcceleration(entity);
    if (
      Number.isFinite(acceleration) &&
      acceleration > 0 &&
      acceleration < slowestAcceleration
    ) {
      slowestAcceleration = acceleration;
    }
  }
  if (!Number.isFinite(slowestAcceleration) || slowestAcceleration <= 0) return null;

  let factors: Map<EntityId, number> | null = null;
  for (let i = 0; i < entityIds.length; i++) {
    const entity = world.getEntity(entityIds[i]);
    if (entity === undefined || entity.type !== 'unit' || entity.unit === null) continue;
    const acceleration = unitFormationAcceleration(entity);
    if (!Number.isFinite(acceleration) || acceleration <= slowestAcceleration) continue;
    const factor = slowestAcceleration / acceleration;
    if (factor >= 0.999) continue;
    if (factors === null) factors = new Map<EntityId, number>();
    factors.set(entity.id, factor);
  }
  return factors;
}
