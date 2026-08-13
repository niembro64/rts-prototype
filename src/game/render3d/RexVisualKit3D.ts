import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { TurretMesh } from './TurretMesh3D';
import {
  createPrimitiveCylinderGeometry,
  getOrCreate,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

const REX_ARMOR_COLOR = COLORS.units.unitRex.armor.colorHex;
const REX_APERTURE_COLOR = COLORS.units.unitRex.aperture.colorHex;

/** Integrated weapon hardware for the Rex.
 *
 * The generic turret renderer is deliberately host-agnostic, so its round
 * heads work well on vehicles but read as loose balls when embedded in a
 * standing unit. Rex weapons instead use compact housings bolted to the
 * animated upper body. Logical mount centers, aim pivots, and spin groups are
 * retained verbatim; only the meshes below them are replaced.
 */
export class RexVisualKit3D {
  private readonly boxGeom = RexVisualKit3D.namedBoxGeom();
  private readonly cylinderGeoms = new Map<PrimitiveGeometryTier, THREE.CylinderGeometry>();
  private readonly armorMat = new THREE.MeshLambertMaterial({ color: REX_ARMOR_COLOR });
  private readonly apertureMat = new THREE.MeshBasicMaterial({
    color: REX_APERTURE_COLOR,
    transparent: true,
    opacity: COLORS.units.unitRex.aperture.opacity,
    depthWrite: false,
  });

  private static namedBoxGeom(): THREE.BoxGeometry {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    geom.name = 'rexWeaponKitBox';
    return geom;
  }

  private cylinderGeom(tier: PrimitiveGeometryTier): THREE.CylinderGeometry {
    return getOrCreate(this.cylinderGeoms, tier, () =>
      createPrimitiveCylinderGeometry('unitDetail', tier));
  }

  private addBox(
    parent: THREE.Object3D,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.boxGeom, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.add(mesh);
    return mesh;
  }

  private addTube(
    parent: THREE.Object3D,
    material: THREE.Material,
    tier: PrimitiveGeometryTier,
    centerX: number,
    y: number,
    z: number,
    radius: number,
    length: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.cylinderGeom(tier), material);
    mesh.position.set(centerX, y, z);
    mesh.rotation.z = -Math.PI / 2;
    mesh.scale.set(radius, length, radius);
    parent.add(mesh);
    return mesh;
  }

  private clearGenericHardware(tm: TurretMesh): void {
    if (tm.head !== undefined) tm.head.visible = false;
    tm.teamCollar = undefined;
    for (const barrel of tm.barrels) barrel.removeFromParent();
    tm.barrels.length = 0;
  }

  private decorateBeam(
    tm: TurretMesh,
    primaryMat: THREE.Material,
    barrelMat: THREE.Material,
    tier: PrimitiveGeometryTier,
  ): void {
    const pivot = tm.pitchGroup;
    if (pivot === undefined) return;
    const r = tm.headRadius ?? 26;
    const close = tier === 'close';

    // A low crown and armored cheek plates keep the mega beam recognizable as
    // the Rex's head without restoring the generic ball that floated above it.
    this.addBox(pivot, this.armorMat, r * 0.12, 0, 0, r * 1.05, r * 0.78, r * 1.18);
    if (tier === 'far') {
      this.addTube(pivot, barrelMat, tier, r * 1.02, 0, 0, r * 0.24, r * 1.5);
      return;
    }
    this.addBox(pivot, primaryMat, r * 0.02, r * 0.43, 0, r * 0.7, r * 0.16, r * 0.86);
    this.addTube(pivot, barrelMat, tier, r * 1.02, 0, 0, r * 0.24, r * 1.5);
    this.addTube(pivot, primaryMat, tier, r * 1.72, 0, 0, r * 0.34, r * 0.18);
    this.addTube(pivot, this.apertureMat, tier, r * 1.84, 0, 0, r * 0.23, r * 0.06);
    if (close) {
      this.addBox(pivot, this.apertureMat, r * 0.32, r * 0.46, -r * 0.27, r * 0.08, r * 0.1, r * 0.15);
      this.addBox(pivot, this.apertureMat, r * 0.32, r * 0.46, r * 0.27, r * 0.08, r * 0.1, r * 0.15);
    }
  }

  private decorateGatling(
    tm: TurretMesh,
    primaryMat: THREE.Material,
    barrelMat: THREE.Material,
    tier: PrimitiveGeometryTier,
  ): void {
    const pivot = tm.pitchGroup;
    const spinner = tm.spinGroup;
    if (pivot === undefined || spinner === undefined) return;
    const r = tm.headRadius ?? 20;

    // The housing is the Rex's fist/forearm terminus. The tube cluster remains
    // under the shared spin group, so barrel animation is still driven by the
    // ordinary turret cadence rather than a Rex-only clock.
    this.addBox(pivot, this.armorMat, r * 0.28, 0, 0, r * 1.2, r * 0.86, r * 1.02);
    if (tier === 'far') return;
    this.addBox(pivot, primaryMat, -r * 0.24, 0, 0, r * 0.24, r * 1.02, r * 1.12);
    this.addTube(pivot, primaryMat, tier, r * 0.72, 0, 0, r * 0.48, r * 0.2);

    const orbit = r * 0.28;
    const tubeCount = tier === 'mid' ? 1 : 3;
    for (let i = 0; i < tubeCount; i++) {
      const angle = ((i + 0.5) / 3) * Math.PI * 2;
      const y = tubeCount === 1 ? 0 : Math.cos(angle) * orbit;
      const z = tubeCount === 1 ? 0 : Math.sin(angle) * orbit;
      this.addTube(spinner, barrelMat, tier, r * 1.42, y, z, r * 0.12, r * 2.15);
      this.addBox(
        spinner,
        this.apertureMat,
        r * 2.49,
        y,
        z,
        r * 0.08,
        r * 0.3,
        r * 0.3,
      );
    }
  }

  private decorateFastRocketPod(
    tm: TurretMesh,
    primaryMat: THREE.Material,
    barrelMat: THREE.Material,
    tier: PrimitiveGeometryTier,
  ): void {
    const pivot = tm.pitchGroup;
    const spinner = tm.spinGroup;
    if (pivot === undefined || spinner === undefined) return;
    const r = tm.headRadius ?? 13;

    // A compact gimballed pod sits on the forward shoulder edge. Three tubes
    // match the turret's three authored emission lanes and rotate as one rack.
    this.addBox(pivot, this.armorMat, r * 0.34, 0, 0, r * 1.52, r * 1.55, r * 1.82);
    if (tier === 'far') return;
    this.addBox(pivot, primaryMat, -r * 0.4, 0, 0, r * 0.22, r * 1.7, r * 1.96);
    const orbit = r * 0.34;
    const tubeCount = tier === 'mid' ? 1 : 3;
    for (let i = 0; i < tubeCount; i++) {
      const angle = ((i + 0.5) / 3) * Math.PI * 2;
      const y = tubeCount === 1 ? 0 : Math.cos(angle) * orbit;
      const z = tubeCount === 1 ? 0 : Math.sin(angle) * orbit;
      this.addTube(spinner, barrelMat, tier, r * 1.12, y, z, r * 0.22, r * 1.92);
      this.addBox(
        spinner,
        this.apertureMat,
        r * 2.15,
        y,
        z,
        r * 0.09,
        r * 0.42,
        r * 0.42,
      );
    }
  }

  private decorateVerticalRocketPod(
    tm: TurretMesh,
    primaryMat: THREE.Material,
    barrelMat: THREE.Material,
    tier: PrimitiveGeometryTier,
  ): void {
    const pivot = tm.pitchGroup;
    const spinner = tm.spinGroup;
    if (pivot === undefined || spinner === undefined) return;
    const r = tm.headRadius ?? 14;

    // turretRocketSlow pins this pitch group to +90 degrees. Authored here in
    // ordinary +X turret space, the whole rack therefore stands upright on
    // the backpack without any bespoke launch-direction math.
    this.addBox(pivot, this.armorMat, r * 0.22, 0, 0, r * 1.48, r * 1.68, r * 1.68);
    if (tier === 'far') return;
    this.addBox(pivot, primaryMat, -r * 0.46, 0, 0, r * 0.2, r * 1.82, r * 1.82);
    const orbit = r * 0.32;
    const tubeCount = tier === 'mid' ? 1 : 3;
    for (let i = 0; i < tubeCount; i++) {
      const angle = ((i + 0.5) / 3) * Math.PI * 2;
      const y = tubeCount === 1 ? 0 : Math.cos(angle) * orbit;
      const z = tubeCount === 1 ? 0 : Math.sin(angle) * orbit;
      this.addTube(spinner, barrelMat, tier, r * 1.02, y, z, r * 0.22, r * 1.86);
      this.addBox(
        spinner,
        this.apertureMat,
        r * 2.02,
        y,
        z,
        r * 0.09,
        r * 0.42,
        r * 0.42,
      );
    }
  }

  decorateTurret(
    tm: TurretMesh,
    mountId: string,
    primaryMat: THREE.Material,
    barrelMat: THREE.Material,
    tier: PrimitiveGeometryTier,
  ): void {
    switch (mountId) {
      case 'beamMega':
        this.clearGenericHardware(tm);
        this.decorateBeam(tm, primaryMat, barrelMat, tier);
        break;
      case 'gatlingRight':
      case 'gatlingLeft':
        this.clearGenericHardware(tm);
        this.decorateGatling(tm, primaryMat, barrelMat, tier);
        break;
      case 'missileFast':
        this.clearGenericHardware(tm);
        this.decorateFastRocketPod(tm, primaryMat, barrelMat, tier);
        break;
      case 'siloRight':
      case 'siloLeft':
        this.clearGenericHardware(tm);
        this.decorateVerticalRocketPod(tm, primaryMat, barrelMat, tier);
        break;
    }
  }

  dispose(): void {
    this.boxGeom.dispose();
    for (const geometry of this.cylinderGeoms.values()) geometry.dispose();
    this.cylinderGeoms.clear();
    this.armorMat.dispose();
    this.apertureMat.dispose();
  }
}
