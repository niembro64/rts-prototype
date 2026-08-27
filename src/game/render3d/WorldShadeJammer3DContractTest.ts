import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import { applyBuildingBlueprintRuntime } from '../sim/buildingEntityRuntime';
import { getBuildingConfig } from '../sim/buildConfigs';
import type { Entity, PlayerId } from '../sim/types';
import { WorldState } from '../sim/WorldState';
import { WATER_LEVEL } from '../sim/Terrain';
import { EntityShadowRenderPacket3D } from './EntityShadowRenderPacket3D';
import {
  WORLD_SHADE_FRAGMENT_PARS,
  WorldShade3D,
  worldShadeFragment,
} from './WorldShade3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[world shade jammer contract] ${message}`);
}

type Pixel = { r: number; g: number; b: number };

/**
 * Exercise the real array render target, union blend, and terrain-side shader
 * sample in WebGL. Source-string checks cannot prove that a sampler2DArray is
 * renderable, that framebufferTextureLayer receives each pass, or that two
 * half-strength jammer penumbras reinforce without a seam; this test can.
 */
export function runWorldShadeJammer3DContractTest(): void {
  const mapWidth = 2400;
  const mapHeight = 700;
  const outputWidth = 360;
  const outputHeight = 105;
  const playerOne = 1 as PlayerId;
  const alliedPlayer = 2 as PlayerId;
  const enemyPlayer = 3 as PlayerId;
  const world = new WorldState(9183, mapWidth, mapHeight);

  const makeJammer = (
    blueprintId: 'buildingRadarJammer' | 'buildingSonarJammer',
    playerId: PlayerId,
    x: number,
    medium: 'radar' | 'sonar',
  ): Entity => {
    const config = getBuildingConfig(blueprintId);
    const entity = world.createBuilding(
      x,
      mapHeight * 0.5,
      config.gridWidth * 20,
      config.gridHeight * 20,
      config.gridDepth * 20,
      playerId,
    );
    applyBuildingBlueprintRuntime(entity, blueprintId);
    assertContract(
      entity.building !== null && entity.building.activeState !== null,
      `${blueprintId} must expose its powered state`,
    );
    entity.buildable = null;
    entity.building.hp = config.hp;
    entity.building.maxHp = config.hp;
    entity.building.activeState.open = true;
    entity.transform.z = medium === 'radar' ? WATER_LEVEL : WATER_LEVEL - 100;
    const mount = entity.combat?.utilityMounts.find((candidate) =>
      candidate.kind === 'sensor');
    assertContract(mount?.kind === 'sensor', `${blueprintId} needs its sensor mount`);
    mount.sensors.jammingRadius = 300;
    return entity;
  };

  const radar = makeJammer('buildingRadarJammer', playerOne, 400, 'radar');
  const alliedSonar = makeJammer(
    'buildingSonarJammer',
    alliedPlayer,
    1000,
    'sonar',
  );
  const enemyRadar = makeJammer(
    'buildingRadarJammer',
    enemyPlayer,
    2000,
    'radar',
  );

  let tick = 1;
  let includeAlliedSonar = false;
  const clientViewState = {
    getTick: () => tick,
    getEntitySetVersion: () => 1,
    getVisionPlayerIds: () => [playerOne, alliedPlayer],
    getUnitsByPlayer: () => [],
    getBuildingsByPlayer: (playerId: PlayerId) => {
      if (playerId === playerOne) return [radar];
      if (playerId === alliedPlayer) return includeAlliedSonar ? [alliedSonar] : [];
      if (playerId === enemyPlayer) return [enemyRadar];
      return [];
    },
    getScanPulses: () => [],
  } as unknown as ClientViewState;

  const renderer = new THREE.WebGLRenderer({
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
  });
  renderer.debug.checkShaderErrors = true;
  renderer.setSize(outputWidth, outputHeight, false);
  renderer.setClearColor(0x000000, 1);
  const worldShade = new WorldShade3D(renderer, mapWidth, mapHeight);
  const output = new THREE.WebGLRenderTarget(outputWidth, outputHeight, {
    depthBuffer: false,
    stencilBuffer: false,
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const shader = { uniforms: {} } as THREE.WebGLProgramParametersWithUniforms;
  worldShade.assignUniforms(shader);
  const material = new THREE.ShaderMaterial({
    uniforms: shader.uniforms,
    vertexShader: `
out vec3 vWorldPosition;
void main() {
  vWorldPosition = vec3(
    (position.x * 0.5 + 0.5) * ${mapWidth.toFixed(1)},
    1.0,
    (position.y * 0.5 + 0.5) * ${mapHeight.toFixed(1)}
  );
  gl_Position = vec4(position, 1.0);
}
`,
    fragmentShader: `
in vec3 vWorldPosition;
layout(location = 0) out highp vec4 contractColor;
${WORLD_SHADE_FRAGMENT_PARS}
void main() {
  contractColor = vec4(0.10, 0.40, 0.10, 1.0);
  ${worldShadeFragment(
    'vWorldPosition',
    false,
    'contractColor.rgb',
    true,
  )}
}
`,
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.Camera();
  const emptyShadows = new EntityShadowRenderPacket3D();
  const shadeSettings = {
    enabled: false,
    jammerTintEnabled: true,
    unseenDarkness: 0,
    radarDarkness: 0,
    unseenDesaturation: 0,
    radarDesaturation: 0,
  };
  const visibleBounds = { minX: 0, minY: 0, maxX: mapWidth, maxY: mapHeight };
  const pixelBytes = new Uint8Array(4);
  const readPixel = (worldX: number): Pixel => {
    const px = Math.max(
      0,
      Math.min(outputWidth - 1, Math.floor(worldX / mapWidth * outputWidth)),
    );
    renderer.readRenderTargetPixels(
      output,
      px,
      Math.floor(outputHeight * 0.5),
      1,
      1,
      pixelBytes,
    );
    return { r: pixelBytes[0], g: pixelBytes[1], b: pixelBytes[2] };
  };
  const draw = (): void => {
    worldShade.update(
      clientViewState,
      playerOne,
      shadeSettings,
      emptyShadows,
      visibleBounds,
      true,
    );
    renderer.setRenderTarget(output);
    renderer.clear(true, false, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
  };

  const shaderErrors: string[] = [];
  const previousConsoleError = console.error;
  console.error = (...values: unknown[]) => {
    shaderErrors.push(values.map(String).join(' '));
  };
  try {
    // One source: center is the full tint; its nominal 300-unit radius is the
    // midpoint of the 192-unit soft edge.
    draw();
    const outside = readPixel(1600);
    const center = readPixel(400);
    const oneEdge = readPixel(700);
    const enemyCenter = readPixel(2000);
    const centerRedDelta = center.r - outside.r;
    const edgeRedDelta = oneEdge.r - outside.r;
    assertContract(
      centerRedDelta > 15 && center.g < outside.g - 4,
      `friendly jammer center must tint red (center=${JSON.stringify(center)}, outside=${JSON.stringify(outside)})`,
    );
    assertContract(
      edgeRedDelta > centerRedDelta * 0.35 &&
        edgeRedDelta < centerRedDelta * 0.65,
      `the authored radius must sit near the soft-edge midpoint (center delta ${centerRedDelta}, edge delta ${edgeRedDelta})`,
    );
    assertContract(
      Math.abs(enemyCenter.r - outside.r) <= 2 &&
        Math.abs(enemyCenter.g - outside.g) <= 2,
      'an enemy jammer must not reveal its protected footprint to this team',
    );

    // Radar and allied sonar fields share one presentation union. Their two
    // half-strength penumbras meet at x=700 and should reinforce to ~75%, not
    // remain at 50%, cancel, or draw a dark seam.
    includeAlliedSonar = true;
    tick++;
    draw();
    const overlap = readPixel(700);
    const overlapRedDelta = overlap.r - outside.r;
    assertContract(
      overlapRedDelta > edgeRedDelta * 1.30 &&
        overlapRedDelta < centerRedDelta * 0.90,
      `overlapping radar/sonar penumbras must union smoothly (one ${edgeRedDelta}, overlap ${overlapRedDelta}, full ${centerRedDelta})`,
    );

    // The exact same operational gate used by contact denial drives the
    // presentation source walk. OFF must clear the already-rendered layer,
    // not merely stop adding new rings over stale texture contents.
    radar.building!.activeState!.open = false;
    alliedSonar.building!.activeState!.open = false;
    tick++;
    draw();
    const switchedOff = readPixel(400);
    assertContract(
      Math.abs(switchedOff.r - outside.r) <= 2 &&
        Math.abs(switchedOff.g - outside.g) <= 2,
      `switching every jammer OFF must clear the tint (off=${JSON.stringify(switchedOff)}, outside=${JSON.stringify(outside)})`,
    );
    assertContract(
      shaderErrors.length === 0,
      `jammer array shader emitted WebGL errors: ${shaderErrors.join(' | ')}`,
    );
  } finally {
    console.error = previousConsoleError;
    scene.remove(mesh);
    geometry.dispose();
    material.dispose();
    output.dispose();
    worldShade.destroy();
    renderer.dispose();
  }
}
