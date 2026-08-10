import * as THREE from 'three';
import { applyTurretAimPose3D } from './TurretAimPose3D';
import {
  TURRET_AIM_INPUT_STRIDE,
  UnitTurretAimBatch3D,
} from './UnitTurretAimBatch3D';
import {
  TURRET_HEAD_INPUT_STRIDE,
  UnitTurretHeadMatrixBatch3D,
  writeTurretHeadInput,
} from './UnitTurretHeadMatrixBatch3D';
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
    const yawGroup = new THREE.Group();
    const pitchGroup = new THREE.Group();
    root.add(yawGroup);
    yawGroup.add(pitchGroup);
    const parentQuaternion = parentWorldQuaternion(testCase);
    applyTurretAimPose3D(
      { yawGroup, pitchGroup },
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
        yawGroup.rotation.y,
        pitchGroup.rotation.z,
      ),
    );
    assertContract(
      root.rotation.y === 0,
      `immediate pose: ${testCase.name} leaves the fixed mount anchor unrotated`,
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

/** The sphere is symmetric, but its sensor-dome surface chart is not: the
 * black pitch slot must rotate with logical yaw. This checks the actual
 * instanced-head matrix path that previously emitted scale + translation and
 * silently discarded the body orientation. */
function checkInstancedTurretBodyYaw(): void {
  const batch = new UnitTurretHeadMatrixBatch3D();
  const input = batch.begin(AIM_CASES.length);
  const expectedQuaternions: THREE.Quaternion[] = [];
  const expectedCenters: THREE.Vector3[] = [];
  for (let i = 0; i < AIM_CASES.length; i++) {
    const testCase = AIM_CASES[i];
    const parentQuaternion = parentWorldQuaternion(testCase);
    const yawGroup = new THREE.Group();
    applyTurretAimPose3D(
      { yawGroup },
      testCase.hostRotation,
      testCase.aimRotation,
      testCase.aimPitch,
      parentQuaternion,
    );
    const parentPosition = new THREE.Vector3(13, 7, -4);
    const mountPosition = new THREE.Vector3(2.5, 3, -1.25);
    const radius = 4.5;
    writeTurretHeadInput(
      input,
      i * TURRET_HEAD_INPUT_STRIDE,
      parentPosition,
      parentQuaternion,
      mountPosition,
      radius,
      yawGroup.quaternion,
    );
    const expectedQuaternion = parentQuaternion.clone().multiply(yawGroup.quaternion);
    expectedQuaternions.push(expectedQuaternion);
    expectedCenters.push(
      mountPosition.clone()
        .applyQuaternion(parentQuaternion)
        .add(parentPosition)
        .add(new THREE.Vector3(0, radius, 0).applyQuaternion(expectedQuaternion)),
    );
  }

  const output = batch.compute(AIM_CASES.length);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const matrixAxis = new THREE.Vector3();
  const expectedAxis = new THREE.Vector3();
  for (let i = 0; i < AIM_CASES.length; i++) {
    const matrix = new THREE.Matrix4().fromArray(output, i * batch.outputStride);
    matrix.decompose(position, quaternion, scale);
    const elements = matrix.elements;
    matrixAxis.set(elements[0], elements[1], elements[2]).normalize();
    expectedAxis.set(1, 0, 0).applyQuaternion(expectedQuaternions[i]);
    const slotAxisAlignment = matrixAxis.dot(expectedAxis);
    assertContract(
      slotAxisAlignment > 1 - 2e-6,
      `instanced turret body ${AIM_CASES[i].name} turns its black slot with logical yaw `
        + `(alignment ${slotAxisAlignment})`,
    );
    matrixAxis.set(elements[4], elements[5], elements[6]).normalize();
    expectedAxis.set(0, 1, 0).applyQuaternion(expectedQuaternions[i]);
    assertContract(
      matrixAxis.dot(expectedAxis) > 1 - 2e-6,
      `instanced turret body ${AIM_CASES[i].name} preserves the slot's vertical axis`,
    );
    assertContract(
      position.distanceTo(expectedCenters[i]) < 2e-5,
      `instanced turret body ${AIM_CASES[i].name} keeps its authored mount center`,
    );
    assertContract(
      Math.abs(scale.x - 4.5) < 2e-6 &&
        Math.abs(scale.y - 4.5) < 2e-6 &&
        Math.abs(scale.z - 4.5) < 2e-6,
      `instanced turret body ${AIM_CASES[i].name} retains uniform head scale`,
    );
  }
}

export function runTurretAimPose3DContractTest(): void {
  checkImmediatePose();
  checkBatchedPose();
  checkInstancedTurretBodyYaw();
}
