import * as THREE from 'three';
import { applyTurretAimPose3D } from './TurretAimPose3D';
import {
  TURRET_AIM_INPUT_STRIDE,
  UnitTurretAimBatch3D,
} from './UnitTurretAimBatch3D';
import { writeTurretAimInput } from './turretAimInput';

const BARREL_AXIS = new THREE.Vector3(1, 0, 0);
const THREE_UP = new THREE.Vector3(0, 1, 0);

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[turret aim pose contract] ${message}`);
}

type AimCase = {
  readonly name: string;
  readonly hostRotation: number;
  readonly aimRotation: number;
  readonly aimPitch: number;
  readonly slopeAxis: THREE.Vector3;
  readonly slopeAngle: number;
  readonly visualBank: number;
};

const AIM_CASES: readonly AimCase[] = [
  {
    name: 'flat chassis',
    hostRotation: 0.8,
    aimRotation: -0.4,
    aimPitch: 0.2,
    slopeAxis: new THREE.Vector3(1, 0, 0),
    slopeAngle: 0,
    visualBank: 0,
  },
  {
    name: '30-degree cross-slope full orientation',
    hostRotation: 0.8,
    aimRotation: 0,
    aimPitch: -0.35,
    slopeAxis: new THREE.Vector3(0, 0, 1),
    slopeAngle: -Math.PI / 6,
    visualBank: 0,
  },
  {
    name: 'compound slope and elevated aim',
    hostRotation: -1.2,
    aimRotation: 2.1,
    aimPitch: 0.28,
    slopeAxis: new THREE.Vector3(1, 0, 1).normalize(),
    slopeAngle: Math.PI * 0.17,
    visualBank: 0,
  },
  {
    name: 'full orientation with presentation bank',
    hostRotation: 1.4,
    aimRotation: -2.3,
    aimPitch: -0.18,
    slopeAxis: new THREE.Vector3(1, 0, -0.4).normalize(),
    slopeAngle: Math.PI * 0.12,
    visualBank: 0.24,
  },
];

function parentWorldQuaternion(testCase: AimCase): THREE.Quaternion {
  const slope = new THREE.Quaternion().setFromAxisAngle(
    testCase.slopeAxis,
    testCase.slopeAngle,
  );
  const hostYaw = new THREE.Quaternion().setFromAxisAngle(
    THREE_UP,
    -testCase.hostRotation,
  );
  const visualBank = new THREE.Quaternion().setFromAxisAngle(
    BARREL_AXIS,
    -testCase.visualBank,
  );
  return slope.multiply(hostYaw).multiply(visualBank).normalize();
}

function authoritativeWorldDirection(testCase: AimCase): THREE.Vector3 {
  const cosPitch = Math.cos(testCase.aimPitch);
  return new THREE.Vector3(
    Math.cos(testCase.aimRotation) * cosPitch,
    Math.sin(testCase.aimPitch),
    Math.sin(testCase.aimRotation) * cosPitch,
  );
}

function renderedWorldDirection(
  parentQuaternion: THREE.Quaternion,
  rootYaw: number,
  barrelPitch: number,
): THREE.Vector3 {
  const rootYawQuaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0, rootYaw, 0),
  );
  const barrelPitchQuaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0, 0, barrelPitch),
  );
  const barrelWorldQuaternion = parentQuaternion.clone()
    .multiply(rootYawQuaternion)
    .multiply(barrelPitchQuaternion);
  return BARREL_AXIS.clone().applyQuaternion(barrelWorldQuaternion).normalize();
}

function assertDirectionAligned(
  testCase: AimCase,
  source: string,
  actual: THREE.Vector3,
): void {
  const expected = authoritativeWorldDirection(testCase);
  const angle = actual.angleTo(expected);
  assertContract(
    angle < 2e-6,
    `${source} ${testCase.name} misses authoritative aim by ${angle} radians`,
  );
}

function checkImmediatePose(): void {
  for (const testCase of AIM_CASES) {
    const root = new THREE.Group();
    const pitchGroup = new THREE.Group();
    const parentQuaternion = parentWorldQuaternion(testCase);
    applyTurretAimPose3D(
      { root, pitchGroup },
      testCase.hostRotation,
      testCase.aimRotation,
      testCase.aimPitch,
      parentQuaternion,
    );
    assertDirectionAligned(
      testCase,
      'immediate pose:',
      renderedWorldDirection(
        parentQuaternion,
        root.rotation.y,
        pitchGroup.rotation.z,
      ),
    );
  }
}

function checkBatchedPose(): void {
  const batch = new UnitTurretAimBatch3D();
  const input = batch.begin(AIM_CASES.length);
  for (let i = 0; i < AIM_CASES.length; i++) {
    const testCase = AIM_CASES[i];
    writeTurretAimInput(
      input,
      i * TURRET_AIM_INPUT_STRIDE,
      testCase.hostRotation,
      testCase.aimRotation,
      testCase.aimPitch,
      parentWorldQuaternion(testCase),
    );
  }
  const output = batch.compute(AIM_CASES.length);
  for (let i = 0; i < AIM_CASES.length; i++) {
    const testCase = AIM_CASES[i];
    const outputBase = i * batch.outputStride;
    assertDirectionAligned(
      testCase,
      'batched pose:',
      renderedWorldDirection(
        parentWorldQuaternion(testCase),
        output[outputBase],
        output[outputBase + 1],
      ),
    );
  }
}

export function runTurretAimPose3DContractTest(): void {
  checkImmediatePose();
  checkBatchedPose();
}
