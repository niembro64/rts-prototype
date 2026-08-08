import * as THREE from 'three';
import type { EntityMesh } from './EntityMesh3D';
import {
  EntityDeathDisassembly3D,
  entityDeathBlastFromContext3D,
  type EntityDeathRenderablePart3D,
} from './EntityDeathDisassembly3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[entity death disassembly contract] ${message}`);
}

export function runEntityDeathDisassembly3DContractTest(): void {
  const blast = entityDeathBlastFromContext3D({
    unitVel: { x: 10, y: -4 },
    hitDir: { x: 1, y: 0 },
    projectileVel: { x: 20, y: 5 },
    attackMagnitude: 50,
    radius: 10,
    color: 0xffffff,
  });
  assertContract(
    blast.pushX === 106 && blast.pushZ === 1.5 &&
      blast.inheritedX === 5 && blast.inheritedZ === -2,
    'death motion must derive from attack direction/magnitude, projectile velocity, and inherited victim velocity',
  );

  const group = new THREE.Group();
  group.position.set(12, 3, -7);
  group.rotation.y = 0.4;
  const chassis = new THREE.Group();
  group.add(chassis);
  const material = new THREE.MeshLambertMaterial();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const meshes = [
    new THREE.Mesh(geometry, material),
    new THREE.Mesh(geometry, material),
    new THREE.Mesh(geometry, material),
  ];
  meshes[0].position.set(-2, 1, 0);
  meshes[1].position.set(0, 2, 0);
  meshes[2].position.set(2, 1, 0);
  chassis.add(...meshes);
  const invisiblePivot = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  chassis.add(invisiblePivot);

  const rendererMoves: number[] = [];
  const rendererParts: EntityDeathRenderablePart3D[] = [0, 1].map((index) => ({
    worldPosition: new THREE.Vector3(12 + index, 4, -7),
    applyDelta: (delta): void => { rendererMoves[index] = delta.dx; },
  }));
  const entityMesh = {
    group,
    chassis,
    chassisMeshes: meshes,
    bodyShapeKey: '',
    turrets: [],
    geometryKey: 'contract',
  } as EntityMesh;

  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const disassembly = new EntityDeathDisassembly3D();
    const partCount = disassembly.prepare(entityMesh, {
      pushX: 200,
      pushZ: 0,
      inheritedX: 0,
      inheritedZ: 0,
    }, rendererParts);
    assertContract(
      partCount === meshes.length + rendererParts.length,
      'every visible Mesh and renderer-owned instance must become exactly one death part',
    );
    assertContract(
      meshes.every((mesh) => mesh.parent === group),
      'authored parts must detach from animation rigs while preserving the entity-owned root',
    );
    assertContract(
      invisiblePivot.parent === chassis,
      'invisible rig pivots must not become phantom explosion pieces',
    );

    const before = meshes.map((mesh) => mesh.position.clone());
    disassembly.advance(entityMesh, 16);
    assertContract(
      meshes.every((mesh, index) => !mesh.position.equals(before[index])),
      'every captured visible part must move independently during the death fade',
    );
    assertContract(
      rendererMoves.length === rendererParts.length && rendererMoves.every((dx) => dx > 0),
      'renderer-owned parts must move with the killing-blast bias',
    );
    assertContract(
      meshes.every((mesh) => mesh.material === material),
      'death disassembly must reuse each part and its real material rather than swapping in debris',
    );
    disassembly.forget(entityMesh);
  } finally {
    Math.random = originalRandom;
    geometry.dispose();
    material.dispose();
    (invisiblePivot.material as THREE.Material).dispose();
  }
}
