import * as THREE from 'three';
import {
  CANNON_TOWER_VISUAL_HEIGHT,
  MEGA_BEAM_TOWER_VISUAL_HEIGHT,
} from '../sim/blueprints';
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
const cannonTowerBodyGeom = createHexFrustumGeometry(0.46, 0.58);

type DefenseTowerMeshProfile = {
  height: number;
  foot: number;
  baseHeight: number;
  baseRadiusFactor: number;
  lowerBandRadiusFactor: number;
  strutCount: number;
  strutAngleOffset: number;
  strutBottomRadiusFactor: number;
  strutTopRadiusFactor: number;
  strutBottomY: number;
  strutTopY: number;
  strutRadius: number;
  neckRadiusFactor: number;
  neckHeight: number;
  socketRadiusFactor: number;
  socketHeight: number;
  socketY: number;
};

const beamTowerProfile: DefenseTowerMeshProfile = {
  height: MEGA_BEAM_TOWER_VISUAL_HEIGHT,
  foot: 40,
  baseHeight: 14,
  baseRadiusFactor: 0.68,
  lowerBandRadiusFactor: 0.57,
  strutCount: 6,
  strutAngleOffset: Math.PI / 6,
  strutBottomRadiusFactor: 0.42,
  strutTopRadiusFactor: 0.29,
  strutBottomY: 17,
  strutTopY: MEGA_BEAM_TOWER_VISUAL_HEIGHT - 8,
  strutRadius: 1.7,
  neckRadiusFactor: 0.41,
  neckHeight: 7,
  socketRadiusFactor: 0.44,
  socketHeight: 4,
  socketY: MEGA_BEAM_TOWER_VISUAL_HEIGHT + 2,
};

const cannonTowerProfile: DefenseTowerMeshProfile = {
  height: CANNON_TOWER_VISUAL_HEIGHT,
  foot: 40,
  baseHeight: 16,
  baseRadiusFactor: 0.74,
  lowerBandRadiusFactor: 0.62,
  strutCount: 4,
  strutAngleOffset: Math.PI / 4,
  strutBottomRadiusFactor: 0.46,
  strutTopRadiusFactor: 0.33,
  strutBottomY: 20,
  strutTopY: CANNON_TOWER_VISUAL_HEIGHT - 10,
  strutRadius: 2.2,
  neckRadiusFactor: 0.45,
  neckHeight: 8,
  socketRadiusFactor: 0.5,
  socketHeight: 5,
  socketY: CANNON_TOWER_VISUAL_HEIGHT + 2.5,
};

/** Static beam tower — wider stepped base, hex-prism shaft, and a
 *  collar platform under the turret. The primary slab gets scaled to
 *  the building's full cuboid by the per-frame writer (so the
 *  silhouette inside the build grid stays correct); detail meshes
 *  carry the visible character — base flange, sloped spars, and
 *  a turret collar — and ride along in absolute world units, so they
 *  don't deform when the primary scales.
 *
 *  The mounted beam turret is built and aimed by Render3DEntities
 *  through the same buildTurretMesh3D path units use, so head + barrel
 *  + spin/pitch behavior stays shared with unit-mounted weapons. This
 *  shape builder owns body geometry only; turret meshes are added on
 *  top by the caller from `entity.combat.turrets`. */
export function buildMegaBeamTowerMesh(primaryMat: THREE.Material): BuildingShape {
  return buildDefenseTowerMesh(primaryMat, megaBeamTowerBodyGeom, beamTowerProfile);
}

/** Static cannon tower — same shared armed-tower body language as the
 *  beam tower, with a slightly squatter four-spar shaft and larger top
 *  socket for the heavier cannon turret. */
export function buildCannonTowerMesh(primaryMat: THREE.Material): BuildingShape {
  return buildDefenseTowerMesh(primaryMat, cannonTowerBodyGeom, cannonTowerProfile);
}

function buildDefenseTowerMesh(
  primaryMat: THREE.Material,
  bodyGeom: THREE.BufferGeometry,
  profile: DefenseTowerMeshProfile,
): BuildingShape {
  const primary = new THREE.Mesh(bodyGeom, primaryMat);

  // World-unit dimensions. The primary tapered shaft scales inside
  // the building's logical footprint; details are sized in those terms
  // so the authored silhouette does not deform when the primary scales.
  const h = profile.height;
  const foot = profile.foot;
  const details: BuildingShape['details'] = [];

  // Stepped hex foundation flange — slightly wider, low and squat.
  // Reads as "this thing is bolted into the ground, not floating".
  const baseHeight = profile.baseHeight;
  const base = makeCylinder(
    primaryMat,
    foot * profile.baseRadiusFactor,
    baseHeight,
    0,
    baseHeight / 2,
    0,
    hexCylinderGeom,
  );
  details.push(detail(base, 'min', undefined, 'static'));

  const lowerBand = makeCylinder(
    extractorBladeMat,
    foot * profile.lowerBandRadiusFactor,
    3,
    0,
    baseHeight + 1.5,
    0,
    hexCylinderGeom,
  );
  details.push(detail(lowerBand, 'min', undefined, 'static'));

  // Sloped metal spars follow the taper from the wide base to the
  // narrower turret neck, making the shaft read as engineered instead
  // of a scaled box.
  const strutBottomRadius = foot * profile.strutBottomRadiusFactor;
  const strutTopRadius = foot * profile.strutTopRadiusFactor;
  const strutBottomY = profile.strutBottomY;
  const strutTopY = profile.strutTopY;
  const strutRadius = profile.strutRadius;
  for (let i = 0; i < profile.strutCount; i++) {
    const angle = profile.strutAngleOffset + (i / profile.strutCount) * Math.PI * 2;
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
    foot * profile.neckRadiusFactor,
    profile.neckHeight,
    0,
    h - profile.neckHeight / 2,
    0,
    hexCylinderGeom,
  );
  details.push(detail(neck, 'min', undefined, 'static'));

  const socket = makeCylinder(
    extractorBladeMat,
    foot * profile.socketRadiusFactor,
    profile.socketHeight,
    0,
    profile.socketY,
    0,
    hexCylinderGeom,
  );
  details.push(detail(socket, 'min', undefined, 'static'));

  return { primary, details, height: h };
}

export function disposeMegaBeamTowerMeshGeoms(): void {
  megaBeamTowerBodyGeom.dispose();
  cannonTowerBodyGeom.dispose();
}
