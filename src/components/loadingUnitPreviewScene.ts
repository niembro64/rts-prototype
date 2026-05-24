import * as THREE from 'three';
import type { BuildableUnitId } from '@/game/sim/blueprints';
import { getUnitBlueprint } from '@/game/sim/blueprints';
import type { GraphicsConfig } from '@/types/graphics';
import type { UnitBlueprint } from '@/types/blueprints';
import type { CachedMirrorPanel } from '@/types/sim';
import { getChassisLiftY, getSegmentMidYAt } from '@/game/math/BodyDimensions';
import { resolveMirroredLegConfigs } from '@/game/math/LegLayout';
import { createUnitRuntimeTurrets } from '@/game/sim/runtimeTurrets';
import { buildMirrorPanelCache } from '@/game/sim/mirrorPanelCache';
import { applyTurretAimPose3D } from '@/game/render3d/TurretAimPose3D';
import { getBodyGeom } from '@/game/render3d/BodyShape3D';
import { buildTurretMesh3D } from '@/game/render3d/TurretMesh3D';
import { buildTreads } from '@/game/render3d/TreadRig3D';
import { buildWheels } from '@/game/render3d/WheelRig3D';
import { buildHoverFans } from '@/game/render3d/HoverRig3D';
import { buildFlyingRig } from '@/game/render3d/FlyingRig3D';
import { buildMirrorMesh3D } from '@/game/render3d/MirrorMesh3D';
import { kneeFromIK } from '@/game/render3d/LocomotionRigShared3D';
import { getTurretHeadRadius } from '@/game/math';
import { createShellMaterial } from '@/game/render3d/ShellMaterial';

type PreviewCanvas = HTMLCanvasElement | OffscreenCanvas;

export type LoadingUnitPreviewSceneOptions = {
  canvas: PreviewCanvas;
  unitId: BuildableUnitId;
  fullBleed: boolean;
};

export type LoadingUnitPreviewSceneSize = {
  width: number;
  height: number;
  dpr: number;
};

const PREVIEW_GFX: GraphicsConfig = {
  tier: 'max',
  unitRenderMode: 'rich',
  hudFrameStride: 1,
  effectFrameStride: 1,
  terrainTileFrameStride: 1,
  terrainTileSideWalls: true,
  waterSubdivisions: 1,
  waterFrameStride: 1,
  waterWaveAmplitude: 1,
  unitShape: 'full',
  legs: 'full',
  treadsAnimated: true,
  chassisDetail: true,
  paletteShading: false,
  turretStyle: 'full',
  forceTurretStyle: 'full',
  barrelSpin: true,
  beamStyle: 'complex',
  beamGlow: true,
  antialias: true,
  burnMarkDensity: 0,
  groundPrintDensity: 0,
  projectileStyle: 'full',
  fireExplosionStyle: 'inferno',
  materialExplosionStyle: 'obliterate',
  materialExplosionPieceBudget: 0,
  materialExplosionPhysicsFramesSkip: 1,
  deathExplosionStyle: 'obliterate',
};

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;
const CAMERA_FOV_DEGREES = 34;
const SPIN_RAD_PER_MS = (Math.PI * 2) / 7600;
const SHELL_ENTITY_ID = 1;

const turretHeadGeom = new THREE.SphereGeometry(1, 16, 12);
const barrelGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
const coneBarrelGeom = new THREE.CylinderGeometry(0, 1, 1, 10);
const mirrorGeom = new THREE.BoxGeometry(1, 1, 1);
const mirrorArmGeom = new THREE.BoxGeometry(1, 1, 1);
const mirrorSupportGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
const legCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
const legJointGeom = new THREE.SphereGeometry(1, 14, 10);
const legFootGeom = new THREE.CylinderGeometry(1, 1, 1, 14);
const scratchUp = new THREE.Vector3(0, 1, 0);
const scratchDir = new THREE.Vector3();
const scratchTarget = new THREE.Vector3();

export class LoadingUnitPreviewScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 1, 0.1, 10000);
  private readonly shellMaterial = createShellMaterial();
  private readonly spinRoot = new THREE.Group();
  private readonly fullBleed: boolean;
  private boundsRadius = 1;
  private fitHalfWidth = 1;
  private fitHalfHeight = 1;
  private startTime = 0;
  private width = DEFAULT_WIDTH;
  private height = DEFAULT_HEIGHT;
  private disposed = false;

  constructor(options: LoadingUnitPreviewSceneOptions) {
    this.fullBleed = options.fullBleed;
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(this.spinRoot);

    const model = buildPreviewUnitModel(options.unitId, this.shellMaterial);
    this.centerModel(model);
    this.spinRoot.add(model);
    this.resize({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, dpr: 1 });
  }

  resize(size: LoadingUnitPreviewSceneSize): void {
    if (this.disposed) return;
    this.width = Math.max(1, Math.round(size.width));
    this.height = Math.max(1, Math.round(size.height));
    this.renderer.setPixelRatio(Math.max(1, size.dpr));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }

  render(now: number): void {
    if (this.disposed) return;
    if (this.startTime === 0) this.startTime = now;
    const elapsed = now - this.startTime;
    this.spinRoot.rotation.y = elapsed * SPIN_RAD_PER_MS;
    this.spinRoot.rotation.x = Math.sin(elapsed * 0.00055) * 0.055;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.spinRoot.clear();
    this.scene.clear();
    this.renderer.renderLists.dispose();
    this.shellMaterial.dispose();
    this.renderer.forceContextLoss();
    this.renderer.dispose();
  }

  private centerModel(model: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    model.position.sub(center);
    this.boundsRadius = Math.max(1, sphere.radius);
    this.fitHalfWidth = Math.max(1, Math.hypot(size.x, size.z) * 0.5);
    this.fitHalfHeight = Math.max(1, size.y * 0.5);
  }

  private updateCamera(): void {
    const aspect = this.width / this.height;
    const verticalFov = THREE.MathUtils.degToRad(CAMERA_FOV_DEGREES);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const margin = this.fullBleed ? 1.9 : 1.9;
    const distance = Math.max(
      (this.fitHalfHeight * margin) / Math.tan(verticalFov / 2),
      (this.fitHalfWidth * margin) / Math.tan(horizontalFov / 2),
      this.boundsRadius * 1.2,
    );
    const lift = this.fitHalfHeight * (this.fullBleed ? 0.18 : 0.32);
    this.camera.position.set(0, lift, distance);
    this.camera.near = Math.max(0.1, distance - this.boundsRadius * 3.4);
    this.camera.far = distance + this.boundsRadius * 3.4;
    this.spinRoot.position.y = this.fullBleed ? this.fitHalfHeight * 0.28 : 0;
    this.camera.lookAt(scratchTarget.set(0, 0, 0));
    this.camera.updateProjectionMatrix();
  }
}

function buildPreviewUnitModel(unitId: BuildableUnitId, shellMaterial: THREE.Material): THREE.Group {
  const blueprint = getUnitBlueprint(unitId);
  const radius = blueprint.radius.body;
  const chassisLift = getChassisLiftY(blueprint, radius);
  const root = new THREE.Group();
  const yawGroup = new THREE.Group();
  root.add(yawGroup);

  buildPreviewLocomotion(yawGroup, blueprint, shellMaterial);

  const liftGroup = new THREE.Group();
  liftGroup.position.y = chassisLift;
  yawGroup.add(liftGroup);

  buildPreviewBody(liftGroup, blueprint, shellMaterial);
  buildPreviewTurrets(liftGroup, blueprint, unitId, chassisLift, shellMaterial);
  buildPreviewMirrors(liftGroup, blueprint, chassisLift, shellMaterial);
  applyShellMaterial(root, shellMaterial);
  return root;
}

function buildPreviewBody(
  liftGroup: THREE.Group,
  blueprint: UnitBlueprint,
  shellMaterial: THREE.Material,
): void {
  const chassis = new THREE.Group();
  const bodyEntry = getBodyGeom(blueprint.bodyShape);
  for (const part of bodyEntry.parts) {
    const mesh = new THREE.Mesh(part.geometry, shellMaterial);
    mesh.position.set(part.x, part.y, part.z);
    mesh.scale.set(part.scaleX, part.scaleY, part.scaleZ);
    if (part.rotZ) mesh.rotation.z = part.rotZ;
    chassis.add(mesh);
  }
  chassis.scale.setScalar(blueprint.radius.body);
  liftGroup.add(chassis);
}

function buildPreviewTurrets(
  liftGroup: THREE.Group,
  blueprint: UnitBlueprint,
  unitId: BuildableUnitId,
  chassisLift: number,
  shellMaterial: THREE.Material,
): void {
  const turrets = createUnitRuntimeTurrets(unitId, blueprint.radius.body);
  for (const turret of turrets) {
    const turretMesh = buildTurretMesh3D(liftGroup, turret, PREVIEW_GFX, {
      headGeom: turretHeadGeom,
      barrelGeom,
      coneBarrelGeom,
      primaryMat: shellMaterial,
      turretAccentMat: shellMaterial,
      skipHead: false,
      skipBarrels: false,
    });
    const headRadius = getTurretHeadRadius(turret.config);
    turretMesh.root.position.set(
      turret.mount.x,
      turret.mount.z - chassisLift - headRadius,
      turret.mount.y,
    );
    applyTurretAimPose3D(turretMesh, 0, turret.rotation, turret.pitch);
  }
}

function buildPreviewLocomotion(
  yawGroup: THREE.Group,
  blueprint: UnitBlueprint,
  shellMaterial: THREE.Material,
): void {
  const locomotion = blueprint.locomotion;
  if (!locomotion) return;
  const radius = blueprint.radius.body;
  switch (locomotion.type) {
    case 'treads':
      buildTreads(yawGroup, radius, locomotion.config, true, undefined);
      break;
    case 'wheels':
      buildWheels(yawGroup, radius, locomotion.config, undefined);
      break;
    case 'hover':
      buildHoverFans(yawGroup, radius, locomotion.config, 'hovercraft', SHELL_ENTITY_ID, undefined);
      break;
    case 'flying':
      buildFlyingRig(yawGroup, radius, locomotion.config, 'eagleFlying', SHELL_ENTITY_ID, undefined);
      break;
    case 'legs':
      buildPreviewLegs(yawGroup, blueprint, shellMaterial);
      break;
  }
}

function buildPreviewMirrors(
  liftGroup: THREE.Group,
  blueprint: UnitBlueprint,
  chassisLift: number,
  shellMaterial: THREE.Material,
): void {
  const mirrorPanels: CachedMirrorPanel[] = [];
  buildMirrorPanelCache(blueprint, mirrorPanels);
  if (mirrorPanels.length === 0) return;

  const turrets = createUnitRuntimeTurrets(blueprint.id, blueprint.radius.body);
  const mirrorTurret = turrets.find((turret) => turret.config.passive);
  const panelHalfSide = mirrorPanels[0].halfWidth;
  const panelArmLength = mirrorPanels[0].offsetX;

  buildMirrorMesh3D(
    liftGroup,
    mirrorPanels,
    mirrorTurret?.mount.x ?? 0,
    (mirrorTurret?.mount.z ?? blueprint.bodyCenterHeight) - chassisLift,
    mirrorTurret?.mount.y ?? 0,
    panelHalfSide,
    panelArmLength,
    mirrorGeom,
    mirrorArmGeom,
    mirrorSupportGeom,
    shellMaterial,
    shellMaterial,
  );
}

function buildPreviewLegs(
  yawGroup: THREE.Group,
  blueprint: UnitBlueprint,
  shellMaterial: THREE.Material,
): void {
  const locomotion = blueprint.locomotion;
  if (!locomotion || locomotion.type !== 'legs') return;
  const radius = blueprint.radius.body;
  const chassisLift = getChassisLiftY(blueprint, radius);
  const { all } = resolveMirroredLegConfigs(locomotion.config, radius);
  const upperRadius = Math.max(locomotion.config.upperThickness, 1) * 0.6;
  const lowerRadius = Math.max(locomotion.config.lowerThickness, 1) * 0.6;
  const hipJointRadius = Math.max(1, locomotion.config.hipRadius);
  const kneeJointRadius = Math.max(1, locomotion.config.kneeRadius);
  const footPadRadius = Math.max(1.1, lowerRadius * 1.45);
  const footPadHalfHeight = Math.max(0.35, lowerRadius * 0.45);
  const group = new THREE.Group();
  yawGroup.add(group);

  for (const leg of all) {
    const hipY = blueprint.legAttachHeightFrac !== null
      ? blueprint.legAttachHeightFrac * radius
      : chassisLift + getSegmentMidYAt(blueprint.bodyShape, radius, leg.attachOffsetX);
    const upperLen = leg.upperLegLength;
    const lowerLen = leg.lowerLegLength;
    const restDistance = (upperLen + lowerLen) * leg.snapDistanceMultiplier;
    const hip = new THREE.Vector3(leg.attachOffsetX, hipY, leg.attachOffsetY);
    const foot = new THREE.Vector3(
      hip.x + Math.cos(leg.snapTargetAngle) * restDistance,
      footPadHalfHeight + 0.35,
      hip.z + Math.sin(leg.snapTargetAngle) * restDistance,
    );
    const knee = kneeFromIK(
      hip.x, hip.y, hip.z,
      foot.x, foot.y, foot.z,
      upperLen, lowerLen,
      0, 1, 0,
    );
    const kneeVec = new THREE.Vector3(knee.x, knee.y, knee.z);
    addCylinderBetween(group, hip, kneeVec, upperRadius, shellMaterial);
    addCylinderBetween(group, kneeVec, foot, lowerRadius, shellMaterial);
    addSphere(group, hip, hipJointRadius, shellMaterial);
    addSphere(group, kneeVec, kneeJointRadius, shellMaterial);
    addFootPad(group, foot, footPadRadius, footPadHalfHeight, shellMaterial);
  }
}

function addCylinderBetween(
  parent: THREE.Group,
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 0.001) return;
  const mesh = new THREE.Mesh(legCylinderGeom, material);
  mesh.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
  mesh.scale.set(radius, length, radius);
  scratchDir.set(dx / length, dy / length, dz / length);
  mesh.quaternion.setFromUnitVectors(scratchUp, scratchDir);
  parent.add(mesh);
}

function addSphere(
  parent: THREE.Group,
  center: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): void {
  const mesh = new THREE.Mesh(legJointGeom, material);
  mesh.position.copy(center);
  mesh.scale.setScalar(radius);
  parent.add(mesh);
}

function addFootPad(
  parent: THREE.Group,
  center: THREE.Vector3,
  radius: number,
  halfHeight: number,
  material: THREE.Material,
): void {
  const mesh = new THREE.Mesh(legFootGeom, material);
  mesh.position.copy(center);
  mesh.scale.set(radius, halfHeight, radius);
  parent.add(mesh);
}

function applyShellMaterial(root: THREE.Object3D, shellMaterial: THREE.Material): void {
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh !== true) return;
    (object as THREE.Mesh).material = shellMaterial;
  });
}
