// Mirror panel mesh builder (3D). The panel + arm form a RIGID
// assembly: when the turret pitches, the arm AND panel swing through
// 3D space together. The arm direction is
//
//     a(α, β) = (cos α · cos β,  sin α · cos β,  sin β)
//
// from the turret pivot (`root` group origin), the panel center sits
// at arm's length out along that direction, and the panel face is
// perpendicular to the arm. Yaw lives on `root.rotation.y`; pitch is
// applied per-frame by the EntityRenderer to each arm + panel pair
// (positions + rotations recomputed from `panelArmLength` /
// `visibleArmLength` / `panelCenterY` stored on this struct).

import * as THREE from 'three';

export type MirrorMesh = {
  /** Rotates with the turret (children of this rotate in turret frame). */
  root: THREE.Group;
  panels: THREE.Mesh[];
  /** Attachment cylinders, one per panel, sharing the same parent as
   *  the panels. The renderer doesn't currently route these through
   *  any InstancedMesh — they're per-Mesh on the `root` group either
   *  way (the per-mirror cap is small, so a few static cylinders cost
   *  nothing). */
  arms: THREE.Mesh[];
  /** Slot indices into Render3DEntities.mirrorPanelInstanced when the
   *  panels are routed through the shared InstancedMesh (one slot per
   *  panel, parallel to `panels`). Empty / undefined when the per-Mesh
   *  fallback is in use (cap exhausted). The caller (Render3DEntities)
   *  sets this after build. */
  panelSlots?: number[];
  /** Geometry references the per-frame pitch updater needs to keep
   *  the rigid arm + panel assembly aligned with the turret's pitch.
   *  These mirror the build-time inputs so the renderer doesn't have
   *  to re-thread blueprint values through a long call chain. */
  panelArmLength: number;
  visibleArmLength: number;
  panelCenterY: number;
};

export type MirrorPanelMount = {
  /** Authored chassis-local offset of the panel center along the
   *  turret's local +X (forward). For the arm-mounted mirror this is
   *  the arm length (= bodyRadius × MIRROR_ARM_LENGTH_FRAC). */
  offsetX: number;
  /** Lateral chassis-local offset; always 0 for the regularized
   *  single-arm mirror. */
  offsetY: number;
  /** Extra panel yaw on top of the turret rotation; always 0 — the
   *  panel face is perpendicular to the arm. */
  angle: number;
};

const ARM_THICKNESS_FRAC = 0.18;
const ARM_PANEL_GAP_FRAC = 0.035;

export function buildMirrorMesh3D(
  parent: THREE.Group,
  panels: readonly MirrorPanelMount[],
  /** World-space (chassis-local) y of the panel center — the host
   *  unit's body center. The cache uses bp.bodyCenterHeight; pass the
   *  same value here so visual and sim panels share one center. */
  panelCenterY: number,
  /** Half the square's edge length (= bodyRadius). Same value the sim
   *  cache stores in halfWidth/halfHeight. */
  panelHalfSide: number,
  /** Forward arm length from the turret body sphere center to the
   *  panel center (chassis-local, along turret +X). Matches the sim
   *  cache's `panel.offsetX`. */
  panelArmLength: number,
  panelGeom: THREE.PlaneGeometry,
  armGeom: THREE.CylinderGeometry,
  panelMaterial: THREE.Material,
  armMaterial: THREE.Material,
  /** When true, panel Meshes are BUILT (so .position / .rotation /
   *  .scale carry the per-panel base transform) but NOT added to
   *  `root` — the caller is rendering panels through the shared
   *  InstancedMesh and reads each Mesh's transform as data. Same
   *  shape as TurretMesh3D's `skipBarrels` pattern. The ARM cylinder
   *  always attaches per-Mesh; the cap-bound shared instance is for
   *  panels only. */
  skipPerMesh: boolean = false,
): MirrorMesh {
  const root = new THREE.Group();
  parent.add(root);
  const panelMeshes: THREE.Mesh[] = [];
  const armMeshes: THREE.Mesh[] = [];
  const side = Math.max(panelHalfSide * 2, 1);
  const armThickness = Math.max(panelHalfSide * ARM_THICKNESS_FRAC, 0.5);
  const panelGap = Math.min(
    Math.max(panelHalfSide * ARM_PANEL_GAP_FRAC, 0.25),
    Math.max(panelArmLength * 0.2, 0),
  );
  const visibleArmLength = Math.max(panelArmLength - panelGap, 0.1);

  for (let i = 0; i < panels.length; i++) {
    // Attachment cylinder — runs from the turret body center
    // (root-local origin) out to the panel center along chassis-local
    // +X (which the parent yawGroup later rotates to the turret's
    // facing direction). The default CylinderGeometry has its axis
    // along +Y of unit length; rotate around +Z by -π/2 so its axis
    // points along +X, then translate the midpoint to half the arm
    // length and scale to (length, thickness, thickness). Stop short
    // of the mirror plane so the cylinder never peeks through the
    // flat square at glancing camera angles.
    const arm = new THREE.Mesh(armGeom, armMaterial);
    arm.rotation.z = -Math.PI / 2;
    arm.scale.set(armThickness, visibleArmLength, armThickness);
    arm.position.set(visibleArmLength / 2, panelCenterY, 0);
    root.add(arm);
    armMeshes.push(arm);

    // Panel face — square plane perpendicular to the arm. PlaneGeometry
    // default lies in the XY plane with normal +Z. Rotating around
    // local Y by -π/2 puts the panel's EDGE (originally +X) along
    // world (turret.rotation + π/2) and its NORMAL (originally +Z)
    // along world turret.rotation, so the face looks BACK along the
    // arm. Pitch (rotation.x = -mirrorPitch) is applied AFTER the yaw
    // flip in YXZ order so it rotates the panel around its edge axis
    // — same convention the sim uses for panel orientation in
    // MirrorPanelHit.
    const m = new THREE.Mesh(panelGeom, panelMaterial);
    m.rotation.order = 'YXZ';
    m.rotation.y = -Math.PI / 2;
    m.scale.set(side, side, 1);
    // Panel center sits at the END of the arm.
    m.position.set(panelArmLength, panelCenterY, 0);
    if (!skipPerMesh) root.add(m);
    panelMeshes.push(m);
  }
  return {
    root,
    panels: panelMeshes,
    arms: armMeshes,
    panelArmLength,
    visibleArmLength,
    panelCenterY,
  };
}
