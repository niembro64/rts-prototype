import * as THREE from 'three';
import type { SprayTarget } from '@/types/ui';
import { getSprayTargetWireFlags } from '../network/sprayTargetWireHelpers';
import { serializeSprayTargets } from '../network/stateSerializerSpray';
import { SprayRenderer3D } from './SprayRenderer3D';
import { RESOURCE_CONFIG } from '@/resourceConfig';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';
import {
  TETRAHEDRON_PARTICLE_RADIUS,
  TETRAHEDRON_PARTICLE_SPIN_MAX_RAD_PER_SEC,
  TETRAHEDRON_PARTICLE_SPIN_MIN_RAD_PER_SEC,
} from '@/tetrahedronParticleProfile';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`SprayRenderer3D contract: ${message}`);
}

type SprayParticleDebugState = {
  particleCount: number;
  mat: THREE.ShaderMaterial;
  root: THREE.Group;
  pStartX: Float32Array;
  pStartY: Float32Array;
  pStartZ: Float32Array;
  pEndX: Float32Array;
  pEndY: Float32Array;
  pEndZ: Float32Array;
  pLife: Float32Array;
  pSize: Float32Array;
  pSpinAxisX: Float32Array;
  pSpinAxisY: Float32Array;
  pSpinAxisZ: Float32Array;
  pSpinRate: Float32Array;
  pR: Float32Array;
  pG: Float32Array;
  pB: Float32Array;
};

function makeDirectSpray(inverse: boolean): SprayTarget {
  return {
    source: { id: 10, pos: { x: 10, y: 20 }, z: 30, playerId: 1 },
    target: { id: 20, pos: { x: 100, y: 200 }, z: 300, radius: 5 },
    type: 'build',
    intensity: 1,
    channel: inverse ? 1 : 0,
    flow: 'direct',
    inverse,
    flowRadius: 0,
  };
}

function assertNear(actual: number, expected: number, message: string): void {
  assertContract(Math.abs(actual - expected) < 1e-5, `${message}: expected ${expected}, got ${actual}`);
}

export function runSprayRenderer3DContractTest(): void {
  const inverseSpray = makeDirectSpray(true);
  assertContract(
    (getSprayTargetWireFlags(inverseSpray) & 0x100) !== 0,
    'inverse mode must occupy spray wire flag bit 8',
  );
  const serialized = serializeSprayTargets([inverseSpray], undefined, 'spray-direction-contract');
  assertContract(
    serialized?.length === 1 && serialized[0].inverse === true,
    'inverse mode must survive DTO serialization',
  );

  const parent = new THREE.Group();
  const renderer = new SprayRenderer3D(parent);
  try {
    const renderState = renderer as unknown as SprayParticleDebugState;
    assertContract(
      renderState.mat.depthTest === true,
      'solid depth must occlude construction spray',
    );
    assertContract(
      renderState.mat.toneMapped === false &&
        renderState.mat.uniforms.uBrightness === undefined &&
        renderState.mat.userData.renderLighting === 'self-lit',
      'construction tetrahedra must stay display-bright instead of being dimmed by scene exposure',
    );
    assertContract(
      renderState.root.children.length > 0 &&
        renderState.root.children.every((child) =>
          child.renderOrder === TRANSPARENT_RENDER_ORDER_3D.throughWaterEffects &&
          child.renderOrder < TRANSPARENT_RENDER_ORDER_3D.waterSurface),
      'spray must draw before the water surface so submerged particles remain visible through water',
    );
    renderer.update([], 0, [makeDirectSpray(false)]);
    let state = renderer as unknown as SprayParticleDebugState;
    assertContract(state.particleCount === 1, 'normal direct spray must emit one test particle');
    assertNear(state.pStartX[0], 10, 'normal spray must start at builder x');
    assertNear(state.pStartY[0], 30, 'normal spray must start at builder z/height');
    assertNear(state.pStartZ[0], 20, 'normal spray must start at builder ground y');
    assertContract(
      Math.hypot(state.pEndX[0] - 100, state.pEndY[0] - 300, state.pEndZ[0] - 200) <= 5.0001,
      'normal spray must end inside the target volume',
    );
    assertNear(
      state.pSize[0],
      TETRAHEDRON_PARTICLE_RADIUS[1],
      'default build spray must use the shared medium tetrahedron radius',
    );
    const spinAxisLength = Math.hypot(
      state.pSpinAxisX[0],
      state.pSpinAxisY[0],
      state.pSpinAxisZ[0],
    );
    assertNear(spinAxisLength, 1, 'build spray spin axis must be normalized once at birth');
    assertContract(
      Math.abs(state.pSpinRate[0]) >= TETRAHEDRON_PARTICLE_SPIN_MIN_RAD_PER_SEC &&
        Math.abs(state.pSpinRate[0]) <= TETRAHEDRON_PARTICLE_SPIN_MAX_RAD_PER_SEC,
      'build spray must keep a bounded non-zero signed spin rate',
    );
    const closeMesh = state.root.children[0] as THREE.InstancedMesh;
    const matrixBeforeSpin = new THREE.Matrix4();
    const matrixAfterSpin = new THREE.Matrix4();
    const beforeSpinRotation = new THREE.Quaternion();
    const afterSpinRotation = new THREE.Quaternion();
    const scratchPosition = new THREE.Vector3();
    const scratchScale = new THREE.Vector3();
    closeMesh.getMatrixAt(0, matrixBeforeSpin);
    matrixBeforeSpin.decompose(scratchPosition, beforeSpinRotation, scratchScale);
    const initialSpinRate = state.pSpinRate[0];
    renderer.update([], 100);
    state = renderer as unknown as SprayParticleDebugState;
    closeMesh.getMatrixAt(0, matrixAfterSpin);
    matrixAfterSpin.decompose(scratchPosition, afterSpinRotation, scratchScale);
    assertContract(
      beforeSpinRotation.angleTo(afterSpinRotation) > 0.1 &&
        state.pSpinRate[0] === initialSpinRate,
      'build spray must advance one immutable spawn-time spin for its whole lifetime',
    );

    renderer.update([], 0, [inverseSpray]);
    state = renderer as unknown as SprayParticleDebugState;
    assertContract(state.particleCount === 2, 'inverse direct spray must emit one test particle');
    assertContract(
      Math.hypot(state.pStartX[1] - 100, state.pStartY[1] - 300, state.pStartZ[1] - 200) <= 5.0001,
      'inverse spray must start inside the target volume',
    );
    assertNear(state.pEndX[1], 10, 'inverse spray must converge on builder x');
    assertNear(state.pEndY[1], 30, 'inverse spray must converge on builder z/height');
    assertNear(state.pEndZ[1], 20, 'inverse spray must converge on builder ground y');

    // Build spray is the authored nanolathe green for every player — a
    // presentation fact the renderer owns.
    const [buildR, buildG, buildB] = RESOURCE_CONFIG.spray.buildRgb01;
    for (let i = 0; i < 2; i++) {
      assertNear(state.pR[i], buildR, 'build spray must use the authored green, not a team color');
      assertNear(state.pG[i], buildG, 'build spray must use the authored green, not a team color');
      assertNear(state.pB[i], buildB, 'build spray must use the authored green, not a team color');
    }

    const otherTeamSpray = makeDirectSpray(false);
    otherTeamSpray.source = { ...otherTeamSpray.source, playerId: 4 };
    renderer.update([], 0, [otherTeamSpray]);
    state = renderer as unknown as SprayParticleDebugState;
    assertNear(state.pR[2], buildR, 'a second player must spray the same green');
    assertNear(state.pG[2], buildG, 'a second player must spray the same green');
    assertNear(state.pB[2], buildB, 'a second player must spray the same green');

    // Pylon resource balls ride the same 'build' path but carry an explicit
    // per-resource color, which must survive and must not tumble.
    const pylonSpray = makeDirectSpray(false);
    pylonSpray.colorRGB = { r: 0.9, g: 0.2, b: 0.1 };
    renderer.update([], 0, [pylonSpray]);
    state = renderer as unknown as SprayParticleDebugState;
    assertNear(state.pR[3], 0.9, 'an explicit spray color must win over the build green');

    // A building target arrives as its HIT box: `dim` is the FULL x/y
    // extents, `radius` the vertical half-extent, and the center already
    // carries the combat-centered z (a hovering fabricator's torus, not the
    // ground under it). Particles must land inside that box.
    const boxSpray = makeDirectSpray(false);
    boxSpray.target = {
      id: 21,
      pos: { x: 400, y: 500 },
      z: 250,
      dim: { x: 100, y: 40 },
      radius: 10,
    };
    renderer.update([], 0, [boxSpray]);
    state = renderer as unknown as SprayParticleDebugState;
    assertContract(
      Math.abs(state.pEndX[4] - 400) <= 50.0001 &&
        Math.abs(state.pEndZ[4] - 500) <= 20.0001 &&
        Math.abs(state.pEndY[4] - 250) <= 10.0001,
      'a box-target build spray must end inside the target box, centered on its combat z',
    );

    const standardizedSprays = TETRAHEDRON_PARTICLE_RADIUS.map((particleRadius, index) => {
      const spray = makeDirectSpray(false);
      spray.channel = 10 + index;
      spray.particleRadius = particleRadius;
      spray.speed = 100;
      return spray;
    });
    renderer.update([], 0, standardizedSprays);
    state = renderer as unknown as SprayParticleDebugState;
    assertContract(
      state.particleCount === 8 &&
        Math.abs(state.pSize[5] - TETRAHEDRON_PARTICLE_RADIUS[0]) < 1e-6 &&
        Math.abs(state.pSize[6] - TETRAHEDRON_PARTICLE_RADIUS[1]) < 1e-6 &&
        Math.abs(state.pSize[7] - TETRAHEDRON_PARTICLE_RADIUS[2]) < 1e-6,
      'build spray must render only the exact shared small, medium, and large sizes',
    );
    assertContract(
      state.pLife[5] < state.pLife[6] && state.pLife[6] < state.pLife[7],
      'the shared movement profile must make small build chunks faster than medium and large chunks',
    );
  } finally {
    renderer.destroy();
  }
}
