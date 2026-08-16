import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { TurretMesh } from './TurretMesh3D';
import {
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
  getOrCreate,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import { GeometryCache3D } from './GeometryCache3D';

const REX_ARMOR_COLOR = COLORS.units.unitRex.armor.colorHex;
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
  private readonly cylinderGeoms = new GeometryCache3D(
    (tier: PrimitiveGeometryTier) => createPrimitiveCylinderGeometry('unitDetail', tier),
  );
  private readonly sphereGeoms = new GeometryCache3D(
    (tier: PrimitiveGeometryTier) => createPrimitiveSphereGeometry('unitDetail', tier),
  );
  private readonly frustumGeoms = new Map<string, THREE.CylinderGeometry>();
  private readonly armorMat = new THREE.MeshLambertMaterial({ color: REX_ARMOR_COLOR });

  private static namedBoxGeom(): THREE.BoxGeometry {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    geom.name = 'rexWeaponKitBox';
    return geom;
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
    const mesh = new THREE.Mesh(this.cylinderGeoms.get(tier), material);
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
    const mesh = new THREE.Mesh(this.sphereGeoms.get(tier), material);
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

    // Retain and expose the standard beam pilot-light cone and team collar.
    // Their broad base remains QueryWeapon's origin; the collar now reads as
    // a proper emitter barrel fitted into the front of the animal-like head.
    const pilot = tm.barrels[0];
    pilot.userData.rexBeamPilotBarrel = true;
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
    // Stop the organic shell behind the standard barrel collar. The previous
    // shell enclosed the complete pilot cone, hiding every visual cue that
    // this head is the beam turret.
    const headFrontX = r * 0.68;
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

    const belly = new THREE.Mesh(this.cylinderGeoms.get(tier), primaryMat);
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
    tier: PrimitiveGeometryTier,
  ): void {
    const pivot = tm.pitchGroup;
    if (pivot === undefined || tm.spinGroup === undefined) return;
    const r = tm.headRadius ?? 20;

    // Keep the standard five slender, spinning Gatling barrels. Rex only adds
    // a heavy forearm breech around their base, preserving the same readable
    // weapon silhouette used by ordinary Gatling hosts.
    const housing = new THREE.Group();
    housing.userData.rexGatlingBreech = true;
    pivot.add(housing);
    this.addBox(housing, this.armorMat, -r * 0.02, 0, 0, r * 0.76, r * 0.86, r * 1.02);
    if (tier === 'far') return;
    this.addBox(housing, primaryMat, -r * 0.34, 0, 0, r * 0.18, r * 1.02, r * 1.12);
    this.addTube(housing, primaryMat, tier, r * 0.39, 0, 0, r * 0.46, r * 0.12);
  }

  private decorateFastRocketPod(
    tm: TurretMesh,
    primaryMat: THREE.Material,
    tier: PrimitiveGeometryTier,
  ): void {
    const pivot = tm.pitchGroup;
    if (pivot === undefined || tm.spinGroup === undefined) return;
    const r = tm.headRadius ?? 13;

    // The shoulder weapon keeps turretRocketFast's three rotating tubes. A
    // short rectangular launch yoke distinguishes it from
    // both the circular arm Gatling and the three-tube vertical backpack rack.
    const pod = new THREE.Group();
    pod.userData.rexFastRocketPod = true;
    pivot.add(pod);
    this.addBox(pod, this.armorMat, r * 0.02, 0, 0, r * 0.7, r * 1.46, r * 1.72);
    if (tier === 'far') return;
    this.addBox(pod, primaryMat, r * 0.3, r * 0.64, 0, r * 0.88, r * 0.12, r * 1.9);
    this.addBox(pod, primaryMat, r * 0.3, -r * 0.64, 0, r * 0.88, r * 0.12, r * 1.9);
  }

  private decorateVerticalRocketPod(
    tm: TurretMesh,
    primaryMat: THREE.Material,
    tier: PrimitiveGeometryTier,
  ): void {
    const pivot = tm.pitchGroup;
    if (pivot === undefined || tm.spinGroup === undefined) return;
    const r = tm.headRadius ?? 14;

    // turretRocketSlow pins this pitch group to +90 degrees. Its standard
    // three broad rocket tubes therefore stand upright while this compact
    // launch deck braces their bases against the backpack.
    const rack = new THREE.Group();
    rack.userData.rexVerticalRocketRack = true;
    pivot.add(rack);
    this.addBox(rack, this.armorMat, -r * 0.04, 0, 0, r * 0.64, r * 1.64, r * 1.64);
    if (tier === 'far') return;
    this.addBox(rack, primaryMat, -r * 0.35, 0, 0, r * 0.16, r * 1.84, r * 1.84);
  }

  decorateTurret(
    tm: TurretMesh,
    mountId: string,
    primaryMat: THREE.Material,
    _barrelMat: THREE.Material,
    tier: PrimitiveGeometryTier,
  ): void {
    switch (mountId) {
      case 'beamMega':
        // Keep the standard beam cone and collar visible as the head's barrel.
        this.hideGenericHead(tm);
        this.decorateBeam(tm, primaryMat, tier);
        break;
      case 'gatlingRight':
      case 'gatlingLeft':
        this.hideGenericHead(tm);
        this.decorateGatling(tm, primaryMat, tier);
        break;
      case 'antiAirRight':
      case 'antiAirLeft':
        this.hideGenericHead(tm);
        this.decorateFastRocketPod(tm, primaryMat, tier);
        break;
      case 'siloRight':
      case 'siloLeft':
        this.hideGenericHead(tm);
        this.decorateVerticalRocketPod(tm, primaryMat, tier);
        break;
    }
  }

  dispose(): void {
    this.boxGeom.dispose();
    this.cylinderGeoms.dispose();
    this.sphereGeoms.dispose();
    for (const geometry of this.frustumGeoms.values()) geometry.dispose();
    this.frustumGeoms.clear();
    this.armorMat.dispose();
  }
}
