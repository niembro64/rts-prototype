import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import { getConstructionHazardMaterial } from './BuildingShape3D';
import type { TurretMesh } from './TurretMesh3D';
import { buildingTierAtLeast } from './RenderTier3D';

const COMMANDER_ARMOR_COLOR = 0x232830;
const COMMANDER_TRIM_COLOR = 0xc8d0da;
const COMMANDER_LENS_COLOR = 0x73e9ff;

export class CommanderVisualKit3D {
  private readonly boxGeom = new THREE.BoxGeometry(1, 1, 1);
  private readonly cylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 18);
  private readonly domeGeom = new THREE.SphereGeometry(1, 14, 10);
  private readonly armorMat = new THREE.MeshLambertMaterial({ color: COMMANDER_ARMOR_COLOR });
  private readonly trimMat = new THREE.MeshLambertMaterial({ color: COMMANDER_TRIM_COLOR });
  private readonly lensMat = new THREE.MeshBasicMaterial({
    color: COMMANDER_LENS_COLOR,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });

  buildKit(tier: ConcreteGraphicsQuality): THREE.Group {
    const kit = new THREE.Group();
    const hazardMat = getConstructionHazardMaterial();
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
      const mesh = new THREE.Mesh(this.cylinderGeom, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(radiusX, height, radiusZ);
      kit.add(mesh);
    };

    addBox(this.armorMat, -0.08, 1.12, 0, 1.04, 0.14, 0.76);
    if (buildingTierAtLeast(tier, 'low')) {
      addBox(this.trimMat, 0.44, 1.22, 0, 0.28, 0.12, 0.58);
      addBox(this.lensMat, 0.64, 1.27, 0, 0.08, 0.11, 0.46);
    }
    if (buildingTierAtLeast(tier, 'medium')) {
      addCylinder(hazardMat, -0.42, 1.34, 0, 0.34, 0.1, 0.34);
      addCylinder(this.armorMat, 0.34, 1.29, -0.42, 0.24, 0.16, 0.24);
      addCylinder(this.armorMat, 0.34, 1.29, 0.42, 0.24, 0.16, 0.24);
    }
    if (buildingTierAtLeast(tier, 'high')) {
      addBox(this.trimMat, 0.36, 1.42, -0.42, 0.4, 0.055, 0.17);
      addBox(this.trimMat, 0.36, 1.42, 0.42, 0.4, 0.055, 0.17);

      const sensor = new THREE.Mesh(this.domeGeom, this.lensMat);
      sensor.position.set(0.18, 1.36, 0);
      sensor.scale.set(0.12, 0.12, 0.12);
      kit.add(sensor);
    }
    if (buildingTierAtLeast(tier, 'max')) {
      addBox(this.armorMat, -0.28, 1.24, -0.38, 0.36, 0.07, 0.08);
      addBox(this.armorMat, -0.28, 1.24, 0.38, 0.36, 0.07, 0.08);
      addBox(this.trimMat, -0.38, 1.31, 0, 0.09, 0.22, 0.12);
      addBox(this.lensMat, -0.39, 1.43, 0, 0.06, 0.07, 0.08);
    }
    return kit;
  }

  decorateTurret(
    tm: TurretMesh,
    isDgunTurret: boolean,
    tier: ConcreteGraphicsQuality,
  ): void {
    const headRadius = tm.headRadius ?? 6;
    const collar = new THREE.Mesh(this.cylinderGeom, this.armorMat);
    collar.position.set(0, Math.max(1.2, headRadius * 0.16), 0);
    collar.scale.set(
      headRadius * 1.18,
      Math.max(1.6, headRadius * 0.15),
      headRadius * 1.18,
    );
    tm.root.add(collar);

    if (!buildingTierAtLeast(tier, 'medium')) return;

    const brow = new THREE.Mesh(this.boxGeom, this.armorMat);
    brow.position.set(headRadius * 0.55, headRadius * 1.24, 0);
    brow.scale.set(headRadius * 0.46, headRadius * 0.16, headRadius * 0.86);
    tm.root.add(brow);

    const optic = new THREE.Mesh(this.boxGeom, this.lensMat);
    optic.position.set(headRadius * 1.02, headRadius * 1.25, 0);
    optic.scale.set(headRadius * 0.08, headRadius * 0.12, headRadius * 0.42);
    tm.root.add(optic);

    if (tm.pitchGroup && buildingTierAtLeast(tier, 'high')) {
      const sleeve = new THREE.Mesh(this.boxGeom, isDgunTurret ? this.armorMat : this.trimMat);
      sleeve.position.set(headRadius * (isDgunTurret ? 0.72 : 0.55), 0, 0);
      sleeve.scale.set(
        headRadius * (isDgunTurret ? 1.05 : 0.72),
        headRadius * (isDgunTurret ? 0.34 : 0.22),
        headRadius * (isDgunTurret ? 0.34 : 0.22),
      );
      tm.pitchGroup.add(sleeve);
    }
    if (buildingTierAtLeast(tier, 'max')) {
      const crest = new THREE.Mesh(this.boxGeom, this.trimMat);
      crest.position.set(-headRadius * 0.08, headRadius * 1.34, 0);
      crest.scale.set(headRadius * 0.1, headRadius * 0.18, headRadius * 0.18);
      tm.root.add(crest);
    }
  }

  dispose(): void {
    this.boxGeom.dispose();
    this.cylinderGeom.dispose();
    this.domeGeom.dispose();
    this.armorMat.dispose();
    this.trimMat.dispose();
    this.lensMat.dispose();
  }
}
