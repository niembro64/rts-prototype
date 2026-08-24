// Host volume overlay contract: the VOLUMES debug toggles must draw each
// entity's ACTUAL shapes — unit spheres, building selection/combat boxes,
// the target-acquisition cylinder every entity carries, and the hovering
// fabricator's floating annular ring — never a stand-in sphere.
//
// It also pins the selection volume itself, because the overlay and the
// mouse picker read the same `entityVolumes` writers: a building must be
// pickable over its drawn body and NOT over the empty air above it or the
// ground beside it, which is exactly what the old footprint-half-diagonal
// pick sphere got wrong.
import * as THREE from 'three';
import {
  getVolumeToggle,
  setVolumeToggle,
  VOLUME_TYPES,
} from '@/clientBarConfig';
import type { VolumeType } from '@/types/client';
import { WorldState } from '../sim/WorldState';
import { fabricatorTorusHoverHeight, getUnitBlueprint } from '../sim/blueprints';
import { getBuildingConfig } from '../sim/buildConfigs';
import type { Entity } from '../sim/types';
import {
  createEntityVolume,
  rayVolumeT,
  writeSelectionVolume,
} from '../sim/entityVolumes';
import { getBuildingCombatCenterZ, getBuildingVisualTopZ } from '../sim/buildingAnchors';
import { getUnitGroundZ } from '../sim/unitGeometry';
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
function makeBuildingHost(
  world: WorldState,
  blueprintId: 'towerFabricator' | 'buildingAircraftFabricator' | 'buildingSolar',
): Entity {
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

/** Does a downward-ish ray aimed at (targetX, targetY, targetZ) from
 *  `height` above hit the entity's selection volume? */
function selectionVolumeHitFrom(
  entity: Entity,
  originX: number, originY: number, originZ: number,
  targetX: number, targetY: number, targetZ: number,
): boolean {
  const volume = createEntityVolume();
  if (!writeSelectionVolume(entity, volume)) return false;
  const dx = targetX - originX;
  const dy = targetY - originY;
  const dz = targetZ - originZ;
  const length = Math.hypot(dx, dy, dz);
  if (length <= 0) return false;
  return rayVolumeT(
    volume, originX, originY, originZ, dx / length, dy / length, dz / length,
  ) >= 0;
}

export function runHostVolumeOverlay3DContractTest(): void {
  const previous = new Map<VolumeType, boolean>();
  for (const type of VOLUME_TYPES) previous.set(type, getVolumeToggle(type));

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
    for (const type of VOLUME_TYPES) setVolumeToggle(type, true);
    renderer.beginFrame();

    const world = new WorldState(7831, 512, 512);

    // ── Unit: spheres plus the acquisition cylinder ────────────────
    const unitHost = world.createUnitFromBlueprint(120, 140, 1, 'unitFormik');
    assertContract(unitHost.unit !== null, 'unit host must carry a unit component');
    unitHost.unit.radius = readNetworkUnitRadius(null, getUnitBlueprint('unitFormik').radius);
    const unitMesh = makeOverlayMesh();
    renderer.updateHostVolumes(unitMesh, unitHost);
    const unitRings = unitMesh.radiusRings;
    assertContract(unitRings !== undefined, 'unit volumes must exist');
    assertContract(
      unitRings.hit !== undefined && unitRings.hit.geometry === radiusSphereGeom,
      'unit HIT volume is a sphere',
    );
    assertContract(
      unitRings.selection !== undefined
        && unitRings.selection.geometry === radiusSphereGeom,
      'unit SEL volume stays a body sphere',
    );
    // HIT is ONE shape. The cylinder combat targeting hands to its range
    // shells is this same volume re-expressed for that test, not a second
    // volume, so nothing rides along with it.
    assertContract(
      (unitRings as Record<string, unknown>).hitAcquisition === undefined,
      'HIT must not draw a companion acquisition wireframe',
    );

    // ── Grounded building: combat box, physics cuboid, cylinder ────
    const solar = makeBuildingHost(world, 'buildingSolar');
    const solarBuilding = solar.building;
    assertContract(solarBuilding !== null, 'solar must carry a building component');
    const solarMesh = makeOverlayMesh();
    renderer.updateHostVolumes(solarMesh, solar);
    const solarRings = solarMesh.radiusRings;
    assertContract(solarRings !== undefined, 'building volumes must exist');
    const solarHit = solarRings.hit;
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

    // ── Grounded building SEL: an upright box over the drawn body ───
    const solarSel = solarRings.selection;
    assertContract(
      solarSel !== undefined && solarSel.visible && solarSel.geometry === solarHit.geometry,
      'grounded building SEL volume must be a box, not a sphere',
    );
    const solarBaseZ = solar.transform.z - solarBuilding.depth / 2;
    const solarVisualHeight = getBuildingVisualTopZ(solar) - solarBaseZ;
    assertNear(
      solarSel.position.y,
      solarVisualHeight / 2,
      'SEL box centers on the drawn body, not on the footprint diagonal',
    );
    assertContract(
      solarSel.scale.y >= solarVisualHeight && solarSel.scale.y <= solarVisualHeight * 1.15,
      'SEL box height tracks the drawn body height (plus its authored pick padding), '
        + `got ${solarSel.scale.y} for a ${solarVisualHeight}-tall body`,
    );
    assertContract(
      solarSel.scale.y < Math.hypot(solarBuilding.width, solarBuilding.height),
      'SEL box must be shorter than the footprint DIAGONAL — the pinned bug was a '
        + 'selection sphere sized off that diagonal, which picked the collector from '
        + 'well above its roof no matter how tall the drawn body actually is',
    );

    // The reported bug, pinned as behavior: looking across at a flat
    // structure, the cursor must not pick it from well above its roof,
    // nor from beside its footprint.
    const solarTopZ = getBuildingVisualTopZ(solar);
    assertContract(
      selectionVolumeHitFrom(
        solar,
        solar.transform.x, solar.transform.y - 400, solarTopZ,
        solar.transform.x, solar.transform.y, solarBaseZ + solarVisualHeight * 0.5,
      ),
      'a level ray at body height must still pick the building',
    );
    assertContract(
      !selectionVolumeHitFrom(
        solar,
        solar.transform.x, solar.transform.y - 400, solarTopZ + solarVisualHeight * 3,
        solar.transform.x, solar.transform.y, solarTopZ + solarVisualHeight * 3,
      ),
      'a level ray far above the roof must NOT pick the building',
    );
    assertContract(
      !selectionVolumeHitFrom(
        solar,
        solar.transform.x + solarBuilding.width, solar.transform.y - 400, solarTopZ,
        solar.transform.x + solarBuilding.width, solar.transform.y, solarTopZ,
      ),
      'a ray a full footprint width to the side must NOT pick the building',
    );

    // ── Hovering fabricator: floating box, cylinder, and annulus ───
    const fabricator = makeBuildingHost(world, 'towerFabricator');
    const fabricatorBuilding = fabricator.building;
    assertContract(fabricatorBuilding !== null, 'fabricator must carry a building component');
    const fabricatorMesh = makeOverlayMesh();
    renderer.updateHostVolumes(fabricatorMesh, fabricator);
    const fabricatorRings = fabricatorMesh.radiusRings;
    assertContract(fabricatorRings !== undefined, 'fabricator volumes must exist');
    const hoverY = fabricatorTorusHoverHeight('towerFabricator');
    const fabricatorHit = fabricatorRings.hit;
    assertContract(
      fabricatorHit !== undefined && fabricatorHit.visible
        && fabricatorHit.geometry !== radiusSphereGeom,
      'fabricator HIT volume must be the combat box, not a sphere',
    );
    assertNear(fabricatorHit.position.y, hoverY, 'fabricator combat box floats at hover height');
    const fabricatorCol = fabricatorRings.collision;
    assertContract(
      fabricatorCol !== undefined && fabricatorCol.visible,
      'fabricator COL volume must exist',
    );
    assertContract(
      fabricatorCol.geometry !== radiusSphereGeom
        && fabricatorCol.geometry !== fabricatorHit.geometry,
      'fabricator COL volume must be the annular ring, not a sphere or box',
    );
    assertNear(
      fabricatorCol.position.y,
      hoverY,
      'fabricator collision ring floats at hover height',
    );
    // SEL rides the same ring, so the wide-open middle of the torus stays
    // clickable through to whatever sits under it.
    const fabricatorSel = fabricatorRings.selection;
    assertContract(
      fabricatorSel !== undefined && fabricatorSel.visible
        && fabricatorSel.geometry === fabricatorCol.geometry,
      'fabricator SEL volume must be the torus ring, not a sphere or box',
    );
    assertContract(
      !selectionVolumeHitFrom(
        fabricator,
        fabricator.transform.x, fabricator.transform.y, fabricator.transform.z + 2000,
        fabricator.transform.x, fabricator.transform.y, fabricator.transform.z,
      ),
      'a ray straight down the middle of the fabricator ring must NOT pick it',
    );

    // ── Directional hovering factory: every box shares one center ───
    const aircraftFactory = makeBuildingHost(world, 'buildingAircraftFabricator');
    const aircraftMesh = makeOverlayMesh();
    renderer.updateHostVolumes(aircraftMesh, aircraftFactory);
    const aircraftRings = aircraftMesh.radiusRings;
    assertContract(aircraftRings !== undefined, 'aircraft factory volumes must exist');
    const expectedAircraftCenterY =
      getBuildingCombatCenterZ(aircraftFactory) - getUnitGroundZ(aircraftFactory);
    for (const [name, volume] of [
      ['selection', aircraftRings.selection],
      ['hit', aircraftRings.hit],
      ['collision', aircraftRings.collision],
    ] as const) {
      assertContract(volume !== undefined && volume.visible, `aircraft factory ${name} must exist`);
      assertNear(
        volume.position.y,
        expectedAircraftCenterY,
        `aircraft factory ${name} shares the authoritative hovering center`,
      );
    }
  } finally {
    for (const type of VOLUME_TYPES) setVolumeToggle(type, previous.get(type) ?? false);
    renderer.dispose();
    radiusSphereGeom.dispose();
    sphereSourceGeom.dispose();
  }
}
