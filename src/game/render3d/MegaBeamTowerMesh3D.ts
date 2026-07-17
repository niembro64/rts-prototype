import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import {
  ANTI_AIR_TOWER_VISUAL_HEIGHT,
  CANNON_TOWER_VISUAL_HEIGHT,
  MEGA_BEAM_TOWER_VISUAL_HEIGHT,
} from '../sim/blueprints';
import type { BuildingShape } from './BuildingShape3D';
import {
  createHexFrustumGeometry,
  detail,
  getBuildingCylinderGeometry,
  hexCylinderGeom,
  makeCylinder,
} from './BuildingMeshPrimitives3D';

const megaBeamTowerBodyGeom = createHexFrustumGeometry(0.18, 0.3);
const cannonTowerBodyGeom = createHexFrustumGeometry(0.44, 0.54);
const antiAirTowerBodyGeom = createHexFrustumGeometry(0.32, 0.46);
const beamTowerTrimMat = new THREE.MeshStandardMaterial({
  color: COLORS.buildings.materials.towerBeamMegaTrim.colorHex,
  emissive: COLORS.buildings.materials.towerBeamMegaTrim.emissiveHex,
  emissiveIntensity: COLORS.buildings.materials.towerBeamMegaTrim.emissiveIntensity,
  metalness: COLORS.buildings.materials.towerBeamMegaTrim.metalness,
  roughness: COLORS.buildings.materials.towerBeamMegaTrim.roughness,
});
const towerCannonTrimMat = new THREE.MeshStandardMaterial({
  color: COLORS.buildings.materials.towerCannonTrim.colorHex,
  metalness: COLORS.buildings.materials.towerCannonTrim.metalness,
  roughness: COLORS.buildings.materials.towerCannonTrim.roughness,
});
const towerAntiAirTrimMat = new THREE.MeshStandardMaterial({
  color: COLORS.buildings.materials.towerAntiAirTrim.colorHex,
  emissive: COLORS.buildings.materials.towerAntiAirTrim.emissiveHex,
  emissiveIntensity: COLORS.buildings.materials.towerAntiAirTrim.emissiveIntensity,
  metalness: COLORS.buildings.materials.towerAntiAirTrim.metalness,
  roughness: COLORS.buildings.materials.towerAntiAirTrim.roughness,
});

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
  trimMaterial: THREE.Material;
};

const beamTowerProfile: DefenseTowerMeshProfile = {
  height: MEGA_BEAM_TOWER_VISUAL_HEIGHT,
  foot: 26,
  baseHeight: 10,
  baseRadiusFactor: 0.7,
  lowerBandRadiusFactor: 0.46,
  strutCount: 3,
  strutAngleOffset: Math.PI / 2,
  strutBottomRadiusFactor: 0.42,
  strutTopRadiusFactor: 0.16,
  strutBottomY: 14,
  strutTopY: MEGA_BEAM_TOWER_VISUAL_HEIGHT - 7,
  strutRadius: 1.0,
  neckRadiusFactor: 0.24,
  neckHeight: 10,
  socketRadiusFactor: 0.34,
  socketHeight: 3.5,
  socketY: MEGA_BEAM_TOWER_VISUAL_HEIGHT + 2,
  trimMaterial: beamTowerTrimMat,
};

const cannonTowerProfile: DefenseTowerMeshProfile = {
  height: CANNON_TOWER_VISUAL_HEIGHT,
  foot: 82,
  baseHeight: 12,
  baseRadiusFactor: 0.58,
  lowerBandRadiusFactor: 0.48,
  strutCount: 6,
  strutAngleOffset: Math.PI / 6,
  strutBottomRadiusFactor: 0.48,
  strutTopRadiusFactor: 0.34,
  strutBottomY: 13,
  strutTopY: CANNON_TOWER_VISUAL_HEIGHT - 7,
  strutRadius: 3.1,
  neckRadiusFactor: 0.34,
  neckHeight: 6,
  socketRadiusFactor: 0.43,
  socketHeight: 6,
  socketY: CANNON_TOWER_VISUAL_HEIGHT + 3,
  trimMaterial: towerCannonTrimMat,
};

const antiAirTowerProfile: DefenseTowerMeshProfile = {
  height: ANTI_AIR_TOWER_VISUAL_HEIGHT,
  foot: 42,
  baseHeight: 9,
  baseRadiusFactor: 0.62,
  lowerBandRadiusFactor: 0.5,
  strutCount: 4,
  strutAngleOffset: Math.PI / 4,
  strutBottomRadiusFactor: 0.43,
  strutTopRadiusFactor: 0.24,
  strutBottomY: 10,
  strutTopY: ANTI_AIR_TOWER_VISUAL_HEIGHT - 6,
  strutRadius: 1.6,
  neckRadiusFactor: 0.3,
  neckHeight: 7,
  socketRadiusFactor: 0.38,
  socketHeight: 4,
  socketY: ANTI_AIR_TOWER_VISUAL_HEIGHT + 2,
  trimMaterial: towerAntiAirTrimMat,
};

/** Static beam tower — thin cyan-trimmed spine, narrow base, and a
 *  compact collar platform under the turret. The primary slab gets scaled to
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

/** Static cannon tower — a low, broad bunker-like platform with heavy
 *  dark braces and a larger top socket for the cannon turret. */
export function buildCannonTowerMesh(primaryMat: THREE.Material): BuildingShape {
  return buildDefenseTowerMesh(primaryMat, cannonTowerBodyGeom, cannonTowerProfile);
}

/** Static anti-air tower — compact missile-defense mast with a bright
 *  top collar under the fast-tracking launcher. */
export function buildAntiAirTowerMesh(primaryMat: THREE.Material): BuildingShape {
  return buildDefenseTowerMesh(primaryMat, antiAirTowerBodyGeom, antiAirTowerProfile);
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
    profile.trimMaterial,
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
    const strut = new THREE.Mesh(getBuildingCylinderGeometry(), profile.trimMaterial);
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
    profile.trimMaterial,
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
  antiAirTowerBodyGeom.dispose();
  beamTowerTrimMat.dispose();
  towerCannonTrimMat.dispose();
  towerAntiAirTrimMat.dispose();
}
