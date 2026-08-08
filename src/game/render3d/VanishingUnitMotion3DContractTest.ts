import * as THREE from 'three';
import type { EntityMesh } from './EntityMesh3D';
import type { EntityDeathRenderablePart3D } from './EntityDeathDisassembly3D';
import { VanishingUnitMotion3D } from './VanishingUnitMotion3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[vanishing unit motion contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  assertContract(
    Math.abs(actual - expected) <= 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

export function runVanishingUnitMotion3DContractTest(): void {
  const group = new THREE.Group();
  group.position.set(12, 3, -7);
  const mesh = {
    group,
    chassis: new THREE.Group(),
    chassisMeshes: [],
    bodyShapeKey: '',
    turrets: [],
    geometryKey: 'vanishing-motion-contract',
  } as EntityMesh;

  const rendererPosition = new THREE.Vector3(12, 4, -7);
  const rendererPart: EntityDeathRenderablePart3D = {
    worldPosition: rendererPosition.clone(),
    applyDelta: (delta): void => {
      rendererPosition.x += delta.dx;
      rendererPosition.y += delta.dy;
      rendererPosition.z += delta.dz;
      assertContract(
        delta.drx === 0 && delta.dry === 0 && delta.drz === 0,
        'quiet vision loss must not add death-style tumble',
      );
    },
  };

  const motion = new VanishingUnitMotion3D();
  motion.prepare(mesh, { x: 10, y: 5, z: -4 }, [rendererPart]);
  motion.advance(mesh, 100);
  motion.advance(mesh, 400);

  assertNear(group.position.x, 17, 'the retained scene-graph root must coast at constant X speed');
  assertNear(group.position.y, 5.5, 'the retained scene-graph root must coast at constant Y speed');
  assertNear(group.position.z, -9, 'the retained scene-graph root must coast at constant Z speed');
  assertNear(rendererPosition.x, 17, 'world-parented instances must receive the same X travel');
  assertNear(rendererPosition.y, 6.5, 'world-parented instances must receive the same Y travel');
  assertNear(rendererPosition.z, -9, 'world-parented instances must receive the same Z travel');

  motion.forget(mesh);
  motion.advance(mesh, 500);
  assertNear(group.position.x, 17, 'teardown must stop retained visual motion');
  assertNear(rendererPosition.x, 17, 'teardown must stop renderer-owned instance motion');
}
