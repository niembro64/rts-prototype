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
import type { Locomotion3DMesh } from './Locomotion3D';
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
  }, rootPoint);
  assertEqual(rootPoint.x, 11, 'world-space attachments use the batched chassis root X');
  assertEqual(rootPoint.y, 22, 'world-space attachments use the batched chassis root Y');
  assertEqual(rootPoint.z, 33, 'world-space attachments use the batched chassis root Z');

  const groundPrintPacket = new GroundPrintRenderPacket3D();
  groundPrintPacket.pushRow(1, 10, 20, true, WATER_LEVEL - 0.01);
  groundPrintPacket.pushRow(2, 30, 40, true, WATER_LEVEL);
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
  const submergedPacket = new GroundPrintRenderPacket3D();
  submergedPacket.pushRow(3, 0, 0, true, WATER_LEVEL - 10);
  const treadContact = {
    localX: 0,
    localZ: 0,
    worldX: 0,
    worldZ: 0,
    initialized: true,
    phase: 0,
  };
  const tank = {
    type: 'tank',
    treadContacts: [treadContact],
    printWidth: 2,
  } as unknown as Locomotion3DMesh;
  const previousMarksEnabled = getLocomotionMarks();
  try {
    setLocomotionMarks(true);
    renderer.update(submergedPacket, () => tank, 16);
    treadContact.worldX = 8;
    renderer.update(submergedPacket, () => tank, 16);
    if (
      sampledModes.length === 0 ||
      sampledModes.some((terrainMode) => terrainMode !== 'terrainBed')
    ) {
      throw new Error(
        '[rolling locomotion contract] submerged tread geometry sampled the visible water plane',
      );
    }
  } finally {
    setLocomotionMarks(previousMarksEnabled);
    renderer.destroy();
  }
}
