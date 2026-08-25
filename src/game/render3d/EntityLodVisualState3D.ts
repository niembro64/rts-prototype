import type * as THREE from 'three';
import type { ResourcePylonRig } from './ResourcePylonMesh3D';
import type { EntityMesh } from './EntityMesh3D';
import { applySolarCollectorPetalPose } from './SolarCollectorMesh3D';
import { applyBuildingOperationalPose } from './BuildingOperationalRig3D';

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
  /** Transport ring expansion is event-driven presentation state: changing
   *  geometry tier must not replay the grab/release size transition. */
  carryScale?: number;
  solarOpenAmount?: number;
  buildingOperationalAmount?: number;
  buildingOperationalMotionTime?: number;
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

/** The fabricator construction ring is regenerated from the current tick and
 * production state as soon as a rebuilt mesh is registered with its animator.
 * Its child list intentionally differs by geometry tier (the far tier omits
 * the top latch), so copying those children by detail-array index can hand the
 * outer ring's hundred-unit scale to a hazard-face mesh on a far -> mid/close
 * transition. Keep analytically driven rig children out of the generic
 * positional state transfer. */
function transferableBuildingDetails(
  mesh: EntityMesh,
): NonNullable<EntityMesh['buildingDetails']> {
  const details = mesh.buildingDetails ?? [];
  const fabricatorRoot = mesh.fabricatorConstructionRingRig?.root;
  if (fabricatorRoot === undefined) return details;
  return details.filter((detail) => detail.mesh.parent !== fabricatorRoot);
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
    carryScale: mesh.carryScale,
    solarOpenAmount: mesh.solarOpenAmount,
    buildingOperationalAmount: mesh.buildingOperationalAmount,
    buildingOperationalMotionTime: mesh.buildingOperationalMotionTime,
    pylonStates: pylons(mesh).map(capturePylonState),
    buildingDetailTransforms: transferableBuildingDetails(mesh).map((detail) =>
      captureSubtree(detail.mesh)) ?? [],
  };
}

export function applyEntityLodVisualState3D(
  mesh: EntityMesh,
  state: EntityLodVisualState3D | undefined,
): void {
  if (state === undefined) return;
  mesh.visualBankRoll = state.visualBankRoll;
  mesh.carryScale = state.carryScale;
  if (state.carryScale !== undefined) mesh.group.scale.setScalar(state.carryScale);
  mesh.solarOpenAmount = state.solarOpenAmount;
  mesh.solarPetalPoseAmount = undefined;
  mesh.buildingOperationalAmount = state.buildingOperationalAmount;
  mesh.buildingOperationalMotionTime = state.buildingOperationalMotionTime;

  const nextPylons = pylons(mesh);
  for (let i = 0; i < nextPylons.length; i++) {
    applyPylonState(nextPylons[i], state.pylonStates[i]);
  }
  if (mesh.buildingDetails) {
    const transferableDetails = transferableBuildingDetails(mesh);
    for (let i = 0; i < transferableDetails.length; i++) {
      const transforms = state.buildingDetailTransforms[i];
      if (transforms) applySubtree(transferableDetails[i].mesh, transforms);
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
  if (mesh.buildingOperationalAmount !== undefined) {
    applyBuildingOperationalPose(
      mesh.buildingOperationalRig,
      mesh.chassis,
      mesh.buildingOperationalAmount,
      mesh.buildingOperationalMotionTime ?? 0,
    );
  }
}
