import * as THREE from 'three';
import { STRUCTURE_BLUEPRINT_IDS } from '../../types/blueprintIds';
import { buildSolarCollector } from '../render3d/SolarCollectorMesh3D';
import {
  BUILDING_BLUEPRINTS,
  FABRICATOR_BLUEPRINT_IDS,
  isDirectionalFabricatorBuildingBlueprintId,
  isRadialFabricatorBuildingBlueprintId,
} from './blueprints/buildings';
import { getUnitBlueprint } from './blueprints';
import { getBuildingConfig } from './buildConfigs';
import {
  BUILD_GRID_CELL_SIZE,
  BuildingGrid,
  getRotatedBuildingPlacementFootprint,
  parseBuildingPlacementFootprint,
} from './buildGrid';
import type { Entity, EntityId, PlayerId } from './types';
import {
  BUILDING_ROTATION_STEP_RAD,
  getBuildingRotationQuarterTurns,
  snapBuildingRotation,
} from './buildingRotation';
import {
  createFactoryProductionHoldSpec,
  getDirectionalFactoryExitPoint,
} from './factoryProductionHold';
import {
  getBuildFootprintClearanceApproachPoint,
  isBuilderClearOfBuildFootprint,
} from './builderRange';
import { ignoreNewBuildingBodyForOverlappingUnits } from '../server/buildingPhysicsBody';
import type { Body3D, PhysicsEngine3D } from '../server/PhysicsEngine3D';
import type { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[building footprint] ${message}`);
}

function assertConnected(id: string): void {
  const cells = getBuildingConfig(id as keyof typeof BUILDING_BLUEPRINTS).placementFootprint.cells;
  const remaining = new Set(cells.map((cell) => `${cell.dx},${cell.dy}`));
  const first = cells[0];
  const stack = [first];
  remaining.delete(`${first.dx},${first.dy}`);
  while (stack.length > 0) {
    const cell = stack.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const key = `${cell.dx + dx},${cell.dy + dy}`;
      if (!remaining.delete(key)) continue;
      stack.push({ dx: cell.dx + dx, dy: cell.dy + dy, kind: 'structure' });
    }
  }
  assertContract(remaining.size === 0, `${id} mask must be one four-connected reservation`);
}

function footprintSignature(
  footprint: ReturnType<typeof getBuildingConfig>['placementFootprint'],
): string {
  return footprint.cells
    .map((cell) => `${cell.dx},${cell.dy},${cell.kind}`)
    .sort()
    .join('|');
}

function factoryFixture(buildingBlueprintId: keyof typeof BUILDING_BLUEPRINTS): Entity {
  const blueprint = BUILDING_BLUEPRINTS[buildingBlueprintId];
  const depth = blueprint.gridDepth * BUILD_GRID_CELL_SIZE;
  return {
    id: 9001 as EntityId,
    buildingBlueprintId,
    unit: null,
    building: {
      depth,
      hoveringType: blueprint.hoveringType,
    },
    transform: {
      x: 2000,
      y: 2000,
      z: depth * 0.5,
      rotation: 0,
      rotCos: 1,
      rotSin: 0,
    },
  } as unknown as Entity;
}

export function runBuildingFootprintContractTest(): void {
  const canonicalRotations = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  for (let quarterTurn = 0; quarterTurn < canonicalRotations.length; quarterTurn++) {
    const noisyRotation = quarterTurn * BUILDING_ROTATION_STEP_RAD + 0.17;
    assertContract(
      getBuildingRotationQuarterTurns(noisyRotation) === quarterTurn &&
      snapBuildingRotation(noisyRotation) === canonicalRotations[quarterTurn],
      `building facing ${quarterTurn} must resolve to one exact canonical quarter turn`,
    );
  }
  assertContract(
    snapBuildingRotation(-Math.PI / 2) === -Math.PI / 2 &&
    snapBuildingRotation(Math.PI * 8) === 0,
    'negative and wrapped build facings must remain one of the four canonical states',
  );

  for (const id of STRUCTURE_BLUEPRINT_IDS) {
    const blueprint = BUILDING_BLUEPRINTS[id];
    const config = getBuildingConfig(id);
    assertContract(
      config.placementGridWidth === blueprint.footprintMask[0].length &&
      config.placementGridHeight === blueprint.footprintMask.length,
      `${id} runtime placement bounds must derive from footprintMask`,
    );
    assertConnected(id);
    let rotated = config.placementFootprint;
    for (let turn = 0; turn < 4; turn++) {
      rotated = getRotatedBuildingPlacementFootprint(rotated, Math.PI / 2);
    }
    assertContract(
      rotated.gridWidth === config.placementGridWidth &&
      rotated.gridHeight === config.placementGridHeight &&
      rotated.cells.every((cell, index) => {
        const source = config.placementFootprint.cells[index];
        return source !== undefined &&
          cell.dx === source.dx && cell.dy === source.dy && cell.kind === source.kind;
      }),
      `${id} mask must return exactly to its authored pose after four turns`,
    );
  }

  const solarRows = BUILDING_BLUEPRINTS.buildingSolar.footprintMask;
  assertContract(
    solarRows.join('/') ===
      '++++...++++/+++++++++++/+++++++++++/+++#####+++/.++#####++./.++#####++./.++#####++./+++#####+++/+++++++++++/+++++++++++/++++...++++',
    'solar must reserve the authored 11x11 square with a three-cell notch centered on every side (the X-folded panels leave those areas empty)',
  );
  const solar = getBuildingConfig('buildingSolar').placementFootprint;
  assertContract(
    solar.gridWidth === 11 && solar.gridHeight === 11 &&
      solar.cells.length === 109 &&
      solar.cells.filter((cell) => cell.kind === 'structure').length === 25 &&
      solar.cells.filter((cell) => cell.kind === 'clearance').length === 84,
    'solar square must keep its 25-cell structural core inside an 84-cell construction-clearance ring',
  );

  const radialFabricatorSizes = [
    ['towerFabricator', 10, 12],
    ['buildingAdvancedUniversalFabricator', 16, 18],
    ['buildingExperimentalUniversalFabricator', 24, 26],
  ] as const;
  for (const [fabricatorId, bodyGridSize, reservationGridSize] of radialFabricatorSizes) {
    const blueprint = BUILDING_BLUEPRINTS[fabricatorId];
    const footprint = getBuildingConfig(fabricatorId).placementFootprint;
    assertContract(
      blueprint.gridWidth === bodyGridSize && blueprint.gridHeight === bodyGridSize &&
        footprint.gridWidth === reservationGridSize && footprint.gridHeight === reservationGridSize,
      `${fabricatorId} must retain its authored T1/T2/T3 size progression`,
    );
  }

  for (const id of FABRICATOR_BLUEPRINT_IDS) {
    const blueprint = BUILDING_BLUEPRINTS[id];
    const config = getBuildingConfig(id);
    const quarterTurn = getRotatedBuildingPlacementFootprint(
      config.placementFootprint,
      Math.PI / 2,
    );
    if (isRadialFabricatorBuildingBlueprintId(id)) {
      assertContract(
        config.placementGridWidth === config.placementGridHeight &&
        footprintSignature(quarterTurn) === footprintSignature(config.placementFootprint),
        `${id} must remain a square, quarter-turn-invariant Universal footprint`,
      );
      assertContract(
        blueprint.hoveringType === 'fabricator',
        `${id} must retain the radial center-drop fabricator body`,
      );
      continue;
    }

    assertContract(
      isDirectionalFabricatorBuildingBlueprintId(id) &&
      config.placementGridWidth !== config.placementGridHeight &&
      quarterTurn.gridWidth === config.placementGridHeight &&
      quarterTurn.gridHeight === config.placementGridWidth,
      `${id} must own a rectangular footprint whose facing changes by quarter turn`,
    );
    const mask = blueprint.footprintMask;
    const yardRows = mask.filter((row) => row.includes('+'));
    assertContract(
      mask[0].split('').every((cell) => cell === '#') &&
      mask[mask.length - 1].split('').every((cell) => cell === '#') &&
      yardRows.length >= Math.floor(mask.length * 0.5) &&
      yardRows.every((row) => row[0] === '#' && row[row.length - 1] === '+'),
      `${id} must be a U-shaped specialist yard with its reserved open mouth at local +X`,
    );
    const expectedEmitterCount = blueprint.factory?.techLevel === 2 ? 4 : 2;
    assertContract(
      blueprint.workEmitter?.points.length === expectedEmitterCount,
      `${id} must author ${expectedEmitterCount} directional nano-arm sockets`,
    );
  }

  const universalHold = createFactoryProductionHoldSpec(
    factoryFixture('towerFabricator'),
    'unitJackal',
  );
  assertContract(
    universalHold.localOffsetX === 0 && !universalHold.rotateWithHolder,
    'Universal production must remain an orientation-independent center drop',
  );
  const directionalFactory = factoryFixture('buildingVehicleFabricator');
  const directionalHold = createFactoryProductionHoldSpec(directionalFactory, 'unitJackal');
  assertContract(
    directionalHold.localOffsetX > 0 &&
    directionalHold.rotateWithHolder &&
    directionalHold.inheritHolderRotation,
    'specialist production must be held forward in the authored, rotating bay',
  );
  const producedBlueprint = getUnitBlueprint('unitJackal');
  const produced = {
    unit: { radius: producedBlueprint.radius },
    transform: { x: 2000, y: 2000, z: producedBlueprint.supportPointOffsetZ },
  } as unknown as Entity;
  for (const rotation of canonicalRotations) {
    directionalFactory.transform.rotation = rotation;
    directionalFactory.transform.rotCos = Math.cos(rotation);
    directionalFactory.transform.rotSin = Math.sin(rotation);
    const exit = getDirectionalFactoryExitPoint(
      directionalFactory,
      produced,
      4000,
      4000,
    );
    assertContract(exit !== null, 'specialist must produce an exit point');
    const deltaX = exit.x - directionalFactory.transform.x;
    const deltaY = exit.y - directionalFactory.transform.y;
    const forward = deltaX * Math.cos(rotation) + deltaY * Math.sin(rotation);
    const lateral = -deltaX * Math.sin(rotation) + deltaY * Math.cos(rotation);
    assertContract(
      forward > producedBlueprint.radius.collision && Math.abs(lateral) <= 1e-8,
      `specialist exit must rotate exactly with facing ${rotation}`,
    );
  }

  const targetingLab = getBuildingConfig('buildingShieldTargetingTech').placementFootprint;
  const shieldLab = getBuildingConfig('buildingShieldTech').placementFootprint;
  assertContract(
    targetingLab.gridWidth === 12 && targetingLab.gridHeight === 12 &&
    shieldLab.gridWidth === 12 && shieldLab.gridHeight === 12 &&
    targetingLab.cells.length >= 100 && shieldLab.cells.length >= 100,
    'both research labs must occupy near-Fabricator-scale authored masks',
  );

  const grid = new BuildingGrid(800, 800);
  grid.placeFootprint(
    10,
    10,
    solar,
    7001 as EntityId,
    1 as PlayerId,
    true,
    20,
  );
  assertContract(grid.getCell(14, 10) === undefined, 'side-notch cells must remain buildable');
  assertContract(
    grid.getCell(11, 10)?.blocksMovement === false,
    'outer solar clearance must reserve construction without blocking locomotion',
  );
  assertContract(
    grid.getCell(15, 15)?.blocksMovement === true,
    'solar structural core must block grounded locomotion',
  );
  assertContract(
    grid.canPlaceFootprint(14, 10, parseBuildingPlacementFootprint(['#'], 'contract probe')),
    'a shaped mask must allow another footprint in an unused notch cell',
  );

  const buildTarget = {
    buildingBlueprintId: 'buildingSolar',
    building: { width: 100, height: 100 },
    transform: { x: 400, y: 400, z: 0, rotation: 0, rotCos: 1, rotSin: 0 },
  } as unknown as Entity;
  const trappedBuilder = {
    builder: { buildRange: 250 },
    unit: { radius: { collision: 24 }, headingDirX: 1, headingDirY: 0 },
    transform: { x: 400, y: 400, z: 0, rotation: 0, rotCos: 1, rotSin: 0 },
  } as unknown as Entity;
  assertContract(
    !isBuilderClearOfBuildFootprint(trappedBuilder, buildTarget),
    'a builder at the exact build center must not apply construction work',
  );
  const escape = getBuildFootprintClearanceApproachPoint(trappedBuilder, buildTarget);
  assertContract(escape !== null && escape.x > buildTarget.transform.x && escape.y === 400,
    'an exact-center builder must receive a deterministic forward escape point');
  trappedBuilder.transform.x = escape!.x;
  trappedBuilder.transform.y = escape!.y;
  assertContract(
    isBuilderClearOfBuildFootprint(trappedBuilder, buildTarget),
    'the escape point must put the complete builder collision disc beyond the reservation',
  );

  const staticBody = {
    shape: 'cuboid', x: 400, y: 400, z: 50,
    halfX: 50, halfY: 50, halfZ: 50, supportTopZ: 100,
  } as Body3D;
  const trappedBody = {
    shape: 'sphere', x: 400, y: 400, z: 20, radius: 24, groundOffset: 10,
  } as Body3D;
  const aboveBody = {
    shape: 'sphere', x: 400, y: 400, z: 110, radius: 24, groundOffset: 10,
  } as Body3D;
  const outsideBody = {
    shape: 'sphere', x: 700, y: 400, z: 20, radius: 24, groundOffset: 10,
  } as Body3D;
  const ignored: Array<[Body3D, Body3D]> = [];
  const ignoredCount = ignoreNewBuildingBodyForOverlappingUnits(
    { getUnits: () => [
      { body: { physicsBody: trappedBody } },
      { body: { physicsBody: aboveBody } },
      { body: { physicsBody: outsideBody } },
    ] } as unknown as WorldState,
    { setIgnoreStatic: (dynamic, stat) => { ignored.push([dynamic, stat]); } } as Pick<
      PhysicsEngine3D,
      'setIgnoreStatic'
    >,
    { body: { physicsBody: staticBody } } as Entity,
  );
  assertContract(
    ignoredCount === 1 && ignored[0]?.[0] === trappedBody && ignored[0]?.[1] === staticBody,
    'a new static shell must ignore only units it initially encloses, not units above or outside it',
  );

  const primaryMat = new THREE.MeshLambertMaterial();
  const solarShape = buildSolarCollector(100, 100, primaryMat);
  assertContract(
    Math.abs((solarShape.authoredYaw ?? 0) - Math.PI / 4) <= 1e-9,
    'solar collector assembly, including every panel, must be natively yawed 45 degrees',
  );
  primaryMat.dispose();
}
