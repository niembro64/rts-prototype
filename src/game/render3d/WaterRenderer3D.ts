// WaterRenderer3D — single translucent water plane covering the
// entire map at WATER_LEVEL.
//
// Pairs with the Terrain.ts changes that:
//   - Clamp `getTerrainHeight` to >= TILE_FLOOR_Y so terrain never
//     dips below the bottom of the 3D tile cubes.
//   - Clamp `getSurfaceHeight` (the physics ground) to >= WATER_LEVEL,
//     so units walk on the water surface anywhere the actual terrain
//     dips below it.
//
// Visually: the carved terrain BELOW WATER_LEVEL stays in the scene
// (the tile renderer draws the actual heightmap shape), and this
// translucent plane sits on top at WATER_LEVEL — so deep trenches /
// craters look like submerged pools through the water tint.
//
// LOD: the geometry is subdivided so the vertex shader can drive a
// gentle wave displacement (two phase-shifted sin/cos lobes keyed to
// position + time). Cheap — single draw call, no per-frame buffer
// updates from the CPU side; the time uniform ticks once per frame
// and the GPU does the displacement. Material is double-sided so
// underwater terrain shows through correctly when the camera is
// looking up from below.

import * as THREE from 'three';
import { WATER_LEVEL } from '../sim/Terrain';
import { getGridOverlay } from '@/clientBarConfig';

/** Subdivisions for the wave displacement. 96×96 is a sweet spot:
 *  enough resolution that the sin/cos waves read smoothly across a
 *  ~6000 wu wide map, cheap enough to issue in one draw call. */
const SUBDIVISIONS = 96;

/** Wave amplitude in world units. Small enough that the water never
 *  visibly clips through the tile floors. */
const WAVE_AMPLITUDE = 6;

/** Wavelengths of the two perpendicular wave lobes (world units). */
const WAVE_LAMBDA_X = 240;
const WAVE_LAMBDA_Z = 320;

/** Time scale (radians per second) for the two lobes. Phase-shifted
 *  so the surface looks alive, not periodic. */
const WAVE_OMEGA_X = 0.6;
const WAVE_OMEGA_Z = 0.45;

/** Standard "mid-day overhead view" water blue, plus a noticeable
 *  alpha so deep terrain reads as submerged through the tint. */
const WATER_COLOR = 0x3a82c4;
const WATER_OPACITY = 0.55;

export class WaterRenderer3D {
  private mesh: THREE.Mesh;
  private timeUniform = { value: 0 };

  constructor(parent: THREE.Group, mapWidth: number, mapHeight: number) {
    // PlaneGeometry is created in the XY plane; rotate to the XZ
    // plane (lying flat at world y = 0) by baking a rotation into
    // the vertex positions. After this `position.y` is the world-up
    // component of the vertex (0 for every vert in the rest pose),
    // and `position.x` / `position.z` are the horizontal coordinates.
    const geom = new THREE.PlaneGeometry(
      mapWidth, mapHeight,
      SUBDIVISIONS, SUBDIVISIONS,
    );
    geom.rotateX(-Math.PI / 2);

    // Lambert with onBeforeCompile patch: the standard shader runs
    // for ambient + sun lighting, we just inject a vertex
    // displacement that makes the surface ripple. Cheap because the
    // CPU side does nothing per frame except advance the time
    // uniform.
    const material = new THREE.MeshLambertMaterial({
      color: WATER_COLOR,
      transparent: true,
      opacity: WATER_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uWaterTime = this.timeUniform;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `
        uniform float uWaterTime;
        #include <common>
        `,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        // Two sine lobes phase-shifted by perpendicular wavelengths;
        // sum gives an alive-but-not-tile-able water surface. Costs
        // a few flops per vertex.
        vec3 transformed = vec3(position);
        float phaseX = position.x * (6.2831853 / ${WAVE_LAMBDA_X.toFixed(1)})
                     + uWaterTime * ${WAVE_OMEGA_X.toFixed(3)};
        float phaseZ = position.z * (6.2831853 / ${WAVE_LAMBDA_Z.toFixed(1)})
                     + uWaterTime * ${WAVE_OMEGA_Z.toFixed(3)};
        transformed.y += sin(phaseX) * ${(WAVE_AMPLITUDE * 0.6).toFixed(3)}
                       + cos(phaseZ) * ${(WAVE_AMPLITUDE * 0.4).toFixed(3)};
        `,
      );
    };

    this.mesh = new THREE.Mesh(geom, material);
    // Position the plane center at the map center, lifted to
    // WATER_LEVEL (the half-way point between the tile floor and
    // ground zero). The plane covers the full map footprint.
    this.mesh.position.set(mapWidth / 2, WATER_LEVEL, mapHeight / 2);
    // Don't cull — water spans the whole map and we always want it
    // rendering when ANY part is on screen. The mesh is one quad
    // big-as-the-map; trivial to keep visible.
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  /** Per-frame tick — advances the wave time. Called from the
   *  scene's update loop with the (clamped) frame dt in seconds.
   *
   *  Visibility piggybacks on the GRID overlay toggle: GRID:OFF hides
   *  the capture-tile colour overlay (CaptureTileRenderer3D treats the
   *  same setting as a master "show world topography decorations"
   *  switch) and we hide the water plane along with it so a fully-
   *  unadorned terrain view shows the raw tile geometry without the
   *  translucent blue layer on top. Skip advancing the time uniform
   *  while invisible — no waves, no shader cost. */
  update(dtSec: number): void {
    const visible = getGridOverlay() !== 'off';
    this.mesh.visible = visible;
    if (!visible) return;
    this.timeUniform.value += dtSec;
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
