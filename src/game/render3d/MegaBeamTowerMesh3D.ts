import * as THREE from 'three';
import { MEGA_BEAM_TOWER_VISUAL_HEIGHT } from '../sim/blueprints';
import type { BuildingShape } from './BuildingShape3D';
import {
  createHexFrustumGeometry,
  cylinderGeom,
  detail,
  extractorBladeMat,
  hexCylinderGeom,
  makeCylinder,
} from './BuildingMeshPrimitives3D';

const megaBeamTowerBodyGeom = createHexFrustumGeometry(0.36);

/** Static beam tower — wider stepped base, hex-prism shaft, and a
 *  collar platform under the turret. The primary slab gets scaled to
 *  the building's full cuboid by the per-frame writer (so the
 *  silhouette inside the build grid stays correct); detail meshes
 *  carry the visible character — base flange, four corner ribs, and
 *  a turret collar — and ride along in absolute world units, so they
 *  don't deform when the primary scales.
 *
 *  The mounted beam turret is built and aimed by Render3DEntities
 *  through the same buildTurretMesh3D path units use, so head + barrel
 *  + spin/pitch behavior stays shared with unit-mounted weapons. This
 *  shape builder owns body geometry only; turret meshes are added on
 *  top by the caller from `entity.combat.turrets`. */
export function buildMegaBeamTowerMesh(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(megaBeamTowerBodyGeom, primaryMat);

  // World-unit dimensions. The primary tapered shaft scales inside
  // the building's logical 40x80x40 cuboid (set by gridWidth/gridHeight
  // x cellSize and the visualHeight constant); details are sized in
  // those terms.
  const h = MEGA_BEAM_TOWER_VISUAL_HEIGHT;
  const foot = 40; // gridWidth x cellSize for the megaBeamTower entry
  const details: BuildingShape['details'] = [];

  // Stepped hex foundation flange — slightly wider, low and squat.
  // Reads as "this thing is bolted into the ground, not floating".
  const baseHeight = 14;
  const base = makeCylinder(
    primaryMat,
    foot * 0.68,
    baseHeight,
    0,
    baseHeight / 2,
    0,
    hexCylinderGeom,
  );
  details.push(detail(base, 'min', undefined, 'static'));

  const lowerBand = makeCylinder(
    extractorBladeMat,
    foot * 0.57,
    3,
    0,
    baseHeight + 1.5,
    0,
    hexCylinderGeom,
  );
  details.push(detail(lowerBand, 'min', undefined, 'static'));

  // Six sloped metal spars follow the taper from the wide base to the
  // narrower turret neck, making the shaft read as hexagonal and
  // engineered instead of a scaled box.
  const strutBottomRadius = foot * 0.42;
  const strutTopRadius = foot * 0.29;
  const strutBottomY = baseHeight + 3;
  const strutTopY = h - 8;
  const strutRadius = 1.7;
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (i / 6) * Math.PI * 2;
    const bottom = new THREE.Vector3(
      Math.cos(angle) * strutBottomRadius,
      strutBottomY,
      Math.sin(angle) * strutBottomRadius,
    );
    const top = new THREE.Vector3(
      Math.cos(angle) * strutTopRadius,
      strutTopY,
      Math.sin(angle) * strutTopRadius,
    );
    const delta = top.clone().sub(bottom);
    const length = delta.length();
    const strut = new THREE.Mesh(cylinderGeom, extractorBladeMat);
    strut.scale.set(strutRadius * 2, length, strutRadius * 2);
    strut.position.copy(bottom).addScaledVector(delta, 0.5);
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    details.push(detail(strut, 'min', undefined, 'static'));
  }

  // Turret socket — a compact hex collar at the top of the taper. The
  // actual rotating turret mesh is mounted on this centerline by
  // Render3DEntities.
  const neck = makeCylinder(
    primaryMat,
    foot * 0.41,
    7,
    0,
    h - 3.5,
    0,
    hexCylinderGeom,
  );
  details.push(detail(neck, 'min', undefined, 'static'));

  const socket = makeCylinder(
    extractorBladeMat,
    foot * 0.44,
    4,
    0,
    h + 2,
    0,
    hexCylinderGeom,
  );
  details.push(detail(socket, 'min', undefined, 'static'));

  return { primary, details, height: h };
}

export function disposeMegaBeamTowerMeshGeoms(): void {
  megaBeamTowerBodyGeom.dispose();
}
