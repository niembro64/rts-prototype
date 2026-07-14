import { SHOT_BLUEPRINTS } from '../sim/blueprints/shots';
import type { Entity } from '../sim/types';
import { createServerTarget } from './ClientPredictionTargets';
import {
  applyClientProjectileMotionBatch,
  type ClientProjectileMotionItem,
  type ClientProjectileMotionResult,
} from './ClientProjectileMotion';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[client projectile motion contract] ${message}`);
}

function createShotEntity(shot: unknown): Entity {
  return {
    transform: { x: 0, y: 0, z: 0, rotation: 0 },
    projectile: {
      projectileType: 'projectile',
      config: { shot },
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      angularVelocity: 0,
      timeAlive: 123,
      homingTargetId: 456,
    },
  } as unknown as Entity;
}

function runFourChannelCase(label: string, entity: Entity): void {
  const target = createServerTarget();
  target.x = 10;
  target.y = 20;
  target.z = 30;
  target.velocityX = 4;
  target.velocityY = 6;
  target.velocityZ = 8;
  target.rotation = Math.PI / 2;
  target.angularVelocityZ = 2;
  const items: ClientProjectileMotionItem[] = [{ entity, target }];
  const results: ClientProjectileMotionResult[] = [];

  applyClientProjectileMotionBatch({
    items,
    movPosBlend: 0.5,
    movVelBlend: 0.5,
    rotPosBlend: 0.5,
    rotVelBlend: 0.5,
    out: results,
  });

  const projectile = entity.projectile!;
  assertContract(entity.transform.x === 5 && entity.transform.y === 10 && entity.transform.z === 15, `${label} uses MOV POS`);
  assertContract(projectile.velocityX === 2 && projectile.velocityY === 3 && projectile.velocityZ === 4, `${label} uses MOV VEL`);
  assertContract(Math.abs(entity.transform.rotation - Math.PI / 4) < 1e-12, `${label} uses ROT POS`);
  assertContract(projectile.angularVelocity === 1, `${label} uses ROT VEL`);
  assertContract(projectile.timeAlive === 123, `${label} does not advance lifetime`);
  assertContract(projectile.homingTargetId === 456, `${label} does not run homing`);
  assertContract(entity.projectile === projectile, `${label} is not locally deleted`);
}

export function runClientProjectileMotionContractTest(): void {
  for (const [shotBlueprintId, shot] of Object.entries(SHOT_BLUEPRINTS)) {
    runFourChannelCase(shotBlueprintId, createShotEntity(shot));
  }
  runFourChannelCase('D-gun presentation', createShotEntity(SHOT_BLUEPRINTS.shotPlasmaHeavy));

  const target = createServerTarget();
  target.x = 10;
  target.velocityX = 4;
  target.rotation = Math.PI / 2;
  target.angularVelocityZ = 2;
  const blends = [
    { key: 'MOV POS', values: [1, -1, -1, -1], expected: [10, 0, 0, 0] },
    { key: 'MOV VEL', values: [-1, 1, -1, -1], expected: [0, 4, 0, 0] },
    { key: 'ROT POS', values: [-1, -1, 1, -1], expected: [0, 0, Math.PI / 2, 0] },
    { key: 'ROT VEL', values: [-1, -1, -1, 1], expected: [0, 0, 0, 2] },
  ] as const;
  for (const { key, values, expected } of blends) {
    const entity = createShotEntity(SHOT_BLUEPRINTS.shotRocketLight);
    applyClientProjectileMotionBatch({
      items: [{ entity, target }],
      movPosBlend: values[0],
      movVelBlend: values[1],
      rotPosBlend: values[2],
      rotVelBlend: values[3],
      out: [],
    });
    assertContract(entity.transform.x === expected[0], `${key} alone owns projectile position`);
    assertContract(entity.projectile!.velocityX === expected[1], `${key} alone owns projectile velocity`);
    assertContract(entity.transform.rotation === expected[2], `${key} alone owns projectile rotation`);
    assertContract(entity.projectile!.angularVelocity === expected[3], `${key} alone owns projectile angular velocity`);
  }
}
