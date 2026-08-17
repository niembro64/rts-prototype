import * as THREE from 'three';
import {
  getGraphicsConfig,
  getWaterBoundaryMode,
  setWaterBoundaryMode,
} from '@/clientBarConfig';
import { getFloatingWaterOverhang } from './WorldBoxGeometry3D';
import { WaterRenderer3D } from './WaterRenderer3D';

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
    assertContract(curtains.length === 4, 'floating square must own four separate curtain meshes');
    assertContract(
      new Set(curtains.map((curtain) => curtain.geometry)).size === 4,
      'each curtain needs independent geometry so transparent object sorting can order it',
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
      'every floating-square curtain must contain rendered triangles',
    );
    for (const curtain of curtains) {
      const positions = curtain.geometry.getAttribute('position');
      const index = curtain.geometry.index;
      assertContract(positions !== undefined && index !== null, `${curtain.name} needs indexed geometry`);
      const a = new THREE.Vector3().fromBufferAttribute(positions, index.getX(0));
      const b = new THREE.Vector3().fromBufferAttribute(positions, index.getX(1));
      const c = new THREE.Vector3().fromBufferAttribute(positions, index.getX(2));
      const geometricNormal = b.sub(a).cross(c.sub(a)).normalize();
      const vertexNormal = new THREE.Vector3().fromBufferAttribute(
        curtain.geometry.getAttribute('normal'),
        index.getX(0),
      );
      assertContract(
        geometricNormal.dot(vertexNormal) > 0.999,
        `${curtain.name} winding must agree with its outward normal`,
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
  } finally {
    renderer.destroy();
    setWaterBoundaryMode(previousMode);
  }
}
