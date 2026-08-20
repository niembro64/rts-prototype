import * as THREE from 'three';
import { buildGridOverlayFragment } from './BuildGridOverlayShader';
import { pathfindingHierarchyOverlayFragment } from './PathfindingHierarchyOverlayShader';
import { worldShadeFragment } from './WorldShade3D';
import { resolveMapInfoAnnexFootprint } from './MapInfoAnnex3D';
import {
  buildWorldBoxFloorGeometry,
  getWaterBoxFloorY,
  getWorldBoxFloorY,
} from './WorldBoxGeometry3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[world boundary shader contract] ${message}`);
}

export function runWorldBoundaryShaderContractTest(): void {
  const shade = worldShadeFragment('vTerrainWorldPos', true);
  assertContract(
    shade.includes('worldShadeEdgeTolerance') &&
      shade.includes('uWorldShadeWorldSize.x + worldShadeEdgeTolerance.x') &&
      shade.includes('uWorldShadeBoundsSize.x + worldShadeEdgeTolerance.x'),
    'fog/shadow coverage must tolerate interpolation around positive map boundaries',
  );
  // The info annex stands outside the coverage field. Its lookup is clamped
  // onto the map edge so the headland carries the fog of the coast it joins
  // — without that it is a lit shelf welded to a shore in shadow, and the
  // whole point of welding it on is lost. The DEPTH tier still comes from
  // the fragment's own altitude, not from the clamped lookup.
  assertContract(
    shade.includes('uWorldShadeAnnexMin') && shade.includes('uWorldShadeAnnexMax')
      && shade.includes('worldShadeSample.xz = clamp(')
      && shade.includes('float targetIsUnderwater = vTerrainWorldPos.y'),
    'the annex must read the map edge\'s coverage at its own altitude',
  );

  const verticalFaceGuard = 'abs(geomNormal.y) > 0.01';
  const build = buildGridOverlayFragment(
    'vTerrainWorldPos',
    'diffuseColor.rgb',
    verticalFaceGuard,
  );
  const hierarchy = pathfindingHierarchyOverlayFragment(
    'vTerrainWorldPos',
    'diffuseColor.rgb',
    verticalFaceGuard,
  );
  assertContract(
    build.includes(`if (${verticalFaceGuard} && uBuildGridEnabled`),
    'BUILD must reject vertical world-box faces before its exact map bounds',
  );
  assertContract(
    hierarchy.includes(`if (${verticalFaceGuard} && uPathfindingHierarchyEnabled`),
    'HIER must reject vertical world-box faces before its exact map bounds',
  );

  // THE UNDERSIDE OF THE WORLD. It closes the box, and it is the one surface
  // that must carry nothing: every term of the terrain shader is a function of
  // world XZ, so a floor drawn by that shader comes out wearing the grass,
  // rock, ore and weathering of the ground directly above it — at full
  // fragment cost, over the whole map. Two triangles, position and normal
  // only, is the shape of "there is nothing here to sample".
  const mapWidth = 4000;
  const mapHeight = 3000;
  const floorY = getWorldBoxFloorY(mapWidth, mapHeight);
  const floor = buildWorldBoxFloorGeometry(mapWidth, mapHeight, floorY);
  const position = floor.getAttribute('position');
  const normal = floor.getAttribute('normal');
  const index = floor.index;
  assertContract(
    position.count === 8 && index !== null && index.count === 12,
    'the world-box floor must be two triangles across the map footprint and two more under the info annex',
  );
  assertContract(
    Object.keys(floor.attributes).length === 2 && normal !== undefined,
    'the world-box floor must carry position and normal only — nothing to texture with',
  );
  for (let vertex = 0; vertex < position.count; vertex++) {
    assertContract(
      Math.abs(position.getY(vertex) - floorY) < 1e-6 && normal.getY(vertex) === -1,
      'every floor vertex must lie flat at the world-box floor, facing down',
    );
  }
  for (let triangle = 0; triangle < index.count / 3; triangle++) {
    const a = new THREE.Vector3().fromBufferAttribute(position, index.getX(triangle * 3));
    const b = new THREE.Vector3().fromBufferAttribute(position, index.getX(triangle * 3 + 1));
    const c = new THREE.Vector3().fromBufferAttribute(position, index.getX(triangle * 3 + 2));
    assertContract(
      b.sub(a).cross(c.sub(a)).normalize().y < -0.999,
      'every floor triangle must be wound so its front face is the one seen from under the world',
    );
  }
  // The annex's cap sits entirely outside the map footprint, exactly under
  // the headland the terrain mesh grows off the same edge.
  const annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
  const floorBounds = new THREE.Box3().setFromBufferAttribute(
    position as THREE.BufferAttribute,
  );
  assertContract(
    Math.abs(floorBounds.min.x - Math.min(0, annex.minX)) < 1e-6
      && Math.abs(floorBounds.max.x - Math.max(mapWidth, annex.maxX)) < 1e-6
      && Math.abs(floorBounds.min.z - Math.min(0, annex.minZ)) < 1e-6
      && Math.abs(floorBounds.max.z - Math.max(mapHeight, annex.maxZ)) < 1e-6,
    'the floor must close the map slab AND the annex hanging off it',
  );
  assertContract(
    getWaterBoxFloorY(mapWidth, mapHeight) < floorY,
    'the liquid box must close BELOW the land slab it contains',
  );
  floor.dispose();
}
