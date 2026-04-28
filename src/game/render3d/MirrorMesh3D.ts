// Mirror panel mesh builder (3D). The panel is a flat square plane;
// its rotation/pitch are applied by the per-tick update path in
// EntityRenderer (rotation.y on the parent root, rotation.x on each
// panel). All this builder does is stamp the right-sized planes at
// the right offsets.

import * as THREE from 'three';
import { MIRROR_BASE_Y } from '../../config';

export type MirrorMesh = {
  /** Rotates with the turret (children of this rotate in turret frame). */
  root: THREE.Group;
  panels: THREE.Mesh[];
  /** Slot indices into Render3DEntities.mirrorPanelInstanced when the
   *  panels are routed through the shared InstancedMesh (one slot per
   *  panel, parallel to `panels`). Empty / undefined when the per-Mesh
   *  fallback is in use (cap exhausted). The caller (Render3DEntities)
   *  sets this after build. */
  panelSlots?: number[];
};

export type MirrorPanelMount = {
  offsetX: number;
  offsetY: number;
  angle: number;
};

export function buildMirrorMesh3D(
  parent: THREE.Group,
  panels: readonly MirrorPanelMount[],
  panelTopY: number,
  geom: THREE.PlaneGeometry,
  material: THREE.Material,
  /** When true, panel Meshes are BUILT (so .position / .rotation /
   *  .scale carry the per-panel base transform) but NOT added to
   *  `root` — the caller is rendering panels through the shared
   *  InstancedMesh and reads each Mesh's transform as data. Same
   *  shape as TurretMesh3D's `skipBarrels` pattern. */
  skipPerMesh: boolean = false,
): MirrorMesh {
  const root = new THREE.Group();
  parent.add(root);
  const meshes: THREE.Mesh[] = [];
  const mirrorHeight = Math.max(panelTopY - MIRROR_BASE_Y, 1);
  // Square panel: edge length = vertical extent. Single source of
  // truth for both axes, matching the sim's CachedMirrorPanel which
  // sets halfWidth = halfHeight = (topY − baseY) / 2.
  const side = mirrorHeight;

  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const m = new THREE.Mesh(geom, material);
    // PlaneGeometry default lies in the XY plane with normal +Z.
    // Rotate around local Y by -(angle + π/2) so the combined
    // chassis → mirrorRoot → panel transforms put the panel's
    // EDGE direction (originally +X) along world (turret.rotation +
    // angle + π/2), and its NORMAL (originally +Z) along world
    // (turret.rotation + angle). Pitch (rotation.x = -mirrorPitch)
    // is applied AFTER the yaw flip in YXZ order so it rotates the
    // panel around its edge axis — same convention the sim uses for
    // panel orientation in MirrorPanelHit.
    m.rotation.order = 'YXZ';
    m.rotation.y = -(p.angle + Math.PI / 2);
    m.scale.set(side, side, 1);
    m.position.set(p.offsetX, MIRROR_BASE_Y + mirrorHeight / 2, p.offsetY);
    if (!skipPerMesh) root.add(m);
    meshes.push(m);
  }
  return { root, panels: meshes };
}
