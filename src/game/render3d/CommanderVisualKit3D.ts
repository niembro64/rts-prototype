import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { TurretMesh } from './TurretMesh3D';
import {
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
  getOrCreate,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

const COMMANDER_LENS_COLOR = COLORS.units.unitCommander.lens.colorHex;

export class CommanderVisualKit3D {
  private readonly boxGeom = new THREE.BoxGeometry(1, 1, 1);
  private readonly cylinderGeoms = new Map<PrimitiveGeometryTier, THREE.CylinderGeometry>();
  private readonly domeGeoms = new Map<PrimitiveGeometryTier, THREE.SphereGeometry>();
  private readonly lensMat = new THREE.MeshBasicMaterial({
    color: COMMANDER_LENS_COLOR,
    transparent: true,
    opacity: COLORS.units.unitCommander.lens.opacity,
    depthWrite: false,
  });
  private readonly darkArmorMat = new THREE.MeshLambertMaterial({
    color: COLORS.units.locomotion.leg.segment.colorHex,
  });

  private cylinderGeom(tier: PrimitiveGeometryTier): THREE.CylinderGeometry {
    return getOrCreate(this.cylinderGeoms, tier, () =>
      createPrimitiveCylinderGeometry('unitDetail', tier));
  }

  private domeGeom(tier: PrimitiveGeometryTier): THREE.SphereGeometry {
    return getOrCreate(this.domeGeoms, tier, () =>
      createPrimitiveSphereGeometry('unitDetail', tier));
  }

  buildKit(primaryMat: THREE.Material, geometryTier: PrimitiveGeometryTier): THREE.Group {
    const kit = new THREE.Group();
    const closeDetail = geometryTier === 'close';
    const mediumDetail = geometryTier !== 'far';
    const addBox = (
      material: THREE.Material,
      x: number, y: number, z: number,
      sx: number, sy: number, sz: number,
    ): void => {
      const mesh = new THREE.Mesh(this.boxGeom, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      kit.add(mesh);
    };
    const addCylinder = (
      material: THREE.Material,
      x: number, y: number, z: number,
      radiusX: number, height: number, radiusZ: number,
    ): void => {
      const mesh = new THREE.Mesh(this.cylinderGeom(geometryTier), material);
      mesh.position.set(x, y, z);
      mesh.scale.set(radiusX, height, radiusZ);
      kit.add(mesh);
    };
    const addDome = (
      material: THREE.Material,
      x: number, y: number, z: number,
      sx: number, sy: number, sz: number,
    ): void => {
      const mesh = new THREE.Mesh(this.domeGeom(geometryTier), material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      kit.add(mesh);
    };

    // BAR's Armada commander is read from a compact armoured chest, a small
    // faceted head and cyan optics. Keep this kit inside that silhouette: it
    // supplies identity and surface detail, not a second hull on top of it.
    addBox(this.darkArmorMat, 0.39, 2.24, 0, 0.08, 0.28, 0.4);
    if (mediumDetail) {
      addBox(primaryMat, 0.445, 2.24, 0, 0.025, 0.28, 0.045);
      addBox(primaryMat, 0.44, 2.38, 0, 0.025, 0.035, 0.44);
      addBox(primaryMat, 0.44, 2.1, 0, 0.025, 0.035, 0.44);
      addBox(this.lensMat, 0.465, 2.31, -0.13, 0.018, 0.055, 0.035);
      addBox(this.lensMat, 0.465, 2.31, 0.13, 0.018, 0.055, 0.035);
    }
    addBox(primaryMat, 0.32, 2.46, 0, 0.22, 0.12, 0.68);
    addBox(this.darkArmorMat, 0.27, 2.74, 0, 0.08, 0.18, 0.31);
    addBox(this.lensMat, 0.32, 2.76, -0.105, 0.025, 0.045, 0.065);
    addBox(this.lensMat, 0.32, 2.76, 0.105, 0.025, 0.045, 0.065);

    // Armada's silhouette is dominated by two rounded shoulder drums rather
    // than a flat bar across a humanoid chest.
    for (const side of [-1, 1] as const) {
      addDome(primaryMat, -0.03, 2.44, side * 0.56, 0.43, 0.35, 0.37);
      if (closeDetail) {
        addDome(this.darkArmorMat, -0.12, 2.43, side * 0.69, 0.24, 0.25, 0.18);
      }
      if (mediumDetail) {
        addBox(this.lensMat, 0.27, 2.47, side * 0.61, 0.035, 0.14, 0.085);
      }
    }

    addBox(this.darkArmorMat, 0.15, 1.84, 0, 0.18, 0.11, 0.3);
    if (closeDetail) for (const lateral of [-0.17, 0, 0.17]) {
      addBox(this.lensMat, 0.25, 1.93, lateral, 0.025, 0.12, 0.045);
    }

    addCylinder(this.darkArmorMat, -0.03, 2.96, 0, 0.17, 0.1, 0.17);
    addDome(this.lensMat, 0.03, 3.07, 0, 0.075, 0.075, 0.075);

    addBox(this.darkArmorMat, -0.57, 2.29, 0, 0.12, 0.54, 0.62);
    if (mediumDetail) {
      addBox(primaryMat, -0.61, 2.5, -0.29, 0.13, 0.22, 0.12);
      addBox(primaryMat, -0.61, 2.5, 0.29, 0.13, 0.22, 0.12);
    }
    if (closeDetail) {
      addBox(this.lensMat, -0.705, 2.55, -0.29, 0.025, 0.1, 0.065);
      addBox(this.lensMat, -0.705, 2.55, 0.29, 0.025, 0.1, 0.065);
    }
    return kit;
  }

  decorateTurret(
    tm: TurretMesh,
    isDgunTurret: boolean,
    primaryMat: THREE.Material,
    geometryTier: PrimitiveGeometryTier,
  ): void {
    // The D-gun is intentionally a logical zero-radius turret in the shared
    // registry. It still receives bespoke Commander-only head-emitter art.
    const headRadius = tm.headRadius ?? (isDgunTurret ? 4 : 6);
    // Replace generic spheres and collars with compact integrated housings:
    // an arm cannon for the beam and a crown/forehead emitter for the D-gun.
    if (tm.head !== undefined) tm.head.visible = false;
    tm.teamCollar = undefined;
    if (tm.pitchGroup === undefined) return;

    // Generic turret barrels are scaled from the generic spherical head. A
    // beam cone of that size dwarfs a forearm and, paired with the D-gun,
    // reads as a white hoop. The Commander owns compact integrated emitters
    // instead; gameplay aim and emission are unchanged because those are
    // driven by the turret state, not by these carrier meshes.
    for (const barrel of tm.barrels) barrel.removeFromParent();
    tm.barrels.length = 0;

    if (geometryTier !== 'far') {
      const cuff = new THREE.Mesh(this.boxGeom, primaryMat);
      cuff.position.set(-headRadius * 0.18, 0, 0);
      cuff.scale.set(
        headRadius * 0.52,
        headRadius * (isDgunTurret ? 0.6 : 0.72),
        headRadius * (isDgunTurret ? 0.72 : 0.78),
      );
      tm.pitchGroup.add(cuff);
    }

    if (isDgunTurret) {
      const housing = new THREE.Mesh(this.boxGeom, this.darkArmorMat);
      housing.position.set(headRadius * 0.52, 0, 0);
      housing.scale.set(headRadius * 1.25, headRadius * 0.62, headRadius * 0.76);
      tm.pitchGroup.add(housing);
      if (geometryTier !== 'far') {
        const muzzle = new THREE.Mesh(this.cylinderGeom(geometryTier), primaryMat);
        muzzle.position.set(headRadius * 1.2, 0, 0);
        muzzle.rotation.z = -Math.PI / 2;
        muzzle.scale.set(headRadius * 0.42, headRadius * 0.26, headRadius * 0.42);
        tm.pitchGroup.add(muzzle);
      }
      const aperture = new THREE.Mesh(this.boxGeom, this.lensMat);
      aperture.position.set(headRadius * 1.35, 0, 0);
      aperture.scale.set(headRadius * 0.05, headRadius * 0.26, headRadius * 0.29);
      tm.pitchGroup.add(aperture);
    } else {
      const barrel = new THREE.Mesh(this.cylinderGeom(geometryTier), this.darkArmorMat);
      barrel.position.set(headRadius * 0.68, 0, 0);
      barrel.rotation.z = -Math.PI / 2;
      barrel.scale.set(headRadius * 0.5, headRadius * 1.05, headRadius * 0.5);
      tm.pitchGroup.add(barrel);
      if (geometryTier !== 'far') {
        const armorRing = new THREE.Mesh(this.cylinderGeom(geometryTier), primaryMat);
        armorRing.position.set(headRadius * 0.25, 0, 0);
        armorRing.rotation.z = -Math.PI / 2;
        armorRing.scale.set(headRadius * 0.63, headRadius * 0.22, headRadius * 0.63);
        tm.pitchGroup.add(armorRing);
      }
      const muzzleRing = new THREE.Mesh(this.cylinderGeom(geometryTier), primaryMat);
      muzzleRing.position.set(headRadius * 1.23, 0, 0);
      muzzleRing.rotation.z = -Math.PI / 2;
      muzzleRing.scale.set(headRadius * 0.6, headRadius * 0.18, headRadius * 0.6);
      tm.pitchGroup.add(muzzleRing);
      const aperture = new THREE.Mesh(this.cylinderGeom(geometryTier), this.lensMat);
      aperture.position.set(headRadius * 1.34, 0, 0);
      aperture.rotation.z = -Math.PI / 2;
      aperture.scale.set(headRadius * 0.41, headRadius * 0.05, headRadius * 0.41);
      tm.pitchGroup.add(aperture);
      if (geometryTier === 'close') {
        const optic = new THREE.Mesh(this.boxGeom, this.lensMat);
        optic.position.set(headRadius * 0.58, headRadius * 0.48, 0);
        optic.scale.set(headRadius * 0.16, headRadius * 0.08, headRadius * 0.24);
        tm.pitchGroup.add(optic);
      }
    }
  }

  /** The Human is the light BAR-style standing infantry analogue. Its weapon
   *  is an arm cannon, not a complete spherical vehicle turret grafted to a
   *  wrist, so give it the same compact articulated treatment. */
  decorateHumanWeapon(tm: TurretMesh, primaryMat: THREE.Material): void {
    const headRadius = tm.headRadius ?? 3;
    if (tm.head !== undefined) tm.head.visible = false;
    tm.teamCollar = undefined;
    if (tm.pitchGroup === undefined) return;
    for (const barrel of tm.barrels) barrel.removeFromParent();
    tm.barrels.length = 0;

    const housing = new THREE.Mesh(this.boxGeom, primaryMat);
    housing.position.set(headRadius * 0.42, 0, 0);
    housing.scale.set(headRadius * 1.05, headRadius * 0.62, headRadius * 0.78);
    tm.pitchGroup.add(housing);

    const barrel = new THREE.Mesh(this.boxGeom, primaryMat);
    barrel.position.set(headRadius * 1.34, 0, 0);
    barrel.scale.set(headRadius * 0.88, headRadius * 0.3, headRadius * 0.36);
    tm.pitchGroup.add(barrel);

    const muzzle = new THREE.Mesh(this.boxGeom, this.lensMat);
    muzzle.position.set(headRadius * 1.81, 0, 0);
    muzzle.scale.set(headRadius * 0.08, headRadius * 0.24, headRadius * 0.29);
    tm.pitchGroup.add(muzzle);
  }

  dispose(): void {
    this.boxGeom.dispose();
    for (const geometry of this.cylinderGeoms.values()) geometry.dispose();
    for (const geometry of this.domeGeoms.values()) geometry.dispose();
    this.cylinderGeoms.clear();
    this.domeGeoms.clear();
    this.lensMat.dispose();
    this.darkArmorMat.dispose();
  }
}
