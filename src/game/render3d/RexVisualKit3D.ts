import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { TurretMesh } from './TurretMesh3D';
import { getBarrelOrbitAngle } from '../math/BarrelGeometry';
import {
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
  getOrCreate,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

const REX_ARMOR_COLOR = COLORS.units.unitRex.armor.colorHex;
const REX_APERTURE_COLOR = COLORS.units.unitRex.aperture.colorHex;
const SEGMENT_UP = new THREE.Vector3(0, 1, 0);
const SEGMENT_DIRECTION = new THREE.Vector3();

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
  private readonly sphereGeoms = new Map<PrimitiveGeometryTier, THREE.SphereGeometry>();
  private readonly frustumGeoms = new Map<string, THREE.CylinderGeometry>();
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

  private sphereGeom(tier: PrimitiveGeometryTier): THREE.SphereGeometry {
    return getOrCreate(this.sphereGeoms, tier, () =>
      createPrimitiveSphereGeometry('unitDetail', tier));
  }

  private frustumGeom(
    tier: PrimitiveGeometryTier,
    tipRadiusRatio: number,
  ): THREE.CylinderGeometry {
    const key = `${tier}:${tipRadiusRatio}`;
    return getOrCreate(this.frustumGeoms, key, () =>
      createPrimitiveCylinderGeometry('unitDetail', tier, tipRadiusRatio, 1));
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

  private addSphere(
    parent: THREE.Object3D,
    material: THREE.Material,
    tier: PrimitiveGeometryTier,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.sphereGeom(tier), material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.add(mesh);
    return mesh;
  }

  /** Build a tapered solid between authored piece endpoints. CylinderGeometry
   * uses local +Y, matching the bot-rig segment convention. The segment is a
   * presentation child only; no private socket or pose state is introduced. */
  private addFrustumBetween(
    parent: THREE.Object3D,
    material: THREE.Material,
    tier: PrimitiveGeometryTier,
    start: THREE.Vector3,
    end: THREE.Vector3,
    baseRadius: number,
    tipRadiusRatio: number,
  ): THREE.Mesh {
    SEGMENT_DIRECTION.subVectors(end, start);
    const length = SEGMENT_DIRECTION.length();
    const mesh = new THREE.Mesh(this.frustumGeom(tier, tipRadiusRatio), material);
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    if (length > 1e-6) {
      SEGMENT_DIRECTION.multiplyScalar(1 / length);
      mesh.quaternion.setFromUnitVectors(SEGMENT_UP, SEGMENT_DIRECTION);
    }
    mesh.scale.set(baseRadius, length, baseRadius);
    parent.add(mesh);
    return mesh;
  }

  private hideGenericHead(tm: TurretMesh): void {
    if (tm.head !== undefined) tm.head.visible = false;
    tm.teamCollar = undefined;
  }

  private clearGenericHardware(tm: TurretMesh): void {
    // Keep the shared team-colour collar anchor. Rex replaces the generic
    // head and tubes, not the stationary ornamented housing those tubes pass
    // through. The collar is rendered outside this scenegraph by the shared
    // trim pool and must survive the visual swap.
    if (tm.head !== undefined) tm.head.visible = false;
    for (const barrel of tm.barrels) barrel.removeFromParent();
    tm.barrels.length = 0;
  }

  private decorateBeam(
    tm: TurretMesh,
    primaryMat: THREE.Material,
    tier: PrimitiveGeometryTier,
  ): void {
    const pivot = tm.pitchGroup;
    const yaw = tm.yawGroup;
    if (pivot === undefined || tm.barrels.length === 0) return;
    const r = tm.headRadius ?? 26;

    // The beam's existing cone remains the ordinary pilot light. Its broad
    // base is QueryWeapon's origin; its tip remains the head's visual aperture
    // so the fused snout terminates where the ray becomes externally visible.
    const pilot = tm.barrels[0];
    const aperturePosition = new THREE.Vector3(0, pilot.scale.y * 0.5, 0)
      .applyQuaternion(pilot.quaternion)
      .add(pilot.position);

    // A thick, two-piece neck is yaw-owned: it turns with the head base but
    // does not rubber-bend when the skull pitches. The cranium overlaps its
    // upper end, hiding the mechanical joint at normal RTS distances.
    const neck = new THREE.Group();
    neck.userData.rexThickNeck = true;
    yaw.add(neck);
    const neckBase = new THREE.Vector3(-r * 1.02, -r * 0.82, 0);
    const neckMid = new THREE.Vector3(-r * 0.68, r * 0.16, 0);
    const neckTop = new THREE.Vector3(-r * 0.3, r * 0.9, 0);
    const lowerNeck = this.addFrustumBetween(
      neck, this.armorMat, tier, neckBase, neckMid, r * 0.72, 0.8,
    );
    lowerNeck.userData.rexNeckSegment = true;
    const upperNeck = this.addFrustumBetween(
      neck, primaryMat, tier, neckMid, neckTop, r * 0.58, 0.78,
    );
    upperNeck.userData.rexNeckSegment = true;

    // The deliberately abstract head is one contiguous canid-like shell: no
    // separate bill/snout block, jaw, mouth plate, teeth, eyes, nostrils, or
    // face decals. An elongated spheroid naturally narrows toward the muzzle
    // without producing the two-piece duck silhouette of a sphere plus box.
    const head = new THREE.Group();
    head.userData.rexTyrannosaurHead = true;
    pivot.add(head);
    const headBackX = -r * 1.05;
    const headFrontX = Math.max(r * 1.12, aperturePosition.x + r * 0.04);
    const headShell = this.addSphere(
      head, primaryMat, tier,
      (headBackX + headFrontX) * 0.5, r * 0.04, 0,
      (headFrontX - headBackX) * 0.5, r * 0.8, r * 0.74,
    );
    headShell.userData.rexUnifiedCanidHead = true;

    // Non-visual marker used only to contract-test the fused head against the
    // pilot-light tip. It is not a separate rendered mouth component.
    const aperture = new THREE.Group();
    aperture.position.copy(aperturePosition);
    aperture.userData.rexBeamAperture = true;
    head.add(aperture);
  }

  /** Build the cylindrical center ring as part of the independently yawing
   * upper body. The hips and legs counter-yaw beneath it. */
  decorateUpperBodyMidsection(
    upperBody: THREE.Group,
    primaryMat: THREE.Material,
    tier: PrimitiveGeometryTier,
    unitRadius: number,
  ): THREE.Group {
    const midsection = new THREE.Group();
    midsection.userData.rexUpperBodyMidsection = true;
    upperBody.add(midsection);

    const belly = new THREE.Mesh(this.cylinderGeom(tier), primaryMat);
    belly.position.set(unitRadius * 0.02, unitRadius * 1.94, 0);
    belly.scale.set(unitRadius * 0.43, unitRadius * 0.58, unitRadius * 0.43);
    midsection.add(belly);
    belly.userData.rexBellyCore = true;
    belly.userData.rexMidsectionAxis = 'vertical';
    return midsection;
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

    const orbit = Math.max(0, -spinner.position.y);
    const muzzleX = tm.fixedMultiBarrelMuzzle?.x ?? r * 2.5;
    const barrelStartX = r * 0.345;
    const barrelLength = muzzleX - barrelStartX;
    const tubeCount = tier === 'mid' ? 1 : 3;
    for (let i = 0; i < tubeCount; i++) {
      const angle = getBarrelOrbitAngle(i, tubeCount);
      const y = Math.cos(angle) * orbit;
      const z = Math.sin(angle) * orbit;
      const tube = this.addTube(
        spinner,
        barrelMat,
        tier,
        barrelStartX + barrelLength * 0.5,
        y,
        z,
        r * 0.12,
        barrelLength,
      );
      tube.userData.rexMultiBarrelTube = i;
      this.addBox(
        spinner,
        this.apertureMat,
        muzzleX,
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
    const orbit = Math.max(0, -spinner.position.y);
    const muzzleX = tm.fixedMultiBarrelMuzzle?.x ?? r * 2.1;
    const barrelStartX = r * 0.16;
    const barrelLength = muzzleX - barrelStartX;
    const tubeCount = tier === 'mid' ? 1 : 3;
    for (let i = 0; i < tubeCount; i++) {
      const angle = getBarrelOrbitAngle(i, tubeCount);
      const y = Math.cos(angle) * orbit;
      const z = Math.sin(angle) * orbit;
      const tube = this.addTube(
        spinner,
        barrelMat,
        tier,
        barrelStartX + barrelLength * 0.5,
        y,
        z,
        r * 0.22,
        barrelLength,
      );
      tube.userData.rexMultiBarrelTube = i;
      this.addBox(
        spinner,
        this.apertureMat,
        muzzleX,
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
    const orbit = Math.max(0, -spinner.position.y);
    const muzzleX = tm.fixedMultiBarrelMuzzle?.x ?? r * 2;
    const barrelStartX = r * 0.09;
    const barrelLength = muzzleX - barrelStartX;
    const tubeCount = tier === 'mid' ? 1 : 3;
    for (let i = 0; i < tubeCount; i++) {
      const angle = getBarrelOrbitAngle(i, tubeCount);
      const y = Math.cos(angle) * orbit;
      const z = Math.sin(angle) * orbit;
      const tube = this.addTube(
        spinner,
        barrelMat,
        tier,
        barrelStartX + barrelLength * 0.5,
        y,
        z,
        r * 0.22,
        barrelLength,
      );
      tube.userData.rexMultiBarrelTube = i;
      this.addBox(
        spinner,
        this.apertureMat,
        muzzleX,
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
        // Keep the ordinary beam cone as the pilot-light/origin data carrier;
        // the dinosaur head's forward aperture is authored around its tip.
        this.hideGenericHead(tm);
        this.decorateBeam(tm, primaryMat, tier);
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
    for (const geometry of this.sphereGeoms.values()) geometry.dispose();
    this.sphereGeoms.clear();
    for (const geometry of this.frustumGeoms.values()) geometry.dispose();
    this.frustumGeoms.clear();
    this.armorMat.dispose();
    this.apertureMat.dispose();
  }
}
