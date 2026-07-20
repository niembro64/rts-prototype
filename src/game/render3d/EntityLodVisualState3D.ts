import type * as THREE from 'three';
import type { ConstructionEmitterRig, ResourcePylonRig } from './ConstructionEmitterMesh3D';
import type { EntityMesh } from './EntityMesh3D';
import { applySolarCollectorPetalPose } from './SolarCollectorMesh3D';

type Vec3State = readonly [number, number, number];
type TransformState = Readonly<{
  position: Vec3State;
  quaternion: readonly [number, number, number, number];
  scale: Vec3State;
  matrix: readonly number[];
  matrixAutoUpdate: boolean;
  visible: boolean;
}>;

type PylonState = Readonly<{
  direction: ResourcePylonRig['direction'];
  rootLocal: Vec3State;
  topLocal: Vec3State;
  smoothedRate: number;
  displaySmoothedRate: number;
}>;

type ConstructionEmitterState = Readonly<{
  smoothedRates: Readonly<{ energy: number; metal: number }>;
  displaySmoothedRates: Readonly<{ energy: number; metal: number }>;
  lastPaidTargetId: number | null;
  lastPaid: Readonly<{ energy: number; metal: number }>;
  towerSpinAmount: number;
  displayTowerSpinAmount: number;
  towerSpinPhase: number;
  orbitParts: TransformState[];
}>;

/** Presentation-only state transferred when an entity changes geometry tier. */
export type EntityLodVisualState3D = Readonly<{
  visualBankRoll?: number;
  solarOpenAmount?: number;
  pylonStates: PylonState[];
  constructionEmitterStates: ConstructionEmitterState[];
  buildingDetailTransforms: TransformState[][];
}>;

function vec3State(value: THREE.Vector3): Vec3State {
  return [value.x, value.y, value.z];
}

function applyVec3(value: THREE.Vector3, state: Vec3State): void {
  value.set(state[0], state[1], state[2]);
}

function captureTransform(object: THREE.Object3D): TransformState {
  return {
    position: vec3State(object.position),
    quaternion: [
      object.quaternion.x,
      object.quaternion.y,
      object.quaternion.z,
      object.quaternion.w,
    ],
    scale: vec3State(object.scale),
    matrix: object.matrix.toArray(),
    matrixAutoUpdate: object.matrixAutoUpdate,
    visible: object.visible,
  };
}

function applyTransform(object: THREE.Object3D, state: TransformState): void {
  applyVec3(object.position, state.position);
  object.quaternion.set(
    state.quaternion[0],
    state.quaternion[1],
    state.quaternion[2],
    state.quaternion[3],
  );
  applyVec3(object.scale, state.scale);
  object.matrixAutoUpdate = state.matrixAutoUpdate;
  object.matrix.fromArray(state.matrix);
  object.visible = state.visible;
}

function captureSubtree(root: THREE.Object3D): TransformState[] {
  const states: TransformState[] = [];
  root.traverse((object) => states.push(captureTransform(object)));
  return states;
}

function applySubtree(root: THREE.Object3D, states: readonly TransformState[]): void {
  let index = 0;
  root.traverse((object) => {
    const state = states[index++];
    if (state !== undefined) applyTransform(object, state);
  });
}

function constructionEmitters(mesh: EntityMesh): ConstructionEmitterRig[] {
  const rigs: ConstructionEmitterRig[] = [];
  for (const turret of mesh.turrets) {
    if (turret.constructionEmitter) rigs.push(turret.constructionEmitter);
  }
  return rigs;
}

function pylons(mesh: EntityMesh, emitters: readonly ConstructionEmitterRig[]): ResourcePylonRig[] {
  const rigs: ResourcePylonRig[] = [];
  if (mesh.solarRig) rigs.push(mesh.solarRig.pylon);
  if (mesh.windRig) rigs.push(mesh.windRig.pylon);
  if (mesh.extractorRig) rigs.push(mesh.extractorRig.pylon);
  if (mesh.converterRig) {
    rigs.push(mesh.converterRig.energyPylon, mesh.converterRig.metalPylon);
  }
  for (const emitter of emitters) rigs.push(...emitter.pylons);
  return rigs;
}

function capturePylonState(pylon: ResourcePylonRig): PylonState {
  return {
    direction: pylon.direction,
    rootLocal: vec3State(pylon.rootLocal),
    topLocal: vec3State(pylon.topLocal),
    smoothedRate: pylon.smoothedRate,
    displaySmoothedRate: pylon.displaySmoothedRate,
  };
}

function applyPylonState(pylon: ResourcePylonRig, state: PylonState | undefined): void {
  if (state === undefined) return;
  pylon.direction = state.direction;
  applyVec3(pylon.rootLocal, state.rootLocal);
  applyVec3(pylon.topLocal, state.topLocal);
  pylon.smoothedRate = state.smoothedRate;
  pylon.displaySmoothedRate = state.displaySmoothedRate;
}

function captureEmitterState(rig: ConstructionEmitterRig): ConstructionEmitterState {
  return {
    smoothedRates: { ...rig.smoothedRates },
    displaySmoothedRates: { ...rig.displaySmoothedRates },
    lastPaidTargetId: rig.lastPaidTargetId,
    lastPaid: { ...rig.lastPaid },
    towerSpinAmount: rig.towerSpinAmount,
    displayTowerSpinAmount: rig.displayTowerSpinAmount,
    towerSpinPhase: rig.towerSpinPhase,
    orbitParts: rig.towerOrbitParts.map((part) => captureTransform(part.mesh)),
  };
}

function applyEmitterState(
  rig: ConstructionEmitterRig,
  state: ConstructionEmitterState | undefined,
): void {
  if (state === undefined) return;
  rig.smoothedRates.energy = state.smoothedRates.energy;
  rig.smoothedRates.metal = state.smoothedRates.metal;
  rig.displaySmoothedRates.energy = state.displaySmoothedRates.energy;
  rig.displaySmoothedRates.metal = state.displaySmoothedRates.metal;
  rig.lastPaidTargetId = state.lastPaidTargetId;
  rig.lastPaid.energy = state.lastPaid.energy;
  rig.lastPaid.metal = state.lastPaid.metal;
  rig.towerSpinAmount = state.towerSpinAmount;
  rig.displayTowerSpinAmount = state.displayTowerSpinAmount;
  rig.towerSpinPhase = state.towerSpinPhase;
  for (let i = 0; i < rig.towerOrbitParts.length; i++) {
    const saved = state.orbitParts[i];
    if (saved) applyTransform(rig.towerOrbitParts[i].mesh, saved);
  }
}

export function captureEntityLodVisualState3D(mesh: EntityMesh): EntityLodVisualState3D {
  const emitters = constructionEmitters(mesh);
  return {
    visualBankRoll: mesh.visualBankRoll,
    solarOpenAmount: mesh.solarOpenAmount,
    pylonStates: pylons(mesh, emitters).map(capturePylonState),
    constructionEmitterStates: emitters.map(captureEmitterState),
    buildingDetailTransforms: mesh.buildingDetails?.map((detail) =>
      captureSubtree(detail.mesh)) ?? [],
  };
}

export function applyEntityLodVisualState3D(
  mesh: EntityMesh,
  state: EntityLodVisualState3D | undefined,
): void {
  if (state === undefined) return;
  mesh.visualBankRoll = state.visualBankRoll;
  mesh.solarOpenAmount = state.solarOpenAmount;
  mesh.solarPetalPoseAmount = undefined;

  const emitters = constructionEmitters(mesh);
  const nextPylons = pylons(mesh, emitters);
  for (let i = 0; i < nextPylons.length; i++) {
    applyPylonState(nextPylons[i], state.pylonStates[i]);
  }
  for (let i = 0; i < emitters.length; i++) {
    applyEmitterState(emitters[i], state.constructionEmitterStates[i]);
  }
  if (mesh.buildingDetails) {
    for (let i = 0; i < mesh.buildingDetails.length; i++) {
      const transforms = state.buildingDetailTransforms[i];
      if (transforms) applySubtree(mesh.buildingDetails[i].mesh, transforms);
    }
    // Building detail lists legitimately differ by LOD rung. Solar leaves
    // must never inherit a positional transform from a different detail role;
    // derive all four leaf/panel transforms from the retained semantic pose.
    if (
      mesh.solarOpenAmount !== undefined &&
      applySolarCollectorPetalPose(mesh.buildingDetails, mesh.solarOpenAmount)
    ) {
      mesh.solarPetalPoseAmount = mesh.solarOpenAmount;
    }
  }
}
