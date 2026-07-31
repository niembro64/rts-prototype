// Host volume overlay contract: the VOLUMES debug toggles must draw each
// entity's ACTUAL shapes — unit spheres, building combat boxes, the
// target-acquisition cylinder every entity carries, and the hovering
// fabricator's floating annular collision ring — never a stand-in sphere.
import * as THREE from 'three';
import {
  getUnitRadiusToggle,
  setUnitRadiusToggle,
  UNIT_RADIUS_TYPES,
} from '@/clientBarConfig';
import type { UnitRadiusType } from '@/types/client';
import { WorldState } from '../sim/WorldState';
import { fabricatorTorusHoverHeight, getUnitBlueprint } from '../sim/blueprints';
import { getBuildingConfig } from '../sim/buildConfigs';
import type { Entity } from '../sim/types';
import { readNetworkUnitRadius } from '../network/unitSnapshotFields';
import type { ClientViewState } from '../network/ClientViewState';
import type { EntityMesh } from './EntityMesh3D';
import type { OverlayLineSystem } from './OverlayLineSystem';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
import { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[host volume overlay contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `[host volume overlay contract] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

function makeOverlayMesh(): EntityMesh {
  return {
    group: new THREE.Group(),
    turrets: [],
  } as unknown as EntityMesh;
}

/** Configure a WorldState building the way the network entity factory does:
 *  blueprint-config dims, hovering classification, and target radius. */
function makeBuildingHost(world: WorldState, blueprintId: 'towerFabricator' | 'buildingSolar'): Entity {
  const config = getBuildingConfig(blueprintId);
  const entity = world.createBuilding(
    200,
    200,
    config.gridWidth * 20,
    config.gridHeight * 20,
    config.gridDepth * 20,
    1,
  );
  entity.buildingBlueprintId = blueprintId;
  const building = entity.building;
  assertContract(building !== null, 'building host must carry a building component');
  building.hoveringType = config.hoveringType;
  building.hovering = config.hovering;
  building.targetRadius = config.radius.hitbox;
  return entity;
}

export function runHostVolumeOverlay3DContractTest(): void {
  const previous = new Map<UnitRadiusType, boolean>();
  for (const type of UNIT_RADIUS_TYPES) previous.set(type, getUnitRadiusToggle(type));

  const sphereSourceGeom = createPrimitiveSphereGeometry('debug', 'close');
  const radiusSphereGeom = new THREE.WireframeGeometry(sphereSourceGeom);
  const renderer = new SelectionOverlayRenderer3D({
    world: new THREE.Group(),
    clientViewState: {
      getMapWidth: () => 512,
      getMapHeight: () => 512,
      getSelectedIds: () => new Set<number>(),
    } as unknown as ClientViewState,
    radiusSphereGeom,
    overlayLines: undefined as unknown as OverlayLineSystem,
  });

  try {
    for (const type of UNIT_RADIUS_TYPES) setUnitRadiusToggle(type, true);
    renderer.beginFrame();

    const world = new WorldState(7831, 512, 512);

    // ── Unit: spheres plus the acquisition cylinder ────────────────
    const unitHost = world.createUnitFromBlueprint(120, 140, 1, 'unitFormik');
    assertContract(unitHost.unit !== null, 'unit host must carry a unit component');
    unitHost.unit.radius = readNetworkUnitRadius(null, getUnitBlueprint('unitFormik').radius);
    const unitMesh = makeOverlayMesh();
    renderer.updateUnitRadiusRings(unitMesh, unitHost);
    const unitRings = unitMesh.radiusRings;
    assertContract(unitRings !== undefined, 'unit volumes must exist');
    assertContract(
      unitRings.hitbox !== undefined && unitRings.hitbox.geometry === radiusSphereGeom,
      'unit HIT volume is a sphere',
    );
    const unitCyl = unitRings.hitboxAcquisition;
    assertContract(
      unitCyl !== undefined && unitCyl.visible && unitCyl.geometry !== radiusSphereGeom,
      'unit acquisition volume must be a cylinder, not a sphere',
    );
    assertNear(
      unitCyl.scale.x,
      unitHost.unit.radius.hitbox,
      'unit acquisition cylinder radius equals the hitbox radius',
    );
    assertNear(
      unitCyl.scale.y,
      Math.max(unitHost.unit.radius.hitbox, unitHost.unit.supportPointOffsetZ),
      'unit acquisition cylinder half-height equals max(hitbox, support offset)',
    );

    // ── Grounded building: combat box, physics cuboid, cylinder ────
    const solar = makeBuildingHost(world, 'buildingSolar');
    const solarBuilding = solar.building;
    assertContract(solarBuilding !== null, 'solar must carry a building component');
    const solarMesh = makeOverlayMesh();
    renderer.updateBuildingRadiusRings(solarMesh, solar);
    const solarRings = solarMesh.radiusRings;
    assertContract(solarRings !== undefined, 'building volumes must exist');
    const solarHit = solarRings.hitbox;
    assertContract(
      solarHit !== undefined && solarHit.visible && solarHit.geometry !== radiusSphereGeom,
      'grounded building HIT volume must be the combat box, not a sphere',
    );
    assertNear(solarHit.scale.x, solarBuilding.width, 'combat box width');
    assertNear(solarHit.scale.y, solarBuilding.depth, 'combat box vertical depth');
    assertNear(solarHit.scale.z, solarBuilding.height, 'combat box height');
    assertNear(
      solarHit.position.y,
      solarBuilding.depth / 2,
      'grounded combat box centers at half depth above the base',
    );
    const solarCol = solarRings.collision;
    assertContract(
      solarCol !== undefined && solarCol.visible && solarCol.geometry === solarHit.geometry,
      'grounded building COL volume is the same ground-seated cuboid shape',
    );
    assertContract(
      solarRings.hitboxAcquisition !== undefined && solarRings.hitboxAcquisition.visible,
      'grounded building must draw its acquisition cylinder',
    );

    // ── Hovering fabricator: floating box, cylinder, and annulus ───
    const fabricator = makeBuildingHost(world, 'towerFabricator');
    const fabricatorBuilding = fabricator.building;
    assertContract(fabricatorBuilding !== null, 'fabricator must carry a building component');
    const fabricatorMesh = makeOverlayMesh();
    renderer.updateBuildingRadiusRings(fabricatorMesh, fabricator);
    const fabricatorRings = fabricatorMesh.radiusRings;
    assertContract(fabricatorRings !== undefined, 'fabricator volumes must exist');
    const hoverY = fabricatorTorusHoverHeight();
    const fabricatorHit = fabricatorRings.hitbox;
    assertContract(
      fabricatorHit !== undefined && fabricatorHit.visible
        && fabricatorHit.geometry !== radiusSphereGeom,
      'fabricator HIT volume must be the combat box, not a sphere',
    );
    assertNear(fabricatorHit.position.y, hoverY, 'fabricator combat box floats at hover height');
    const fabricatorCyl = fabricatorRings.hitboxAcquisition;
    assertContract(
      fabricatorCyl !== undefined && fabricatorCyl.visible
        && fabricatorCyl.geometry !== radiusSphereGeom,
      'fabricator acquisition volume must be a cylinder, not a sphere',
    );
    assertNear(
      fabricatorCyl.scale.x,
      fabricatorBuilding.targetRadius,
      'fabricator acquisition cylinder radius equals targetRadius',
    );
    const fabricatorCol = fabricatorRings.collision;
    assertContract(
      fabricatorCol !== undefined && fabricatorCol.visible,
      'fabricator COL volume must exist',
    );
    assertContract(
      fabricatorCol.geometry !== radiusSphereGeom
        && fabricatorCol.geometry !== fabricatorHit.geometry
        && fabricatorCol.geometry !== fabricatorCyl.geometry,
      'fabricator COL volume must be the annular ring, not a sphere, box, or cylinder',
    );
    assertNear(
      fabricatorCol.position.y,
      hoverY,
      'fabricator collision ring floats at hover height',
    );
  } finally {
    for (const type of UNIT_RADIUS_TYPES) setUnitRadiusToggle(type, previous.get(type) ?? false);
    renderer.dispose();
    radiusSphereGeom.dispose();
    sphereSourceGeom.dispose();
  }
}
