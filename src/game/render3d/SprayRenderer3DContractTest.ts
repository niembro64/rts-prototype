import * as THREE from 'three';
import type { SprayTarget } from '@/types/ui';
import { getSprayTargetWireFlags } from '../network/sprayTargetWireHelpers';
import { serializeSprayTargets } from '../network/stateSerializerSpray';
import { SprayRenderer3D } from './SprayRenderer3D';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`SprayRenderer3D contract: ${message}`);
}

type SprayParticleDebugState = {
  particleCount: number;
  pStartX: Float32Array;
  pStartY: Float32Array;
  pStartZ: Float32Array;
  pEndX: Float32Array;
  pEndY: Float32Array;
  pEndZ: Float32Array;
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
  } finally {
    renderer.destroy();
  }
}
