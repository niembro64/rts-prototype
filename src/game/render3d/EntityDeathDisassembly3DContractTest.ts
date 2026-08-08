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

type CapturedPartDelta = {
  dx: number;
  dy: number;
  dz: number;
  drx: number;
  dry: number;
  drz: number;
};

function captureLaunchDistribution(seed: number): CapturedPartDelta[] {
  const group = new THREE.Group();
  const chassis = new THREE.Group();
  group.add(chassis);
  const deltas: CapturedPartDelta[] = [];
  const rendererParts: EntityDeathRenderablePart3D[] = [];
  const partCount = 96;
  for (let i = 0; i < partCount; i++) {
    const angle = i / partCount * Math.PI * 2;
    rendererParts.push({
      worldPosition: new THREE.Vector3(Math.cos(angle) * 10, 0, Math.sin(angle) * 10),
      applyDelta: (delta): void => {
        deltas[i] = { ...delta };
      },
    });
  }
  const entityMesh = {
    group,
    chassis,
    chassisMeshes: [],
    bodyShapeKey: '',
    turrets: [],
    geometryKey: 'death-distribution-contract',
  } as EntityMesh;
  const disassembly = new EntityDeathDisassembly3D();
  disassembly.prepare(entityMesh, {
    seed,
    pushX: 200,
    pushZ: 0,
    inheritedX: 0,
    inheritedZ: 0,
  }, rendererParts);
  disassembly.advance(entityMesh, 16);
  return deltas;
}

export function runEntityDeathDisassembly3DContractTest(): void {
  const blast = entityDeathBlastFromContext3D({
    unitVel: { x: 10, y: -4 },
    hitDir: { x: 1, y: 0 },
    projectileVel: { x: 20, y: 5 },
    attackMagnitude: 50,
    radius: 10,
    color: 0xffffff,
  }, 91);
  assertContract(
    blast.seed === 91 && blast.pushX === 106 && blast.pushZ === 1.5 &&
      blast.inheritedX === 5 && blast.inheritedZ === -2,
    'death motion must retain its event seed and derive from attack direction/magnitude, projectile velocity, and inherited victim velocity',
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
  Math.random = () => 0;
  try {
    const disassembly = new EntityDeathDisassembly3D();
    const partCount = disassembly.prepare(entityMesh, {
      seed: 0x51ac73d2,
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
      rendererMoves.length === rendererParts.length && rendererMoves.every((dx) => Number.isFinite(dx)),
      'renderer-owned parts must receive finite independent motion',
    );
    assertContract(
      meshes.every((mesh) => mesh.material === material),
      'death disassembly must reuse each part and its real material rather than swapping in debris',
    );
    disassembly.forget(entityMesh);

    const firstDistribution = captureLaunchDistribution(0x51ac73d2);
    Math.random = () => 0.999999;
    const repeatedDistribution = captureLaunchDistribution(0x51ac73d2);
    assertContract(
      firstDistribution.length === 96 && repeatedDistribution.length === 96 &&
        firstDistribution.every((delta, index) => (
          delta.dx === repeatedDistribution[index].dx &&
          delta.dy === repeatedDistribution[index].dy &&
          delta.dz === repeatedDistribution[index].dz &&
          delta.drx === repeatedDistribution[index].drx &&
          delta.dry === repeatedDistribution[index].dry &&
          delta.drz === repeatedDistribution[index].drz
        )),
      'piece launch randomness must be seeded by the death event rather than ambient Math.random call order',
    );

    const leftwardCount = firstDistribution.filter((delta) => delta.dx < 0).length;
    const rightwardCount = firstDistribution.filter((delta) => delta.dx > 0).length;
    const averageDx = firstDistribution.reduce((sum, delta) => sum + delta.dx, 0) /
      firstDistribution.length;
    assertContract(
      leftwardCount >= 24 && rightwardCount >= 40,
      'a strong +X killing force must still produce a broad two-sided random breakup',
    );
    assertContract(
      averageDx > 0,
      'the randomized breakup must retain a smaller readable bias from the killing force',
    );
    const horizontalDistances = firstDistribution.map((delta) => Math.hypot(delta.dx, delta.dz));
    const spinDistances = firstDistribution.map((delta) => Math.hypot(delta.drx, delta.dry, delta.drz));
    assertContract(
      Math.max(...horizontalDistances) > Math.min(...horizontalDistances) * 2,
      'piece launch magnitudes must vary independently',
    );
    assertContract(
      Math.max(...spinDistances) > Math.min(...spinDistances) * 2,
      'piece tumble magnitudes must vary independently',
    );
  } finally {
    Math.random = originalRandom;
    geometry.dispose();
    material.dispose();
    (invisiblePivot.material as THREE.Material).dispose();
  }
}
