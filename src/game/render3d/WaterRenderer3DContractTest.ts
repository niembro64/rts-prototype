import * as THREE from 'three';
import {
  getGraphicsConfig,
  getWaterBoundaryMode,
  setWaterBoundaryMode,
} from '@/clientBarConfig';
import { getFloatingWaterOverhang, getWaterBoxFloorY } from './WorldBoxGeometry3D';
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
    // Every face of the closed box — surface, curtains, and bottom alike.
    for (const face of [...curtains, surface]) {
      const positions = face.geometry.getAttribute('position');
      const index = face.geometry.index;
      assertContract(positions !== undefined && index !== null, `${face.name} needs indexed geometry`);
      const a = new THREE.Vector3().fromBufferAttribute(positions, index.getX(0));
      const b = new THREE.Vector3().fromBufferAttribute(positions, index.getX(1));
      const c = new THREE.Vector3().fromBufferAttribute(positions, index.getX(2));
      const geometricNormal = b.sub(a).cross(c.sub(a)).normalize();
      const vertexNormal = new THREE.Vector3().fromBufferAttribute(
        face.geometry.getAttribute('normal'),
        index.getX(0),
      );
      assertContract(
        geometricNormal.dot(vertexNormal) > 0.999,
        `${face.name} winding must agree with its outward normal`,
      );
    }

    const overhang = getFloatingWaterOverhang();
    const centers = new Map(curtains.map((curtain) => [
      curtain.name.slice('WaterCurtain:'.length),
      curtain.geometry.boundingSphere?.center,
    ]));
    assertContract(
      Math.abs((centers.get('north')?.z ?? Infinity) + overhang) < 1e-6,
      'north curtain sort center must stay on its own boundary',
    );
    assertContract(
      Math.abs((centers.get('east')?.x ?? Infinity) - (mapWidth + overhang)) < 1e-6,
      'east curtain sort center must stay on its own boundary',
    );
    assertContract(
      Math.abs((centers.get('south')?.z ?? Infinity) - (mapHeight + overhang)) < 1e-6,
      'south curtain sort center must stay on its own boundary',
    );
    assertContract(
      Math.abs((centers.get('west')?.x ?? Infinity) + overhang) < 1e-6,
      'west curtain sort center must stay on its own boundary',
    );
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
      Math.abs(bottomBounds.min.x + overhang) < 1e-6
        && Math.abs(bottomBounds.max.x - (mapWidth + overhang)) < 1e-6
        && Math.abs(bottomBounds.min.z + overhang) < 1e-6
        && Math.abs(bottomBounds.max.z - (mapHeight + overhang)) < 1e-6,
      'the bottom face must span the whole overhanging water footprint',
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
