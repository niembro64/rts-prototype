// Mirror panel mesh builder (3D). The mirror is a SINGLE RIGID
// assembly attached to the unit at one ball-joint — the turret's
// attachment point, located at the host unit's body-center height
// above the chassis lift. The joint is the `root` THREE.Group:
// `root.position` lifts to the attachment height, `root.quaternion`
// is the only rotation in the entire mirror system (yaw + pitch
// combined). The side arms, cylindrical grabbers, and panel mesh sit
// at static positions in `root`'s local frame and sweep through 3D as one body when
// `root` rotates. No per-mesh, per-frame rotation.

import * as THREE from 'three';

import { getMirrorFrameGeometry } from '../sim/mirrorPanelCache';

const CYLINDER_UP = new THREE.Vector3(0, 1, 0);
const _supportDir = new THREE.Vector3();

export type MirrorMesh = {
  /** The ball-joint. Position is the attachment point in liftGroup's
   *  frame; quaternion is the full yaw+pitch orientation written
   *  per-frame by the EntityRenderer. Children (arms + panels) sit
   *  at static local positions and share root's transform. */
  root: THREE.Group;
  panels: THREE.Mesh[];
  /** Extruded side support arms, two per panel, sharing the same parent as
   *  the panels. The renderer doesn't currently route these through
   *  any InstancedMesh — they're per-Mesh on the `root` group either
   *  way (the per-mirror cap is small, so a few static rails cost
   *  nothing). */
  arms: THREE.Mesh[];
  /** Slot indices into Render3DEntities.mirrorPanelInstanced when the
   *  panels are routed through the shared InstancedMesh (one slot per
   *  panel, parallel to `panels`). Empty / undefined when the per-Mesh
   *  fallback is in use (cap exhausted). The caller (Render3DEntities)
   *  sets this after build. */
  panelSlots?: number[];
  /** Thin team-colored cylindrical grabbers enclosing each mirror plate. These stay
   *  per-Mesh because they are low-count structural pieces, while the
   *  white mirror plates can still use the shared instance pool. */
  frames: THREE.Mesh[];
};

export type MirrorPanelMount = {
  /** Authored chassis-local offset of the panel center along the
   *  turret's local +X (forward). For the arm-mounted mirror this is
   *  the arm length (= radius.body × MIRROR_ARM_LENGTH_MULT). */
  offsetX: number;
  /** Lateral chassis-local offset; always 0 for the regularized
   *  centerline mirror panel. */
  offsetY: number;
  /** Extra panel yaw on top of the turret rotation; always 0 — the
   *  panel face is perpendicular to the arm. */
  angle: number;
};

export function buildMirrorMesh3D(
  parent: THREE.Group,
  panels: readonly MirrorPanelMount[],
  /** World-space (chassis-local) y of the panel center — the host
   *  unit's body center. The cache uses bp.bodyCenterHeight; pass the
   *  same value here so visual and sim panels share one center. */
  panelCenterY: number,
  /** Half the square's edge length (= radius.body). Same value the sim
   *  cache stores in halfWidth/halfHeight. */
  panelHalfSide: number,
  /** Forward arm length from the turret body sphere center to the
   *  panel center (chassis-local, along turret +X). Matches the sim
   *  cache's `panel.offsetX`. */
  panelArmLength: number,
  panelGeom: THREE.PlaneGeometry,
  armGeom: THREE.BoxGeometry,
  supportGeom: THREE.CylinderGeometry,
  panelMaterial: THREE.Material,
  armMaterial: THREE.Material,
  /** When true, panel Meshes are BUILT (so .position / .rotation /
   *  .scale carry the per-panel base transform) but NOT added to
   *  `root` — the caller is rendering panels through the shared
   *  InstancedMesh and reads each Mesh's transform as data. Same
   *  shape as TurretMesh3D's `skipBarrels` pattern. The support rails
   *  always attach per-Mesh; the cap-bound shared instance is for
   *  panels only. */
  skipPerMesh: boolean = false,
): MirrorMesh {
  // The mirror is a ball-joint at the turret attachment point. This
  // initial position is the flat-ground body center in liftGroup
  // space; Render3DEntities overwrites it per frame on slopes so the
  // joint lands exactly at entity.transform (the gameplay body center)
  // rather than at the slope-tilted height offset. Arms and panels
  // then live at Y = 0 in root's local frame; the only rotation in the
  // entire mirror assembly is root's own quaternion, written each
  // frame by the renderer to a single combined yaw + pitch.
  const root = new THREE.Group();
  root.position.set(0, panelCenterY, 0);
  parent.add(root);
  const panelMeshes: THREE.Mesh[] = [];
  const armMeshes: THREE.Mesh[] = [];
  const frameMeshes: THREE.Mesh[] = [];
  const frame = getMirrorFrameGeometry(panelHalfSide);
  const side = frame.side;
  const supportDiameter = frame.supportDiameter;
  const frameSegmentLength = frame.frameSegmentLength;

  const makeCylinderBetween = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
  ): THREE.Mesh => {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.max(Math.hypot(dx, dy, dz), 0.001);
    const mesh = new THREE.Mesh(supportGeom, armMaterial);
    mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    mesh.scale.set(supportDiameter, len, supportDiameter);
    _supportDir.set(dx / len, dy / len, dz / len);
    mesh.quaternion.setFromUnitVectors(CYLINDER_UP, _supportDir);
    return mesh;
  };

  for (let i = 0; i < panels.length; i++) {
    // Panel face — square plane perpendicular to the arm. PlaneGeometry
    // default lies in the XY plane with normal +Z. Rotating Y(-π/2)
    // takes the normal to +X (along the arm). The whole assembly's
    // pitch comes from root's quaternion, so the panel keeps a
    // static local rotation here.
    const m = new THREE.Mesh(panelGeom, panelMaterial);
    m.rotation.y = -Math.PI / 2;
    m.scale.set(side, side, 1);
    // Panel center at the END of the arm, root-local Y = 0.
    m.position.set(panelArmLength, 0, 0);
    if (!skipPerMesh) root.add(m);
    panelMeshes.push(m);

    const frameZ = frame.frameZ;
    const addSideArm = (sign: -1 | 1) => {
      const armZ = frameZ * sign;
      const armLength = Math.hypot(panelArmLength, armZ);
      const arm = new THREE.Mesh(armGeom, armMaterial);
      // The arm is the old "extruded frame tab" shape: long toward
      // the turret pivot, tall along the mirror side, and thin through
      // the panel. It overlaps the cylindrical grabber at the far end
      // so the holder reads rounded while the arm keeps its broad
      // structural face.
      arm.scale.set(armLength, frameSegmentLength, supportDiameter);
      arm.rotation.y = -Math.atan2(armZ, panelArmLength);
      arm.position.set(panelArmLength / 2, 0, armZ / 2);
      root.add(arm);
      armMeshes.push(arm);
    };
    addSideArm(-1);
    addSideArm(1);

    const left = makeCylinderBetween(
      panelArmLength, -frameSegmentLength / 2, -frameZ,
      panelArmLength, frameSegmentLength / 2, -frameZ,
    );
    root.add(left);
    frameMeshes.push(left);

    const right = makeCylinderBetween(
      panelArmLength, -frameSegmentLength / 2, frameZ,
      panelArmLength, frameSegmentLength / 2, frameZ,
    );
    root.add(right);
    frameMeshes.push(right);
  }
  return {
    root,
    panels: panelMeshes,
    arms: armMeshes,
    frames: frameMeshes,
  };
}
