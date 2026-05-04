// Mirror panel mesh builder (3D). The mirror is a SINGLE RIGID
// assembly attached to the unit at one ball-joint — the turret's
// attachment point, located at the host unit's body-center height
// above the chassis lift. The joint is the `root` THREE.Group:
// `root.position` lifts to the attachment height, `root.quaternion`
// is the only rotation in the entire mirror system (yaw + pitch
// combined). The side support rails and panel mesh sit at static positions
// in `root`'s local frame and sweep through 3D as one body when
// `root` rotates. No per-mesh, per-frame rotation.

import * as THREE from 'three';

export type MirrorMesh = {
  /** The ball-joint. Position is the attachment point in liftGroup's
   *  frame; quaternion is the full yaw+pitch orientation written
   *  per-frame by the EntityRenderer. Children (arms + panels) sit
   *  at static local positions and share root's transform. */
  root: THREE.Group;
  panels: THREE.Mesh[];
  /** Side support rails, two per panel, sharing the same parent as
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
  /** Thin team-colored bars enclosing each mirror plate. These stay
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
  frameGeom: THREE.BoxGeometry,
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
  // The mirror is a ball-joint at the turret attachment point. The
  // joint's location in the parent's (liftGroup) frame is at chassis
  // X/Z = 0 and Y = panelCenterY (the host unit's body-center height
  // above the parent). We position `root` THERE rather than at the
  // parent's origin so that root's own rotation pivots around the
  // attachment point. Arms and panels then live at Y = 0 in root's
  // local frame; the only rotation in the entire mirror assembly is
  // root's own quaternion, written each frame by the renderer to a
  // single combined yaw + pitch.
  const root = new THREE.Group();
  root.position.set(0, panelCenterY, 0);
  parent.add(root);
  const panelMeshes: THREE.Mesh[] = [];
  const armMeshes: THREE.Mesh[] = [];
  const frameMeshes: THREE.Mesh[] = [];
  const side = Math.max(panelHalfSide * 2, 1);
  const frameThickness = Math.max(panelHalfSide * 0.055, 0.25);
  const frameDepth = Math.max(panelHalfSide * 0.075, 0.34);
  const frameSegmentLength = side / 3;

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

    const frameZ = panelHalfSide + frameThickness / 2;
    const armAnchorX = Math.max(panelArmLength - frameDepth / 2, 0.1);
    const addSideArm = (sign: -1 | 1) => {
      const armZ = frameZ * sign;
      const armLength = Math.hypot(armAnchorX, armZ);
      const arm = new THREE.Mesh(frameGeom, armMaterial);
      // The rail is the side-frame segment extruded back to the
      // turret pivot: same vertical span and lateral thickness as the
      // visible frame tab, but rotated in X/Z so its inner endpoint
      // lands at the root-local center.
      arm.scale.set(armLength, frameSegmentLength, frameThickness);
      arm.rotation.y = -Math.atan2(armZ, armAnchorX);
      arm.position.set(armAnchorX / 2, 0, armZ / 2);
      root.add(arm);
      armMeshes.push(arm);
    };
    addSideArm(-1);
    addSideArm(1);

    const left = new THREE.Mesh(frameGeom, armMaterial);
    left.scale.set(frameDepth, frameSegmentLength, frameThickness);
    left.position.set(panelArmLength, 0, -frameZ);
    root.add(left);
    frameMeshes.push(left);

    const right = new THREE.Mesh(frameGeom, armMaterial);
    right.scale.set(frameDepth, frameSegmentLength, frameThickness);
    right.position.set(panelArmLength, 0, frameZ);
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
