import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { TurretMesh } from './TurretMesh3D';
import {
  createPrimitiveConeGeometry,
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
  private readonly toothGeoms = new Map<PrimitiveGeometryTier, THREE.ConeGeometry>();
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

  private toothGeom(tier: PrimitiveGeometryTier): THREE.ConeGeometry {
    return getOrCreate(this.toothGeoms, tier, () =>
      createPrimitiveConeGeometry('unitDetail', tier));
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

  private addTooth(
    parent: THREE.Object3D,
    material: THREE.Material,
    tier: PrimitiveGeometryTier,
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
    pointsDown: boolean,
  ): THREE.Mesh {
    const tooth = new THREE.Mesh(this.toothGeom(tier), material);
    tooth.position.set(x, y, z);
    tooth.scale.set(radius, height, radius);
    if (pointsDown) tooth.rotation.z = Math.PI;
    parent.add(tooth);
    return tooth;
  }

  private hideGenericHead(tm: TurretMesh): void {
    if (tm.head !== undefined) tm.head.visible = false;
    tm.teamCollar = undefined;
  }

  private clearGenericHardware(tm: TurretMesh): void {
    this.hideGenericHead(tm);
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
    const yaw = tm.yawGroup;
    if (pivot === undefined || tm.barrels.length === 0) return;
    const r = tm.headRadius ?? 26;

    // The beam's existing cone is retained as the ordinary turret data
    // carrier. Its exact tip is QueryWeapon's muzzle, so placing the mouth at
    // that tip makes the laser leave the visible jaws without a second socket.
    const pilot = tm.barrels[0];
    const mouthPosition = new THREE.Vector3(0, pilot.scale.y * 0.5, 0)
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

    // Every visible skull and jaw part is below the ordinary pitch pivot. The
    // dinosaur head therefore IS the beam turret rather than decorative art
    // trying to follow a hidden turret after the fact.
    const head = new THREE.Group();
    head.userData.rexTyrannosaurHead = true;
    pivot.add(head);
    this.addSphere(
      head, this.armorMat, tier,
      -r * 0.3, r * 0.08, 0,
      r * 1.08, r * 0.86, r * 0.82,
    );

    const snoutStartX = r * 0.02;
    const snoutEndX = mouthPosition.x - r * 0.08;
    const snoutLength = Math.max(r * 1.2, snoutEndX - snoutStartX);
    const snoutCenterX = snoutStartX + snoutLength * 0.5;
    this.addBox(
      head, primaryMat,
      snoutCenterX, r * 0.06, 0,
      snoutLength, r * 0.52, r * 1.15,
    );
    this.addBox(
      head, this.armorMat,
      snoutCenterX - r * 0.04, -r * 0.56, 0,
      snoutLength * 0.92, r * 0.24, r * 0.94,
    );
    // The narrow lit throat is visible between the separated jaws and reads
    // as the beam charging in the mouth, while the retained pilot cone owns
    // the actual emitter line from throat to muzzle.
    this.addBox(
      head, this.apertureMat,
      snoutCenterX, -r * 0.31, 0,
      snoutLength * 0.92, r * 0.055, r * 0.74,
    );
    this.addBox(
      head, primaryMat,
      -r * 0.18, r * 0.5, 0,
      r * 0.82, r * 0.18, r * 1.42,
    );

    for (const side of [-1, 1]) {
      this.addBox(
        head, this.apertureMat,
        -r * 0.02, r * 0.48, side * r * 0.72,
        r * 0.2, r * 0.16, r * 0.1,
      );
    }

    if (tier !== 'far') {
      // Jaw hinge and nostrils survive through Mid; individual teeth are
      // reduced at Mid and omitted at Far while the jaw silhouette remains.
      const hinge = new THREE.Mesh(this.cylinderGeom(tier), this.armorMat);
      hinge.position.set(-r * 0.38, -r * 0.35, 0);
      hinge.rotation.x = Math.PI / 2;
      hinge.scale.set(r * 0.17, r * 1.5, r * 0.17);
      head.add(hinge);
      for (const side of [-1, 1]) {
        this.addBox(
          head, this.apertureMat,
          snoutEndX - r * 0.18, r * 0.24, side * r * 0.42,
          r * 0.12, r * 0.08, r * 0.07,
        );
      }

      const stations = tier === 'close'
        ? [0.25, 0.47, 0.69, 0.88]
        : [0.4, 0.74];
      for (const station of stations) {
        const toothX = snoutStartX + snoutLength * station;
        for (const side of [-1, 1]) {
          this.addTooth(
            head, barrelMat, tier,
            toothX, -r * 0.32, side * r * 0.46,
            r * 0.07, r * 0.25, true,
          );
          this.addTooth(
            head, barrelMat, tier,
            toothX + r * 0.07, -r * 0.35, side * r * 0.42,
            r * 0.055, r * 0.2, false,
          );
        }
      }
    }

    const mouth = new THREE.Group();
    mouth.position.copy(mouthPosition);
    mouth.userData.rexBeamMouth = true;
    head.add(mouth);
  }

  /** Attach Rex's counterbalancing tail to the lower-body/hip piece. This is
   * deliberately not a chassis child: the bot torso can assist turret yaw,
   * while the tail must remain aligned with the pelvis and walking legs. */
  decorateTail(
    hips: THREE.Group,
    primaryMat: THREE.Material,
    tier: PrimitiveGeometryTier,
    unitRadius: number,
  ): THREE.Group {
    const tail = new THREE.Group();
    tail.userData.rexTyrannosaurTail = true;
    hips.add(tail);

    const points = [
      new THREE.Vector3(-unitRadius * 0.38, unitRadius * 1.86, 0),
      new THREE.Vector3(-unitRadius * 1.14, unitRadius * 1.78, 0),
      new THREE.Vector3(-unitRadius * 1.9, unitRadius * 1.5, 0),
      new THREE.Vector3(-unitRadius * 2.72, unitRadius * 1.04, 0),
    ];
    const radii = [unitRadius * 0.42, unitRadius * 0.29, unitRadius * 0.145];
    const tipRatios = [0.69, 0.5, 0.08];
    for (let i = 0; i < points.length - 1; i++) {
      const segment = this.addFrustumBetween(
        tail,
        i === 0 ? primaryMat : this.armorMat,
        tier,
        points[i],
        points[i + 1],
        radii[i],
        tipRatios[i],
      );
      segment.userData.rexTailSegment = i;
    }
    return tail;
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
        // Keep the ordinary beam cone as the authoritative muzzle data
        // carrier; the dinosaur mouth is authored around its exact tip.
        this.hideGenericHead(tm);
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
    for (const geometry of this.sphereGeoms.values()) geometry.dispose();
    this.sphereGeoms.clear();
    for (const geometry of this.toothGeoms.values()) geometry.dispose();
    this.toothGeoms.clear();
    for (const geometry of this.frustumGeoms.values()) geometry.dispose();
    this.frustumGeoms.clear();
    this.armorMat.dispose();
    this.apertureMat.dispose();
  }
}
