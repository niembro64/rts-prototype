import * as THREE from 'three';
import {
  rollingContact,
  rollingWheelAngularVelocity,
  sampleRollingContactPosition,
  transformChassisRootToWorld,
} from './LocomotionRigShared3D';
import {
  GroundPrint3D,
  GroundPrintRenderPacket3D,
} from './GroundPrint3D';
import { WATER_LEVEL } from '../sim/Terrain';
import type { Entity } from '../sim/types';
import type { Locomotion3DMesh } from './Locomotion3D';
import { resolveGroundPrintLayout } from './GroundPrintLayout3D';
import {
  getLocomotionMarks,
  setLocomotionMarks,
} from '@/clientBarConfig';

function assertEqual(actual: number, expected: number, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `[rolling locomotion contract] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-5) {
    throw new Error(
      `[rolling locomotion contract] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

function groundPrintGeometry(world: THREE.Group): THREE.BufferGeometry {
  const root = world.children[0] as THREE.Group | undefined;
  const mesh = root?.children[0] as THREE.Mesh | undefined;
  if (!(mesh?.geometry instanceof THREE.BufferGeometry)) {
    throw new Error('[rolling locomotion contract] ground-print mesh was not created');
  }
  return mesh.geometry;
}

function groundPrintMarkCount(geometry: THREE.BufferGeometry): number {
  return geometry.drawRange.count / 6;
}

function assertTrailEdgeCenter(
  positions: Float32Array,
  slot: number,
  edge: 'start' | 'end',
  expectedX: number,
  expectedZ: number,
  message: string,
): void {
  const base = slot * 12 + (edge === 'start' ? 0 : 6);
  const opposite = base + 3;
  assertNear(
    (positions[base] + positions[opposite]) * 0.5,
    expectedX,
    `${message} X`,
  );
  assertNear(
    (positions[base + 2] + positions[opposite + 2]) * 0.5,
    expectedZ,
    `${message} Z`,
  );
}

export function runRollingLocomotionContractTest(): void {
  assertEqual(
    rollingWheelAngularVelocity(12, 3),
    -4,
    'forward chassis travel rotates the contact surface rearward',
  );
  assertEqual(
    rollingWheelAngularVelocity(-12, 3),
    4,
    'reverse chassis travel reverses wheel rotation',
  );
  assertEqual(
    rollingWheelAngularVelocity(12, 0),
    -12,
    'invalid tiny radii retain the shared one-world-unit safety floor',
  );

  const contact = rollingContact(2, 3);
  contact.phase = 17;
  sampleRollingContactPosition({
    baseX: 10,
    baseY: 20,
    baseZ: 30,
    rootX: 10,
    rootY: 25,
    rootZ: 30,
    quaternionX: 0,
    quaternionY: 0,
    quaternionZ: 0,
    quaternionW: 1,
    velocityX: 4,
    velocityY: 0,
    velocityZ: 0,
    yawRate: 0,
    waterFraction: 0,
    maxContinuousDistance: 100,
  carried: false,
  }, contact);
  assertEqual(contact.worldX, 12, 'static Low contact still tracks world X');
  assertEqual(contact.worldZ, 33, 'static Low contact still tracks world Z');
  assertEqual(contact.phase, 17, 'static Low contact does not integrate rolling phase');

  const rootPoint = { x: 0, y: 0, z: 0 };
  transformChassisRootToWorld(0, 0, 0, {
    baseX: -100,
    baseY: -200,
    baseZ: -300,
    rootX: 11,
    rootY: 22,
    rootZ: 33,
    quaternionX: Math.SQRT1_2,
    quaternionY: 0,
    quaternionZ: 0,
    quaternionW: Math.SQRT1_2,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    yawRate: 0,
    waterFraction: 0,
    maxContinuousDistance: 100,
  carried: false,
  }, rootPoint);
  assertEqual(rootPoint.x, 11, 'world-space attachments use the batched chassis root X');
  assertEqual(rootPoint.y, 22, 'world-space attachments use the batched chassis root Y');
  assertEqual(rootPoint.z, 33, 'world-space attachments use the batched chassis root Z');

  const groundPrintPacket = new GroundPrintRenderPacket3D();
  groundPrintPacket.pushRow(1, 10, 20, 0, true, WATER_LEVEL - 0.01);
  groundPrintPacket.pushRow(2, 30, 40, 0, true, WATER_LEVEL);
  if (groundPrintPacket.terrainModeAt(0) !== 'terrainBed') {
    throw new Error(
      '[rolling locomotion contract] submerged tread and wheel marks must drape over the terrain bed',
    );
  }
  if (groundPrintPacket.terrainModeAt(1) !== 'visibleSurface') {
    throw new Error(
      '[rolling locomotion contract] water-surface contacts must retain the visible support surface',
    );
  }

  const sampledModes: string[] = [];
  const world = new THREE.Group();
  const renderer = new GroundPrint3D(
    world,
    undefined,
    (_x, _z, terrainMode) => {
      sampledModes.push(terrainMode);
      return terrainMode === 'terrainBed' ? WATER_LEVEL - 80 : WATER_LEVEL;
    },
  );
  // Marks are placed from the unit's pose and blueprint layout, never from a
  // rig: a tread unit with no locomotion mesh at all (the proxy rung) must
  // still rut the bed it rolls over.
  const submergedTank = {
    unit: { unitBlueprintId: 'unitLynx', radius: { other: 12 } },
    transform: { x: 0, y: 0, z: WATER_LEVEL - 10, rotation: 0 },
  } as unknown as Entity;
  const getEntity = () => submergedTank;
  const noRig = () => undefined as Locomotion3DMesh;
  const submergedPacket = new GroundPrintRenderPacket3D();
  submergedPacket.pushRow(3, 0, 0, 0, true, WATER_LEVEL - 10);
  const nearPacket = new GroundPrintRenderPacket3D();
  nearPacket.pushRow(3, 1, 0, 0, true, WATER_LEVEL - 10);
  const movedPacket = new GroundPrintRenderPacket3D();
  movedPacket.pushRow(3, 8, 0, 0, true, WATER_LEVEL - 10);
  const wheelWorld = new THREE.Group();
  const wheelRenderer = new GroundPrint3D(wheelWorld, undefined, () => WATER_LEVEL);
  const jackal = {
    unit: { unitBlueprintId: 'unitJackal', radius: { other: 8 } },
    transform: { x: 0, y: 0, z: WATER_LEVEL, rotation: 0 },
  } as unknown as Entity;
  const wheelLayout = resolveGroundPrintLayout(jackal);
  if (wheelLayout === null || wheelLayout.trails.length === 0) {
    throw new Error('[rolling locomotion contract] Jackal must resolve wheel trail contacts');
  }
  const treadLayout = resolveGroundPrintLayout(submergedTank);
  if (treadLayout === null || treadLayout.trails.length === 0) {
    throw new Error('[rolling locomotion contract] Lynx must resolve tread trail contacts');
  }
  const wheelPackets = [0, 1, 2, 4, 5].map((x) => {
    const packet = new GroundPrintRenderPacket3D();
    packet.pushRow(4, x, 0, 0, true, WATER_LEVEL);
    return packet;
  });
  const previousMarksEnabled = getLocomotionMarks();
  try {
    setLocomotionMarks(true);
    renderer.update(submergedPacket, noRig, getEntity, 16, 1);
    renderer.update(nearPacket, noRig, getEntity, 16, 1);
    // A tread side keeps the same sticky leading quad a tire does: a
    // sub-spacing move allocates exactly one live mark per belt and drags
    // its end edge to the live contact, so a narrow belt never trails a
    // dashed gap behind the unit.
    const treadGeometry = groundPrintGeometry(world);
    const treadContactCount = treadLayout.trails.length;
    assertEqual(
      groundPrintMarkCount(treadGeometry),
      treadContactCount,
      'sub-spacing tread motion allocates exactly one live mark per belt',
    );
    const treadPositions = treadGeometry.getAttribute('position').array as Float32Array;
    for (let i = 0; i < treadContactCount; i++) {
      const contact = treadLayout.trails[i];
      assertTrailEdgeCenter(
        treadPositions,
        i,
        'end',
        1 + contact.localX,
        contact.localZ,
        'live tread mark stays attached after a sub-spacing move',
      );
    }
    renderer.update(movedPacket, noRig, getEntity, 16, 1);
    assertEqual(
      groundPrintMarkCount(treadGeometry),
      treadContactCount,
      'reaching spacing promotes the live tread mark in place',
    );
    if (
      sampledModes.length === 0 ||
      sampledModes.some((terrainMode) => terrainMode !== 'terrainBed')
    ) {
      throw new Error(
        '[rolling locomotion contract] submerged tread geometry sampled the visible water plane',
      );
    }

    const getJackal = () => jackal;
    wheelRenderer.update(wheelPackets[0], noRig, getJackal, 16, 1);
    const wheelGeometry = groundPrintGeometry(wheelWorld);
    wheelRenderer.update(wheelPackets[1], noRig, getJackal, 16, 1);
    const contactCount = wheelLayout.trails.length;
    assertEqual(
      groundPrintMarkCount(wheelGeometry),
      contactCount,
      'sub-spacing wheel motion allocates exactly one live mark per tire',
    );
    const positions = wheelGeometry.getAttribute('position').array as Float32Array;
    for (let i = 0; i < contactCount; i++) {
      const contact = wheelLayout.trails[i];
      assertTrailEdgeCenter(
        positions,
        i,
        'end',
        1 + contact.localX,
        contact.localZ,
        'live wheel mark stays attached after first sub-spacing move',
      );
    }

    wheelRenderer.update(wheelPackets[2], noRig, getJackal, 16, 1);
    assertEqual(
      groundPrintMarkCount(wheelGeometry),
      contactCount,
      'wheel leading marks are rewritten without per-frame allocation',
    );
    for (let i = 0; i < contactCount; i++) {
      const contact = wheelLayout.trails[i];
      assertTrailEdgeCenter(
        positions,
        i,
        'end',
        2 + contact.localX,
        contact.localZ,
        'rewritten wheel mark follows the current tire contact',
      );
    }

    wheelRenderer.update(wheelPackets[3], noRig, getJackal, 16, 1);
    assertEqual(
      groundPrintMarkCount(wheelGeometry),
      contactCount,
      'reaching spacing promotes the live wheel mark in place',
    );
    wheelRenderer.update(wheelPackets[4], noRig, getJackal, 16, 1);
    assertEqual(
      groundPrintMarkCount(wheelGeometry),
      contactCount * 2,
      'motion after promotion allocates one new leading mark per tire',
    );
    for (let i = 0; i < contactCount; i++) {
      const contact = wheelLayout.trails[i];
      assertTrailEdgeCenter(
        positions,
        i,
        'end',
        4 + contact.localX,
        contact.localZ,
        'committed wheel mark ends at its release point',
      );
      assertTrailEdgeCenter(
        positions,
        contactCount + i,
        'start',
        4 + contact.localX,
        contact.localZ,
        'new wheel mark begins at the previous release point',
      );
      assertTrailEdgeCenter(
        positions,
        contactCount + i,
        'end',
        5 + contact.localX,
        contact.localZ,
        'new wheel mark remains attached to the live tire',
      );
    }
  } finally {
    setLocomotionMarks(previousMarksEnabled);
    renderer.destroy();
    wheelRenderer.destroy();
  }
}
