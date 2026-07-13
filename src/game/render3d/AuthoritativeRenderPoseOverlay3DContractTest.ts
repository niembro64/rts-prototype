import type { AuthoritativeRenderSource } from '@/types/game';
import type { WorldState } from '../sim/WorldState';
import { LOCKSTEP_FIXED_DT_MS } from '../architecture/LockstepFrameScheduler';
import {
  createEmptyEntityComponentSlots,
  createTransform,
  type Entity,
} from '../sim/types';
import { AuthoritativeRenderPoseOverlay3D } from './AuthoritativeRenderPoseOverlay3D';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[authoritative render pose overlay contract] ${message}`);
  }
}

function assertNear(actual: number, expected: number, message: string, epsilon = 1e-6): void {
  assertContract(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
}

function makeUnit(id: number): Entity {
  const entity: Entity = {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'unit',
    transform: createTransform(0, 0, 0, 0),
  };
  entity.unit = {
    radius: { other: 10, hitbox: 10, collision: 10 },
    bodyCenterHeight: 6,
    surfaceNormal: { nx: 0, ny: 0, nz: 1 },
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    angularVelocity3: { x: 0, y: 0, z: 0 },
  } as Entity['unit'];
  return entity;
}

export function runAuthoritativeRenderPoseOverlay3DContractTest(): void {
  const clientUnit = makeUnit(501);
  const sourceUnit = makeUnit(501);
  let tick = 1;
  const source: AuthoritativeRenderSource = {
    kind: 'local-server',
    world: {
      getEntity: (id: number) => (id === sourceUnit.id ? sourceUnit : undefined),
    } as unknown as WorldState,
    getTick: () => tick,
  };
  const overlay = new AuthoritativeRenderPoseOverlay3D(() => source);

  let refreshCount = 0;
  const refresh = () => { refreshCount++; };

  sourceUnit.transform.x = 0;
  sourceUnit.transform.y = 0;
  sourceUnit.transform.z = 8;
  sourceUnit.transform.rotation = 0;
  sourceUnit.unit!.velocityX = 10;
  sourceUnit.unit!.velocityY = 20;
  sourceUnit.unit!.angularVelocity3 = { x: 0, y: 0, z: 2 };

  overlay.beginFrame(0);
  overlay.applyVisibleEntities([clientUnit], refresh);
  assertNear(clientUnit.transform.x, 0, 'first authoritative frame snaps position');
  assertNear(clientUnit.unit!.velocityX, 10, 'first authoritative frame snaps velocity');

  tick = 2;
  sourceUnit.transform.x = 30;
  sourceUnit.transform.y = 60;
  sourceUnit.transform.z = 14;
  sourceUnit.transform.rotation = Math.PI / 2;
  sourceUnit.unit!.velocityX = 100;
  sourceUnit.unit!.velocityY = 200;
  sourceUnit.unit!.angularVelocity3 = { x: 0, y: 0, z: 9 };

  overlay.beginFrame(0);
  overlay.applyVisibleEntities([clientUnit], refresh);
  assertNear(clientUnit.transform.x, 0, 'new tick starts at previous authoritative x');
  assertNear(clientUnit.transform.y, 0, 'new tick starts at previous authoritative y');
  assertNear(clientUnit.transform.z, 8, 'new tick starts at previous authoritative z');
  assertNear(clientUnit.transform.rotation, 0, 'new tick starts at previous authoritative rotation');
  assertNear(clientUnit.unit!.velocityX, 100, 'movement velocity snaps to current authoritative x velocity');
  assertNear(clientUnit.unit!.velocityY, 200, 'movement velocity snaps to current authoritative y velocity');
  assertNear(
    clientUnit.unit!.angularVelocity3?.z ?? Number.NaN,
    9,
    'rotation velocity snaps to current authoritative yaw rate',
  );

  overlay.beginFrame(LOCKSTEP_FIXED_DT_MS / 2);
  overlay.applyVisibleEntities([clientUnit], refresh);
  assertNear(clientUnit.transform.x, 15, 'same tick interpolates x at render half-frame');
  assertNear(clientUnit.transform.y, 30, 'same tick interpolates y at render half-frame');
  assertNear(clientUnit.transform.z, 11, 'same tick interpolates z at render half-frame');
  assertNear(clientUnit.transform.rotation, Math.PI / 4, 'same tick interpolates rotation at render half-frame');
  assertNear(clientUnit.unit!.velocityX, 100, 'interpolated frame still snaps movement velocity');
  assertNear(
    clientUnit.unit!.angularVelocity3?.z ?? Number.NaN,
    9,
    'interpolated frame still snaps rotation velocity',
  );
  assertContract(refreshCount === 3, 'each render application must refresh the render state');
}
