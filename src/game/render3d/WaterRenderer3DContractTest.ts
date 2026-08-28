import * as THREE from 'three';
import {
  getGraphicsConfig,
  getWaterBoundaryMode,
  setWaterBoundaryMode,
} from '@/clientBarConfig';
import { getFloatingWaterOverhang, getWaterBoxFloorY } from './WorldBoxGeometry3D';
import {
  mapInfoAnnexHalfWidthAt,
  mapInfoAnnexRowPointX,
  mapInfoAnnexRowPointZ,
  resolveMapInfoAnnexFootprint,
  resolveMapInfoAnnexLiquidRows,
} from './MapInfoAnnex3D';
import { WATER_LEVEL } from '../sim/Terrain';
import { WATER_BOX_FACES, WaterRenderer3D } from './WaterRenderer3D';
import { LAVA_RENDER_CONFIG, WATER_RENDER_CONFIG } from '@/config';
import { createLiquidSurfaceTexture3D } from './LiquidSurfaceTexture3D';
import { WaterSplash3D } from './WaterSplash3D';
import { hexToRgb01 } from './colorUtils';
import { SPLASH_CONFIG, type SplashLiquidMode } from '@/splashConfig';
import {
  getLiquidSurfaceMode,
  setLiquidSurfaceMode,
} from '../sim/worldSurfaceState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[water renderer contract] ${message}`);
}

function isPrimeInteger(value: number): boolean {
  if (!Number.isInteger(value) || value < 2) return false;
  for (let divisor = 2; divisor * divisor <= value; divisor++) {
    if (value % divisor === 0) return false;
  }
  return true;
}

function splashBirthColor(mode: SplashLiquidMode): THREE.Vector3 {
  const parent = new THREE.Group();
  const splash = new WaterSplash3D(parent);
  try {
    splash.createSplash(
      { x: 20, y: 30, z: WATER_LEVEL },
      { x: 12, y: 4, z: -80 },
      4,
      mode,
    );
    splash.update(0);
    const root = parent.children.find((child): child is THREE.Group => child instanceof THREE.Group);
    const activePool = root?.children.find(
      (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh && child.count > 0,
    );
    const colors = activePool?.geometry.getAttribute('aColor');
    assertContract(colors !== undefined && colors.count > 0, `${mode} splash must upload droplet colours`);
    return new THREE.Vector3(colors.getX(0), colors.getY(0), colors.getZ(0));
  } finally {
    splash.destroy();
  }
}

function assertLiquidSceneCompiles(
  parent: THREE.Group,
  mapWidth: number,
  mapHeight: number,
): void {
  const gpuRenderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  gpuRenderer.debug.checkShaderErrors = true;
  gpuRenderer.setSize(32, 32, false);
  const scene = new THREE.Scene();
  scene.add(parent);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20_000);
  camera.position.set(mapWidth * 0.5, 4_000, mapHeight * 0.5);
  camera.lookAt(mapWidth * 0.5, WATER_LEVEL, mapHeight * 0.5);
  const context = gpuRenderer.getContext();
  try {
    while (context.getError() !== context.NO_ERROR) {
      // Clear any implementation-specific setup errors before the contract
      // render so the result belongs to the liquid shader itself.
    }
    gpuRenderer.render(scene, camera);
    assertContract(
      context.getError() === context.NO_ERROR,
      'the active liquid material must compile and render without a WebGL error',
    );
  } finally {
    scene.remove(parent);
    gpuRenderer.dispose();
    gpuRenderer.forceContextLoss();
  }
}

export function runWaterRenderer3DContractTest(): void {
  const previousBoundaryMode = getWaterBoundaryMode();
  const previousLiquidSurfaceMode = getLiquidSurfaceMode();
  const mapWidth = 4000;
  const mapHeight = 3000;
  const parent = new THREE.Group();
  setLiquidSurfaceMode('water');
  const renderer = new WaterRenderer3D(parent, mapWidth, mapHeight);
  try {
    setWaterBoundaryMode('floating-square');
    renderer.update(0, getGraphicsConfig());

    const surface = renderer.getMesh();
    const surfaceMaterial = surface.material as THREE.MeshBasicMaterial;
    const curtains = parent.children.filter(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh && child.name.startsWith('WaterCurtain:'),
    );
    assertContract(surface.name === 'WaterSurface', 'picking must retain one horizontal surface');
    assertContract(
      surfaceMaterial.map?.name === 'LiquidSurfaceTexture:water' &&
        surfaceMaterial.transparent &&
        surfaceMaterial.opacity === WATER_RENDER_CONFIG.opacity,
      'water must carry subtle surface texture without changing its authored transparency',
    );
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
        curtainMaterial.map === null &&
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
    const surfacePositions = surface.geometry.getAttribute('position');
    const surfaceUvs = surface.geometry.getAttribute('uv');
    assertContract(
      surfaceUvs !== undefined && surfaceUvs.count === surfacePositions.count,
      'every liquid-surface vertex must carry world-anchored texture coordinates',
    );
    const waterShader = {
      uniforms: {} as Record<string, { value: unknown }>,
      fragmentShader: '#include <map_pars_fragment>\n#include <map_fragment>',
    };
    (surfaceMaterial.onBeforeCompile as (shader: typeof waterShader) => void)(waterShader);
    const waterFlow = [
      waterShader.uniforms.uLiquidFlow0?.value,
      waterShader.uniforms.uLiquidFlow1?.value,
      waterShader.uniforms.uLiquidFlow2?.value,
    ] as THREE.Vector2[];
    assertContract(
      waterFlow.every((offset) => offset instanceof THREE.Vector2)
        && waterShader.fragmentShader.includes('waterSecondary')
        && waterShader.fragmentShader.includes('waterTertiary')
        && !waterShader.fragmentShader.includes('#include <map_fragment>'),
      'water must blend three independently advected seamless flow layers',
    );
    renderer.update(1, getGraphicsConfig(), undefined, { x: 12, y: 0 });
    assertContract(
      waterFlow.every((offset) => offset.x > 0 && Math.abs(offset.y) < offset.x * 0.35),
      'every water layer must travel generally along the live +X wind',
    );
    assertContract(
      new Set(
        waterFlow.map((offset) => Math.atan2(offset.y, offset.x).toFixed(6)),
      ).size === 3,
      'the three water layers must wiggle on distinct headings rather than one clean conveyor',
    );
    assertLiquidSceneCompiles(parent, mapWidth, mapHeight);

    const waterTexture = createLiquidSurfaceTexture3D('water', WATER_RENDER_CONFIG.texture);
    const lavaTexture = createLiquidSurfaceTexture3D('lava', LAVA_RENDER_CONFIG.texture);
    assertContract(
      [...WATER_RENDER_CONFIG.texture.wigglePeriodsSeconds,
        ...LAVA_RENDER_CONFIG.texture.wigglePeriodsSeconds].every(isPrimeInteger),
      'all three liquid-layer wiggles in both media must use prime-number periods',
    );
    const waterSplashColor = splashBirthColor('water');
    const lavaSplashColor = splashBirthColor('lava');
    const expectedWaterSplash = hexToRgb01(SPLASH_CONFIG.appearance.waterBirthColorHex);
    const expectedLavaSplash = hexToRgb01(SPLASH_CONFIG.appearance.lavaBirthColorHex);
    assertContract(
      waterSplashColor.distanceTo(new THREE.Vector3(
        expectedWaterSplash.r,
        expectedWaterSplash.g,
        expectedWaterSplash.b,
      )) < 1e-6
        && waterSplashColor.z > waterSplashColor.x,
      'water impacts must emit the authored cool blue droplet ramp',
    );
    assertContract(
      lavaSplashColor.distanceTo(new THREE.Vector3(
        expectedLavaSplash.r,
        expectedLavaSplash.g,
        expectedLavaSplash.b,
      )) < 1e-6
        && lavaSplashColor.x >= lavaSplashColor.y
        && lavaSplashColor.y > lavaSplashColor.z,
      'lava impacts must emit the authored white-hot-to-orange droplet ramp',
    );
    const channelRange = (texture: THREE.DataTexture): number => {
      const data = texture.image.data as Uint8Array;
      let low = 255;
      let high = 0;
      for (let index = 0; index < data.length; index += 4) {
        low = Math.min(low, data[index], data[index + 1], data[index + 2]);
        high = Math.max(high, data[index], data[index + 1], data[index + 2]);
        assertContract(data[index + 3] === 255, 'texture alpha must never alter liquid opacity');
      }
      return high - low;
    };
    const waterRange = channelRange(waterTexture);
    const lavaRange = channelRange(lavaTexture);
    waterTexture.dispose();
    lavaTexture.dispose();
    assertContract(
      waterRange >= 4 && waterRange <= 28 && lavaRange >= 100,
      `water grain must stay minimal while lava reads strongly (${waterRange}/${lavaRange})`,
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
    const armRows = resolveMapInfoAnnexLiquidRows(annex, overhang, 400);
    const armSeam = armRows[0];
    const armRim = armRows[armRows.length - 1];
    const armMinZ = mapInfoAnnexRowPointZ(annex, armRim, 0);
    const armSeamMinX = Math.min(
      mapInfoAnnexRowPointX(annex, armSeam, -1),
      mapInfoAnnexRowPointX(annex, armSeam, 1),
    );
    const armSeamMaxX = Math.max(
      mapInfoAnnexRowPointX(annex, armSeam, -1),
      mapInfoAnnexRowPointX(annex, armSeam, 1),
    );
    const bounds = new Map(curtains.map((curtain) => {
      curtain.geometry.computeBoundingBox();
      return [curtain.name.slice('WaterCurtain:'.length), curtain.geometry.boundingBox];
    }));
    // Each face mesh still owns the plane(s) of its own direction — the arm
    // sorts each of its segments onto the face its outward normal most nearly
    // points at, so transparent sorting still orders the box by direction.
    // The arm's flanks are diagonal now, so a face's bounds reach as far as
    // the segments it took, not to a rectangle's corner.
    assertContract(
      Math.abs((bounds.get('north')?.max.z ?? Infinity) + overhang) < 1e-6
        && Math.abs((bounds.get('north')?.min.z ?? Infinity) - armMinZ) < 1e-6,
      'the north face must run from the map boundary out to the annex arm and no further',
    );
    assertContract(
      Math.abs((bounds.get('east')?.max.x ?? Infinity) - (mapWidth + overhang)) < 1e-6
        && (bounds.get('east')?.min.x ?? Infinity) < armSeamMaxX + 1e-6
        && (bounds.get('east')?.min.z ?? Infinity) < 0,
      'the east face must own the map boundary and the arm flank on its side',
    );
    assertContract(
      Math.abs((bounds.get('south')?.min.z ?? Infinity) - (mapHeight + overhang)) < 1e-6
        && Math.abs((bounds.get('south')?.max.z ?? Infinity) - (mapHeight + overhang)) < 1e-6,
      'the south face is untouched by the annex and must stay on its own boundary',
    );
    assertContract(
      Math.abs((bounds.get('west')?.min.x ?? Infinity) + overhang) < 1e-6
        && (bounds.get('west')?.max.x ?? -Infinity) > armSeamMinX - 1e-6
        && (bounds.get('west')?.min.z ?? Infinity) < 0,
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
          || x <= armSeamMinX + 1e-6
          || x >= armSeamMaxX - 1e-6,
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
      Math.abs(bottomBounds.min.x + overhang) < 1e-6
        && Math.abs(bottomBounds.max.x - (mapWidth + overhang)) < 1e-6
        && Math.abs(bottomBounds.min.z - armMinZ) < 1e-6
        && Math.abs(bottomBounds.max.z - (mapHeight + overhang)) < 1e-6,
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
        && Math.abs(surfaceBounds.min.z - armMinZ) < 1e-6,
      'the liquid surface must reach over the annex at exactly the map\'s own level',
    );
    // THE ARM FOLLOWS THE HEADLAND, NOT ITS BOX. Every liquid vertex out past
    // the map's own border has to sit within one overhang of the land — a
    // bounding-box arm would put its corners a good deal further out than
    // that, in a wedge of slack water at each cut corner.
    for (const face of [...curtains, surface]) {
      const positions = face.geometry.getAttribute('position');
      for (let vertex = 0; vertex < positions.count; vertex++) {
        const z = positions.getZ(vertex);
        if (z >= -overhang - 1e-6) continue;
        const x = positions.getX(vertex);
        const out = (x - annex.attachX) * annex.outX + (z - annex.attachZ) * annex.outZ;
        const across = Math.abs(
          (x - annex.attachX) * annex.alongX + (z - annex.attachZ) * annex.alongZ,
        );
        // A world unit of slack: the geometry is float32, and the numbers a
        // diagonal produces are not exactly representable. Far tighter than
        // the hundreds of units a bounding-box arm would be out by.
        assertContract(
          across <= mapInfoAnnexHalfWidthAt(annex, out, overhang) + 1,
          `${face.name} must stay inside the annex's own liquid border`,
        );
      }
    }
    const bottomNormal = new THREE.Vector3().fromBufferAttribute(
      bottom.geometry.getAttribute('normal'),
      0,
    );
    assertContract(bottomNormal.y < -0.999, 'the bottom face must point down and out of the box');

    setLiquidSurfaceMode('lava');
    renderer.update(0, getGraphicsConfig());
    const lavaTextureName: string | undefined = surfaceMaterial.map?.name;
    assertContract(
      lavaTextureName === 'LiquidSurfaceTexture:lava'
        && !surfaceMaterial.transparent
        && surfaceMaterial.opacity === 1
        && surfaceMaterial.userData.liquidSurfaceShader === 'lava-wind-flow-v1',
      'lava must replace the water skin with an opaque animated crust material',
    );
    const lavaShader = {
      uniforms: {} as Record<string, { value: unknown }>,
      fragmentShader: '#include <map_pars_fragment>\n#include <map_fragment>',
    };
    (surfaceMaterial.onBeforeCompile as (shader: typeof lavaShader) => void)(lavaShader);
    const lavaTime = lavaShader.uniforms.uLiquidTime;
    const lavaFlow = [
      lavaShader.uniforms.uLiquidFlow0?.value,
      lavaShader.uniforms.uLiquidFlow1?.value,
      lavaShader.uniforms.uLiquidFlow2?.value,
    ] as THREE.Vector2[];
    assertContract(
      lavaTime !== undefined
        && lavaFlow.every((offset) => offset instanceof THREE.Vector2)
        && lavaShader.fragmentShader.includes('lavaSecondary')
        && lavaShader.fragmentShader.includes('lavaTertiary')
        && !lavaShader.fragmentShader.includes('#include <map_fragment>'),
      'lava shader must layer three independently advected crust fields instead of sliding one decal',
    );
    const initialLavaTime = lavaTime.value as number;
    renderer.update(1, getGraphicsConfig(), undefined, { x: 0, y: 8 });
    assertContract(
      (lavaTime.value as number) > initialLavaTime,
      'lava flow time must advance with rendered time',
    );
    assertContract(
      lavaFlow.every((offset) => offset.y > 0 && Math.abs(offset.x) < offset.y * 0.27),
      'every lava layer must travel generally along the live +Y wind',
    );
    assertLiquidSceneCompiles(parent, mapWidth, mapHeight);

    setLiquidSurfaceMode('none');
    renderer.update(0, getGraphicsConfig());
    assertContract(
      !surface.visible
        && (surface.geometry.getAttribute('position')?.count ?? -1) === 0
        && curtains.every(
          (curtain) => (curtain.geometry.getAttribute('position')?.count ?? -1) === 0,
        ),
      'NONE must remove all liquid geometry, including the cursor-pickable surface',
    );

    setLiquidSurfaceMode('water');
    renderer.update(0, getGraphicsConfig());
    const restoredWaterTextureName: string | undefined = surfaceMaterial.map?.name;
    assertContract(
      surface.visible
        && (surface.geometry.getAttribute('position')?.count ?? 0) > 0
        && restoredWaterTextureName === 'LiquidSurfaceTexture:water',
      'switching back to WATER must rebuild the surface with water material state',
    );
  } finally {
    renderer.destroy();
    setWaterBoundaryMode(previousBoundaryMode);
    setLiquidSurfaceMode(previousLiquidSurfaceMode);
  }
}
