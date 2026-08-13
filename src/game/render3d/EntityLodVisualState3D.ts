import type * as THREE from 'three';
import type { ResourcePylonRig } from './ResourcePylonMesh3D';
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

/** Presentation-only state transferred when an entity changes geometry tier. */
export type EntityLodVisualState3D = Readonly<{
  visualBankRoll?: number;
  solarOpenAmount?: number;
  pylonStates: PylonState[];
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

function pylons(mesh: EntityMesh): ResourcePylonRig[] {
  const rigs: ResourcePylonRig[] = [];
  if (mesh.solarRig) rigs.push(mesh.solarRig.pylon);
  if (mesh.windRig) rigs.push(mesh.windRig.pylon);
  if (mesh.extractorRig) rigs.push(mesh.extractorRig.pylon);
  if (mesh.converterRig) {
    rigs.push(mesh.converterRig.energyPylon, mesh.converterRig.metalPylon);
  }
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

export function captureEntityLodVisualState3D(mesh: EntityMesh): EntityLodVisualState3D {
  return {
    visualBankRoll: mesh.visualBankRoll,
    solarOpenAmount: mesh.solarOpenAmount,
    pylonStates: pylons(mesh).map(capturePylonState),
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

  const nextPylons = pylons(mesh);
  for (let i = 0; i < nextPylons.length; i++) {
    applyPylonState(nextPylons[i], state.pylonStates[i]);
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
