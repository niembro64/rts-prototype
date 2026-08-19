import * as THREE from 'three';
import {
  getGraphicsConfig,
  getWaterBoundaryMode,
  setWaterBoundaryMode,
} from '@/clientBarConfig';
import { getFloatingWaterOverhang, getWaterBoxFloorY } from './WorldBoxGeometry3D';
import {
  resolveMapInfoAnnexFootprint,
  resolveMapInfoAnnexLiquidRect,
} from './MapInfoAnnex3D';
import { WATER_LEVEL } from '../sim/Terrain';
import { WATER_BOX_FACES, WaterRenderer3D } from './WaterRenderer3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[water renderer contract] ${message}`);
}

export function runWaterRenderer3DContractTest(): void {
  const previousMode = getWaterBoundaryMode();
  const mapWidth = 4000;
  const mapHeight = 3000;
  const parent = new THREE.Group();
  const renderer = new WaterRenderer3D(parent, mapWidth, mapHeight);
  try {
    setWaterBoundaryMode('floating-square');
    renderer.update(0, getGraphicsConfig());

    const surface = renderer.getMesh();
    const curtains = parent.children.filter(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh && child.name.startsWith('WaterCurtain:'),
    );
    assertContract(surface.name === 'WaterSurface', 'picking must retain one horizontal surface');
    assertContract(
      curtains.length === WATER_BOX_FACES.length && WATER_BOX_FACES.length === 5,
      'floating square must own one mesh per world-box face: four curtains and the bottom',
    );
    assertContract(
      new Set(curtains.map((curtain) => curtain.geometry)).size === WATER_BOX_FACES.length,
      'each face needs independent geometry so transparent object sorting can order it',
    );
    const curtainMaterial = curtains[0].material as THREE.MeshBasicMaterial;
    assertContract(
      curtains.every((curtain) => curtain.material === curtainMaterial),
      'all curtain objects must share one stable curtain material',
    );
    assertContract(
      curtainMaterial !== surface.material &&
        !curtainMaterial.polygonOffset &&
        !curtainMaterial.depthWrite &&
        curtainMaterial.forceSinglePass,
      'curtains must avoid depth writes, shoreline offset, and transparent double-pass rendering',
    );
    assertContract(
      (surface.material as THREE.MeshBasicMaterial).forceSinglePass,
      'the consistently wound horizontal surface must also use one transparent pass',
    );
    assertContract(
      curtains.every((curtain) =>
        (curtain.geometry.getAttribute('position')?.count ?? 0) > 0),
      'every floating-square box face must contain rendered triangles',
    );
    // EVERY triangle of the closed box — surface, curtains, and bottom alike.
    // The perimeter is no longer four authored strips: the info annex opens
    // one side and closes it again further out, so the walk direction of each
    // piece is computed rather than written down, and a single inside-out
    // face would be a hole in the liquid seen from one angle only.
    for (const face of [...curtains, surface]) {
      const positions = face.geometry.getAttribute('position');
      const index = face.geometry.index;
      assertContract(positions !== undefined && index !== null, `${face.name} needs indexed geometry`);
      const normals = face.geometry.getAttribute('normal');
      for (let triangle = 0; triangle < index.count / 3; triangle++) {
        const a = new THREE.Vector3().fromBufferAttribute(positions, index.getX(triangle * 3));
        const b = new THREE.Vector3().fromBufferAttribute(positions, index.getX(triangle * 3 + 1));
        const c = new THREE.Vector3().fromBufferAttribute(positions, index.getX(triangle * 3 + 2));
        const geometricNormal = b.sub(a).cross(c.sub(a)).normalize();
        const vertexNormal = new THREE.Vector3().fromBufferAttribute(
          normals,
          index.getX(triangle * 3),
        );
        assertContract(
          geometricNormal.dot(vertexNormal) > 0.999,
          `${face.name} winding must agree with its outward normal on every triangle`,
        );
      }
    }

    const overhang = getFloatingWaterOverhang();
    const annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
    const arm = resolveMapInfoAnnexLiquidRect(annex, overhang, mapWidth, mapHeight);
    const bounds = new Map(curtains.map((curtain) => {
      curtain.geometry.computeBoundingBox();
      return [curtain.name.slice('WaterCurtain:'.length), curtain.geometry.boundingBox];
    }));
    // Each face mesh still owns exactly the plane(s) of its own direction —
    // the annex's arm adds panels to the sides it actually touches and to no
    // others, so transparent sorting still orders the box by direction.
    assertContract(
      Math.abs((bounds.get('north')?.max.z ?? Infinity) + overhang) < 1e-6
        && Math.abs((bounds.get('north')?.min.z ?? Infinity) - arm.minZ) < 1e-6,
      'the north face must run from the map boundary out to the annex arm and no further',
    );
    assertContract(
      Math.abs((bounds.get('east')?.min.x ?? Infinity) - arm.maxX) < 1e-6
        && Math.abs((bounds.get('east')?.max.x ?? Infinity) - (mapWidth + overhang)) < 1e-6,
      'the east face must own the map boundary and the arm flank on its side',
    );
    assertContract(
      Math.abs((bounds.get('south')?.min.z ?? Infinity) - (mapHeight + overhang)) < 1e-6
        && Math.abs((bounds.get('south')?.max.z ?? Infinity) - (mapHeight + overhang)) < 1e-6,
      'the south face is untouched by the annex and must stay on its own boundary',
    );
    assertContract(
      Math.abs((bounds.get('west')?.min.x ?? Infinity) + overhang) < 1e-6
        && Math.abs((bounds.get('west')?.max.x ?? Infinity) - arm.minX) < 1e-6,
      'the west face must own the map boundary and the arm flank on its side',
    );
    // The opened span of the attached side is what the arm closes further
    // out: no curtain may cross the water the annex sits under.
    const northPositions = curtains
      .find((curtain) => curtain.name.endsWith(':north'))
      ?.geometry.getAttribute('position');
    assertContract(northPositions !== undefined, 'the north face needs positions');
    for (let vertex = 0; vertex < northPositions.count; vertex++) {
      const x = northPositions.getX(vertex);
      const z = northPositions.getZ(vertex);
      assertContract(
        Math.abs(z + overhang) > 1e-6
          || x <= arm.minX + 1e-6
          || x >= arm.maxX - 1e-6,
        'the map boundary must be OPEN across the annex arm, not walled off inside the liquid',
      );
    }
    // The bottom face closes the box: one horizontal panel at the water
    // floor, spanning the same overhanging footprint as the surface, facing
    // down so it is the face a camera under the world sees.
    const bottom = curtains.find((curtain) => curtain.name.endsWith(':bottom'));
    assertContract(bottom !== undefined, 'the water box must own a bottom face');
    bottom.geometry.computeBoundingBox();
    const bottomBounds = bottom.geometry.boundingBox;
    const floorY = getWaterBoxFloorY(mapWidth, mapHeight);
    assertContract(
      bottomBounds !== null
        && Math.abs(bottomBounds.min.y - floorY) < 1e-6
        && Math.abs(bottomBounds.max.y - floorY) < 1e-6,
      'the bottom face must lie flat at the water box floor',
    );
    assertContract(
      Math.abs(bottomBounds.min.x - Math.min(-overhang, arm.minX)) < 1e-6
        && Math.abs(bottomBounds.max.x - Math.max(mapWidth + overhang, arm.maxX)) < 1e-6
        && Math.abs(bottomBounds.min.z - Math.min(-overhang, arm.minZ)) < 1e-6
        && Math.abs(bottomBounds.max.z - Math.max(mapHeight + overhang, arm.maxZ)) < 1e-6,
      'the bottom face must span the whole overhanging water footprint, annex arm included',
    );
    // The surface is the same footprint at the liquid level: the annex is
    // covered by the same medium at the same height as the rest of the map.
    surface.geometry.computeBoundingBox();
    const surfaceBounds = surface.geometry.boundingBox;
    assertContract(
      surfaceBounds !== null
        && Math.abs(surfaceBounds.min.y - WATER_LEVEL) < 1e-6
        && Math.abs(surfaceBounds.max.y - WATER_LEVEL) < 1e-6
        && Math.abs(surfaceBounds.min.z - Math.min(-overhang, arm.minZ)) < 1e-6,
      'the liquid surface must reach over the annex at exactly the map\'s own level',
    );
    const bottomNormal = new THREE.Vector3().fromBufferAttribute(
      bottom.geometry.getAttribute('normal'),
      0,
    );
    assertContract(bottomNormal.y < -0.999, 'the bottom face must point down and out of the box');
  } finally {
    renderer.destroy();
    setWaterBoundaryMode(previousMode);
  }
}
