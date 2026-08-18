import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import {
  ANTI_AIR_TOWER_VISUAL_HEIGHT,
  CANNON_TOWER_VISUAL_HEIGHT,
  LIGHT_BEAM_TOWER_VISUAL_HEIGHT,
  MEGA_BEAM_TOWER_VISUAL_HEIGHT,
} from '../sim/blueprints';
import type { BuildingShape } from './BuildingShape3D';
import {
  createHexFrustumGeometry,
  detail,
  getBuildingCylinderGeometry,
  hexCylinderGeom,
  makeBox,
  makeCylinder,
  teamOrnamentDetail,
} from './BuildingMeshPrimitives3D';

const megaBeamTowerBodyGeom = createHexFrustumGeometry(0.18, 0.3);
const heavyBeamTowerBodyGeom = createHexFrustumGeometry(0.26, 0.42);
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
  /** Cross-yoke carrying two side-by-side emitters. Its half-span must match
   *  the blueprint's mount x offsets, so the heads sit on their own sockets
   *  instead of floating beside a centre collar. */
  emitterYoke: {
    halfSpan: number;
    beamRadius: number;
    padRadiusFactor: number;
    padHeight: number;
  } | null;
};

const lightBeamTowerProfile: DefenseTowerMeshProfile = {
  height: LIGHT_BEAM_TOWER_VISUAL_HEIGHT,
  foot: 26,
  baseHeight: 10,
  baseRadiusFactor: 0.7,
  lowerBandRadiusFactor: 0.46,
  strutCount: 3,
  strutAngleOffset: Math.PI / 2,
  strutBottomRadiusFactor: 0.42,
  strutTopRadiusFactor: 0.16,
  strutBottomY: 14,
  strutTopY: LIGHT_BEAM_TOWER_VISUAL_HEIGHT - 7,
  strutRadius: 1.0,
  neckRadiusFactor: 0.24,
  neckHeight: 10,
  socketRadiusFactor: 0.34,
  socketHeight: 3.5,
  socketY: LIGHT_BEAM_TOWER_VISUAL_HEIGHT + 2,
  trimMaterial: beamTowerTrimMat,
  emitterYoke: null,
};

/** The heavy tower is the same family read at a heavier gauge: thicker mast,
 *  broader base, and a cross-yoke whose two pads carry the paired emitters. */
const heavyBeamTowerProfile: DefenseTowerMeshProfile = {
  height: MEGA_BEAM_TOWER_VISUAL_HEIGHT,
  foot: 34,
  baseHeight: 13,
  baseRadiusFactor: 0.74,
  lowerBandRadiusFactor: 0.5,
  strutCount: 4,
  strutAngleOffset: Math.PI / 4,
  strutBottomRadiusFactor: 0.46,
  strutTopRadiusFactor: 0.2,
  strutBottomY: 16,
  strutTopY: MEGA_BEAM_TOWER_VISUAL_HEIGHT - 8,
  strutRadius: 1.7,
  neckRadiusFactor: 0.3,
  neckHeight: 12,
  socketRadiusFactor: 0.36,
  socketHeight: 4.5,
  socketY: MEGA_BEAM_TOWER_VISUAL_HEIGHT + 2,
  trimMaterial: beamTowerTrimMat,
  emitterYoke: {
    halfSpan: 18,
    beamRadius: 3.2,
    padRadiusFactor: 0.3,
    padHeight: 4,
  },
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
  emitterYoke: null,
};

const antiAirTowerProfile: DefenseTowerMeshProfile = {
  height: ANTI_AIR_TOWER_VISUAL_HEIGHT,
  foot: 42,
  baseHeight: 9,
  baseRadiusFactor: 0.62,
  lowerBandRadiusFactor: 0.5,
  strutCount: 6,
  strutAngleOffset: Math.PI / 6,
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
  emitterYoke: null,
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
export function buildLightBeamTowerMesh(primaryMat: THREE.Material): BuildingShape {
  return buildDefenseTowerMesh(
    primaryMat,
    megaBeamTowerBodyGeom,
    lightBeamTowerProfile,
    'beam',
  );
}

/** Static heavy beam tower — the same emitter family at a heavier gauge, with
 *  a cross-yoke carrying two independently aimed emitters. Both consume the
 *  host's single lock, so they converge on one target from either side. */
export function buildHeavyBeamTowerMesh(primaryMat: THREE.Material): BuildingShape {
  return buildDefenseTowerMesh(
    primaryMat,
    heavyBeamTowerBodyGeom,
    heavyBeamTowerProfile,
    'beamHeavy',
  );
}

/** Static cannon tower — a low, broad bunker-like platform with heavy
 *  dark braces and a larger top socket for the cannon turret. */
export function buildCannonTowerMesh(
  primaryMat: THREE.Material,
  variant: 'cannon' | 'torpedo' = 'cannon',
): BuildingShape {
  return buildDefenseTowerMesh(
    primaryMat,
    cannonTowerBodyGeom,
    cannonTowerProfile,
    variant,
  );
}

/** Static anti-air tower — compact missile-defense mast with a bright
 *  top collar under the fast-tracking launcher. */
export function buildAntiAirTowerMesh(primaryMat: THREE.Material): BuildingShape {
  return buildDefenseTowerMesh(
    primaryMat,
    antiAirTowerBodyGeom,
    antiAirTowerProfile,
    'antiAir',
  );
}

function buildDefenseTowerMesh(
  primaryMat: THREE.Material,
  bodyGeom: THREE.BufferGeometry,
  profile: DefenseTowerMeshProfile,
  variant: 'beam' | 'beamHeavy' | 'cannon' | 'antiAir' | 'torpedo',
): BuildingShape {
  const primary = new THREE.Mesh(bodyGeom, primaryMat);

  // World-unit dimensions. The primary tapered shaft scales inside
  // the building's logical footprint; details are sized in those terms
  // so the authored silhouette does not deform when the primary scales.
  const h = profile.height;
  const foot = profile.foot;
  const details: BuildingShape['details'] = [];

  // Stepped radial foundation flange — slightly wider, low and squat.
  // Reads as "this thing is bolted into the ground, not floating".
  const baseHeight = profile.baseHeight;
  const base = makeCylinder(
    primaryMat,
    foot * profile.baseRadiusFactor,
    baseHeight,
    0,
    baseHeight / 2,
    0,
  );
  details.push(detail(base, 'min', undefined, 'static'));

  const lowerBand = makeCylinder(
    profile.trimMaterial,
    foot * profile.lowerBandRadiusFactor,
    3,
    0,
    baseHeight + 1.5,
    0,
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

  // Turret socket — a compact radial collar at the top of the taper. The
  // actual rotating turret mesh is mounted on this centerline by
  // Render3DEntities.
  const neck = makeCylinder(
    primaryMat,
    foot * profile.neckRadiusFactor,
    profile.neckHeight,
    0,
    h - profile.neckHeight / 2,
    0,
  );
  details.push(detail(neck, 'min', undefined, 'static'));

  const yoke = profile.emitterYoke;
  if (yoke === null) {
    const socket = makeCylinder(
      profile.trimMaterial,
      foot * profile.socketRadiusFactor,
      profile.socketHeight,
      0,
      profile.socketY,
      0,
    );
    details.push(detail(socket, 'min', undefined, 'static'));
  } else {
    // One spar across the mast, with a pad under each emitter. The pads sit on
    // the blueprint's mount offsets so each head has something to stand on.
    // The spar is a laid-over cylinder rather than a box: this host's ornament
    // contract forbids visible cubic segments.
    const spar = makeCylinder(
      profile.trimMaterial,
      yoke.beamRadius,
      yoke.halfSpan * 2,
      0,
      profile.socketY,
      0,
    );
    spar.rotation.z = Math.PI / 2;
    details.push(detail(spar, 'min', undefined, 'static'));
    for (const sign of [-1, 1] as const) {
      details.push(detail(makeCylinder(
        profile.trimMaterial,
        foot * yoke.padRadiusFactor,
        yoke.padHeight,
        sign * yoke.halfSpan,
        profile.socketY + yoke.padHeight * 0.5,
        0,
      ), 'min', undefined, 'static'));
    }
  }

  addDefenseTowerTeamOrnament(details, primaryMat, profile, variant);

  return { primary, details, height: h };
}

function addDefenseTowerTeamOrnament(
  details: BuildingShape['details'],
  primaryMat: THREE.Material,
  profile: DefenseTowerMeshProfile,
  variant: 'beam' | 'beamHeavy' | 'cannon' | 'antiAir' | 'torpedo',
): void {
  const foot = profile.foot;
  if (variant === 'beam') {
    // The beam tower's identity converges at one clean radial emitter crown.
    // Keeping the crown continuous avoids blocky tabs around the slim mast.
    details.push(teamOrnamentDetail(
      makeCylinder(
        primaryMat,
        foot * 0.29,
        3.2,
        0,
        profile.height - profile.neckHeight - 1.6,
        0,
      ),
      'beamEmitterCrown',
    ));
    return;
  }

  if (variant === 'beamHeavy') {
    // Two crowns instead of one, so the paired emitters read as a matched set
    // and the team colour still lands where the eye goes.
    const yoke = profile.emitterYoke;
    const halfSpan = yoke === null ? 0 : yoke.halfSpan;
    for (const sign of [-1, 1] as const) {
      details.push(teamOrnamentDetail(
        makeCylinder(
          primaryMat,
          foot * 0.2,
          3.4,
          sign * halfSpan,
          profile.height - profile.neckHeight - 1.6,
          0,
        ),
        'beamPairedCrowns',
      ));
    }
    return;
  }

  if (variant === 'cannon') {
    // A broad circular yoke carries the heavy cannon without extending the
    // square foundation silhouette that the old pair of box cheeks created.
    details.push(teamOrnamentDetail(
      makeCylinder(
        primaryMat,
        foot * 0.43,
        4.5,
        0,
        profile.height - 3.5,
        0,
      ),
      'cannonYoke',
    ));
    return;
  }

  if (variant === 'antiAir') {
    // A low radial collar keeps team colour at the launcher pedestal without
    // the square footprint produced by four rectangular corner braces.
    details.push(teamOrnamentDetail(
      makeCylinder(
        primaryMat,
        foot * 0.48,
        3.2,
        0,
        profile.baseHeight + 3.2,
        0,
      ),
      'antiAirPedestalBrace',
    ));
    return;
  }

  // The torpedo emplacement is centered on the simulation water plane. Its
  // broad belt and pontoons therefore sit at half the authored height, while
  // the two launch tubes remain low in the submerged half of the housing.
  const waterlineY = profile.height * 0.5;
  details.push(teamOrnamentDetail(
    makeCylinder(
      primaryMat,
      foot * 0.53,
      4.6,
      0,
      waterlineY,
      0,
      hexCylinderGeom,
    ),
    'torpedoWaterlineBand',
  ));
  for (const sign of [-1, 1]) {
    details.push(teamOrnamentDetail(
      makeBox(
        primaryMat,
        foot * 0.2,
        6.2,
        foot * 0.58,
        sign * foot * 0.44,
        waterlineY,
        0,
      ),
      'torpedoWaterlineBand',
    ));
  }
  for (const sign of [-1, 1]) {
    const tube = makeCylinder(
      profile.trimMaterial,
      foot * 0.075,
      foot * 0.7,
      0,
      profile.height * 0.18,
      sign * foot * 0.2,
      hexCylinderGeom,
    );
    tube.rotation.z = Math.PI / 2;
    details.push(detail(tube, 'low', undefined, 'static'));
  }
  details.push(detail(makeCylinder(
    profile.trimMaterial,
    foot * 0.11,
    profile.height * 0.22,
    0,
    waterlineY + profile.height * 0.14,
    0,
    hexCylinderGeom,
  ), 'low', undefined, 'static'));
}

export function disposeMegaBeamTowerMeshGeoms(): void {
  megaBeamTowerBodyGeom.dispose();
  cannonTowerBodyGeom.dispose();
  antiAirTowerBodyGeom.dispose();
  beamTowerTrimMat.dispose();
  towerCannonTrimMat.dispose();
  towerAntiAirTrimMat.dispose();
}
