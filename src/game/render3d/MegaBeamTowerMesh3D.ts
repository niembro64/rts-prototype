import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import {
  ANTI_AIR_TOWER_VISUAL_HEIGHT,
  CANNON_TOWER_VISUAL_HEIGHT,
  HEAVY_BEAM_TOWER_EMITTER_LAYOUT,
  HELIOS_TOWER_VISUAL_HEIGHT,
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
// The Helios siege spire tapers hard: a wide anchored base narrowing to a
// slender mast that carries the gun platform at 210 world units.
const heliosTowerBodyGeom = createHexFrustumGeometry(0.24, 0.55);
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
const TORPEDO_TORSO_PIECE_ID = 'torpedoTorso';
const HEAVY_BEAM_HEAD_PIECE_ID = 'beamHead';

function hostPieceDetail(
  pieceId: string,
  mesh: THREE.Mesh,
): BuildingShape['details'][number] {
  return {
    ...detail(mesh, 'min', undefined, 'static'),
    hostPieceId: pieceId,
  };
}

function torpedoTorsoDetail(mesh: THREE.Mesh): BuildingShape['details'][number] {
  return hostPieceDetail(TORPEDO_TORSO_PIECE_ID, mesh);
}

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
  /** Cross-yoke carrying the two rigid barrel sockets on a common head. */
  emitterYoke: {
    beamRadius: number;
    housingRadiusFactor: number;
    housingHeight: number;
    podRadiusFactor: number;
    podDepth: number;
    frontBandDepth: number;
    yokeForwardOffset: number;
    yokeEndPadding: number;
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
    beamRadius: 4.1,
    housingRadiusFactor: 0.56,
    housingHeight: 28,
    podRadiusFactor: 0.29,
    podDepth: 20,
    frontBandDepth: 3.6,
    yokeForwardOffset: 8,
    yokeEndPadding: 10,
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

// Bespoke Helios profile: the siege gun is the tallest defense structure by
// far (210-unit spire vs the cannon's 30-unit bunker), so it stops borrowing
// the cannon's squat proportions. Eight long spars follow the taper, the
// neck runs the last stretch to the elevated gun platform, and the two
// heliosYoke collars ride near the top through profile.height.
const heliosTowerProfile: DefenseTowerMeshProfile = {
  height: HELIOS_TOWER_VISUAL_HEIGHT,
  foot: 100,
  baseHeight: 18,
  baseRadiusFactor: 0.58,
  lowerBandRadiusFactor: 0.5,
  strutCount: 8,
  strutAngleOffset: Math.PI / 8,
  strutBottomRadiusFactor: 0.5,
  strutTopRadiusFactor: 0.2,
  strutBottomY: 20,
  strutTopY: HELIOS_TOWER_VISUAL_HEIGHT - 16,
  strutRadius: 2.6,
  neckRadiusFactor: 0.2,
  neckHeight: 22,
  socketRadiusFactor: 0.3,
  socketHeight: 8,
  socketY: HELIOS_TOWER_VISUAL_HEIGHT + 4,
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

/** Static heavy beam tower — one two-axis head carrying two rigid beam
 *  barrels. The logical stations may propose different targets, but neither
 *  barrel owns a local joint beneath the shared head. */
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
  variant: 'cannon' | 'torpedo' | 'helios' = 'cannon',
): BuildingShape {
  if (variant === 'helios') return buildHeliosTowerMesh(primaryMat);
  return buildDefenseTowerMesh(
    primaryMat,
    cannonTowerBodyGeom,
    cannonTowerProfile,
    variant,
  );
}

/** Static Helios siege spire — the tall bespoke profile plus mast dressing
 *  the shared builder does not know about: two service platforms breaking
 *  the long climb, a counterweight ring under the gun deck, and a beacon
 *  mast rising past the muzzle. */
function buildHeliosTowerMesh(primaryMat: THREE.Material): BuildingShape {
  const shape = buildDefenseTowerMesh(
    primaryMat,
    heliosTowerBodyGeom,
    heliosTowerProfile,
    'helios',
  );
  const profile = heliosTowerProfile;
  const foot = profile.foot;
  const h = profile.height;
  // Service platforms at one and two thirds of the climb: thin wide discs
  // with a darker rim band each, sized to overhang the taper at that height.
  for (const frac of [1 / 3, 2 / 3] as const) {
    const y = h * frac;
    const taper = 0.55 - (0.55 - 0.24) * frac;
    const deck = makeCylinder(primaryMat, foot * taper * 0.72, 3.2, 0, y, 0);
    shape.details.push(detail(deck, 'min', undefined, 'static'));
    const rim = makeCylinder(
      profile.trimMaterial,
      foot * taper * 0.76,
      1.6,
      0,
      y - 2.2,
      0,
    );
    shape.details.push(detail(rim, 'min', undefined, 'static'));
  }
  // Counterweight ring just under the gun deck: the visual answer to the
  // recoil of a high-arc siege round.
  const counterweight = makeCylinder(
    profile.trimMaterial,
    foot * 0.34,
    10,
    0,
    h - profile.neckHeight - 8,
    0,
  );
  shape.details.push(detail(counterweight, 'min', undefined, 'static'));
  return shape;
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
  variant: 'beam' | 'beamHeavy' | 'cannon' | 'antiAir' | 'torpedo' | 'helios',
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
  } else if (variant === 'beamHeavy') {
    // The enlarged center housing and cross-yoke remain one yaw+pitch head,
    // while the two deep forward pods give each rigid emitter a clearly
    // separate physical home. Their front faces terminate exactly at the
    // blueprint sockets; the established glowing cone emitters start there.
    const emitterForward = HEAVY_BEAM_TOWER_EMITTER_LAYOUT.forwardOffset;
    const emitterHalfSpan = HEAVY_BEAM_TOWER_EMITTER_LAYOUT.lateralHalfSpan;
    const housing = makeCylinder(
      primaryMat,
      foot * yoke.housingRadiusFactor,
      yoke.housingHeight,
      0,
      0,
      0,
    );
    housing.name = 'heavyBeamHeadHousing';
    details.push(hostPieceDetail(
      HEAVY_BEAM_HEAD_PIECE_ID,
      housing,
    ));
    const spar = makeCylinder(
      profile.trimMaterial,
      yoke.beamRadius,
      (emitterHalfSpan + yoke.yokeEndPadding) * 2,
      yoke.yokeForwardOffset,
      0,
      0,
    );
    spar.name = 'heavyBeamHeadYoke';
    spar.rotation.x = Math.PI / 2;
    details.push(hostPieceDetail(HEAVY_BEAM_HEAD_PIECE_ID, spar));
    for (const side of [-1, 1] as const) {
      const pod = makeCylinder(
        primaryMat,
        foot * yoke.podRadiusFactor,
        yoke.podDepth,
        emitterForward - yoke.podDepth / 2,
        0,
        side * emitterHalfSpan,
      );
      pod.name = side < 0 ? 'heavyBeamEmitterPodLeft' : 'heavyBeamEmitterPodRight';
      pod.rotation.z = Math.PI / 2;
      details.push(hostPieceDetail(HEAVY_BEAM_HEAD_PIECE_ID, pod));
    }
  } else {
    throw new Error(`Unexpected defense-tower emitter yoke for ${variant}`);
  }

  addDefenseTowerTeamOrnament(details, primaryMat, profile, variant);

  return {
    primary,
    details,
    height: h,
    turretHostPieces: variant === 'torpedo'
      ? [{ pieceId: TORPEDO_TORSO_PIECE_ID, root: new THREE.Group() }]
      : variant === 'beamHeavy'
        ? (() => {
          const root = new THREE.Group();
          const pitchRoot = new THREE.Group();
          root.add(pitchRoot);
          return [{ pieceId: HEAVY_BEAM_HEAD_PIECE_ID, root, pitchRoot }];
        })()
        : undefined,
  };
}

function addDefenseTowerTeamOrnament(
  details: BuildingShape['details'],
  primaryMat: THREE.Material,
  profile: DefenseTowerMeshProfile,
  variant: 'beam' | 'beamHeavy' | 'cannon' | 'antiAir' | 'torpedo' | 'helios',
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
    const yoke = profile.emitterYoke;
    if (yoke === null) throw new Error('Heavy Beam Tower requires its emitter yoke');
    const emitterForward = HEAVY_BEAM_TOWER_EMITTER_LAYOUT.forwardOffset;
    const emitterHalfSpan = HEAVY_BEAM_TOWER_EMITTER_LAYOUT.lateralHalfSpan;
    // Two distinct team-colour bands terminate the two pod housings at the
    // unchanged beam-emitter cones. Retain the established semantic kind so
    // team-colour and visibility contracts remain stable.
    for (const side of [-1, 1] as const) {
      const band = makeCylinder(
        primaryMat,
        foot * yoke.podRadiusFactor * 1.06,
        yoke.frontBandDepth,
        emitterForward - yoke.frontBandDepth / 2,
        0,
        side * emitterHalfSpan,
      );
      band.name = side < 0
        ? 'heavyBeamEmitterBandLeft'
        : 'heavyBeamEmitterBandRight';
      band.rotation.z = Math.PI / 2;
      details.push({
        ...teamOrnamentDetail(band, 'beamPairedCrowns'),
        hostPieceId: HEAVY_BEAM_HEAD_PIECE_ID,
      });
    }
    return;
  }

  if (variant === 'helios') {
    // The Helios siege gun wears a taller two-tier collar: the long slow
    // barrel needs a visibly heavier cradle than the standard cannon yoke,
    // and the distinct ornament kind keeps the per-building team-colour
    // vocabulary unique. Sized against the slender spire top rather than
    // the old bunker silhouette.
    details.push(teamOrnamentDetail(
      makeCylinder(
        primaryMat,
        foot * 0.30,
        5.0,
        0,
        profile.height - 4.0,
        0,
      ),
      'heliosYoke',
    ));
    details.push(teamOrnamentDetail(
      makeCylinder(
        primaryMat,
        foot * 0.26,
        4.0,
        0,
        profile.height - 12.0,
        0,
      ),
      'heliosYoke',
    ));
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
  // broad belt and pontoons sit at half the authored height. The launch heads
  // themselves are real turret meshes; this shape owns only their one shared
  // yawing torso and cross-yoke, authored around the blueprint's z=12 pivot.
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
  const torso = makeCylinder(
    primaryMat,
    foot * 0.12,
    14,
    0,
    -4,
    0,
    hexCylinderGeom,
  );
  details.push(torpedoTorsoDetail(torso));
  const yoke = makeCylinder(
    profile.trimMaterial,
    foot * 0.07,
    42,
    0,
    -10,
    0,
    hexCylinderGeom,
  );
  yoke.rotation.x = Math.PI / 2;
  details.push(torpedoTorsoDetail(yoke));
  for (const sign of [-1, 1]) {
    details.push(torpedoTorsoDetail(makeCylinder(
      primaryMat,
      foot * 0.13,
      4,
      0,
      -8,
      sign * 16,
      hexCylinderGeom,
    )));
  }
}

export function disposeMegaBeamTowerMeshGeoms(): void {
  megaBeamTowerBodyGeom.dispose();
  cannonTowerBodyGeom.dispose();
  antiAirTowerBodyGeom.dispose();
  beamTowerTrimMat.dispose();
  towerCannonTrimMat.dispose();
  towerAntiAirTrimMat.dispose();
}
