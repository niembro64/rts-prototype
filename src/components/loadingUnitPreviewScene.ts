import * as THREE from 'three';
import type { BuildableUnitBlueprintId } from '@/game/sim/blueprints';
import { getBuildingBlueprint, getUnitBlueprint } from '@/game/sim/blueprints';
import type { BuildingBlueprintId } from '@/types/blueprintIds';
import type { GraphicsConfig } from '@/types/graphics';
import type { UnitBlueprint } from '@/types/blueprints';
import type { CachedShieldPanel } from '@/types/sim';
import { getChassisLiftY, getSegmentMidYAt } from '@/game/math/BodyDimensions';
import { resolveMirroredLegConfigs } from '@/game/math/LegLayout';
import { createBuildingRuntimeTurrets, createUnitRuntimeTurrets } from '@/game/sim/runtimeTurrets';
import { BUILD_GRID_CELL_SIZE } from '@/game/sim/buildGrid';
import { buildBuildingShape } from '@/game/render3d/BuildingShape3D';
import { buildShieldPanelCache } from '@/game/sim/shieldPanelCache';
import { applyTurretAimPose3D } from '@/game/render3d/TurretAimPose3D';
import { getBodyGeom } from '@/game/render3d/BodyShape3D';
import { buildTurretMesh3D } from '@/game/render3d/TurretMesh3D';
import { buildTreads } from '@/game/render3d/TreadRig3D';
import { buildWheels } from '@/game/render3d/WheelRig3D';
import { buildAlbatrosHoverFans, buildHoverFans } from '@/game/render3d/HoverRig3D';
import { buildFlyingRig } from '@/game/render3d/FlyingRig3D';
import { buildAlbatrosChassis } from '@/game/render3d/AlbatrosMesh3D';
import { buildShieldPanelMesh3D } from '@/game/render3d/ShieldPanelMesh3D';
import { kneeFromIK } from '@/game/render3d/LocomotionRigShared3D';
import { getTurretHeadRadius } from '@/game/math';
import { COLORS } from '@/colorsConfig';
import { SUN_RENDER_CONFIG } from '@/config';
import { getPlayerColors, type PlayerId } from '@/game/sim/types';
import { turretAccentColorHexForPlayer } from '@/game/render3d/EntityInstanceColor3D';
import { createShieldFallbackPanelMaterial } from '@/game/render3d/ShieldReflectorVisual3D';
import { writeSunDirectionThree } from '@/game/render3d/SunLighting';
import { locomotionPieceColorHex } from '@/game/render3d/colorUtils';

type PreviewCanvas = HTMLCanvasElement | OffscreenCanvas;

/** What kind of entity the loading screen is previewing. Towers and
 *  buildings render through the same building-shape path; the distinction
 *  only matters for the stats panel (towers carry turrets). */
export type LoadingPreviewKind = 'unit' | 'tower' | 'building';
export type LoadingEntityBlueprintId = BuildableUnitBlueprintId | BuildingBlueprintId;

export type LoadingUnitPreviewSceneOptions = {
  canvas: PreviewCanvas;
  kind: LoadingPreviewKind;
  blueprintId: LoadingEntityBlueprintId;
  fullBleed: boolean;
};

export type LoadingUnitPreviewSceneSize = {
  width: number;
  height: number;
  dpr: number;
};

const PREVIEW_GFX: GraphicsConfig = {
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
// Render the loading unit as the primary host player (slot 1 → red),
// matching GameCanvas's `localPlayerId` default so it looks exactly as
// it will in-game for the host.
const HOST_PLAYER_ID: PlayerId = 1;
const LEG_SEGMENT_COLOR = COLORS.units.locomotion.leg.segment.colorHex;

// In-game units mix lit team-colored body/turret materials
// (MeshLambertMaterial, see Render3DEntities) with unlit, team-tinted
// locomotion pieces (MeshBasicMaterial, see TreadRig3D / colorUtils).
// The preview reproduces that exact split for one player so the unit
// reads as it would on the battlefield rather than as a pale shell.
type PreviewUnitMaterials = {
  /** Body, turret head, mirror frame/arm — player primary, lit. */
  primary: THREE.MeshLambertMaterial;
  /** Turret accent + physical barrels — half player color, half white, lit. */
  turretAccent: THREE.MeshLambertMaterial;
  /** Shield-reflector panel surface. */
  mirrorShiny: THREE.Material;
  /** Legged-locomotion segments — base leg color tinted toward the team
   *  color, unlit (matches the leg instanced renderer). */
  leg: THREE.MeshBasicMaterial;
};

function createPreviewUnitMaterials(playerId: PlayerId): PreviewUnitMaterials {
  return {
    primary: new THREE.MeshLambertMaterial({ color: getPlayerColors(playerId).primary }),
    turretAccent: new THREE.MeshLambertMaterial({ color: turretAccentColorHexForPlayer(playerId) }),
    mirrorShiny: createShieldFallbackPanelMaterial(),
    leg: new THREE.MeshBasicMaterial({ color: locomotionPieceColorHex(LEG_SEGMENT_COLOR, playerId) }),
  };
}

function disposePreviewUnitMaterials(materials: PreviewUnitMaterials): void {
  materials.primary.dispose();
  materials.turretAccent.dispose();
  materials.mirrorShiny.dispose();
  materials.leg.dispose();
}

/** Replicate the in-game sun (ambient + directional) so the lit body and
 *  turret materials shade the same way they do on the battlefield. The
 *  lights live in world space, not under the spin root, so the unit
 *  rotates beneath a fixed sun — exactly as in-game. */
function installPreviewLighting(scene: THREE.Scene): void {
  scene.add(new THREE.AmbientLight(SUN_RENDER_CONFIG.color, SUN_RENDER_CONFIG.ambientIntensity));
  const sun = new THREE.DirectionalLight(SUN_RENDER_CONFIG.color, SUN_RENDER_CONFIG.directionalIntensity);
  // Directional light shines from `position` toward its target (origin,
  // where the model is centered); distance is irrelevant for parallel
  // rays, so any positive scale along the sun direction works.
  writeSunDirectionThree(sun.position).multiplyScalar(100);
  scene.add(sun);
}

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
  private readonly materials = createPreviewUnitMaterials(HOST_PLAYER_ID);
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
    installPreviewLighting(this.scene);

    const model = buildPreviewModel(options.kind, options.blueprintId, this.materials);
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
    disposePreviewUnitMaterials(this.materials);
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

function buildPreviewModel(
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
  materials: PreviewUnitMaterials,
): THREE.Group {
  return kind === 'unit'
    ? buildPreviewUnitModel(blueprintId as BuildableUnitBlueprintId, materials)
    : buildPreviewBuildingModel(blueprintId as BuildingBlueprintId, materials);
}

/** Build a static preview of a building/tower, mirroring the in-game
 *  building renderer (BuildingEntityRenderer3D): a team-colored primary
 *  body scaled to the grid footprint + shape height, the type-specific
 *  detail meshes, and any mounted turrets posed at their absolute mounts.
 *  Animation rigs (spinning rotors, scanning radar, etc.) are left static
 *  — the whole model already spins on the loading stage. */
function buildPreviewBuildingModel(
  buildingBlueprintId: BuildingBlueprintId,
  materials: PreviewUnitMaterials,
): THREE.Group {
  const blueprint = getBuildingBlueprint(buildingBlueprintId);
  const width = blueprint.gridWidth * BUILD_GRID_CELL_SIZE;
  const depth = blueprint.gridHeight * BUILD_GRID_CELL_SIZE;
  const root = new THREE.Group();

  const shape = buildBuildingShape(blueprint.renderProfile, width, depth, materials.primary);
  if (!shape.bodyless) {
    // Match updateBuildingMesh: the primary body sits on the footprint
    // base and scales to (width, shapeHeight, depth).
    shape.primary.position.set(0, shape.height / 2, 0);
    shape.primary.scale.set(width, shape.height, depth);
    root.add(shape.primary);
  }
  for (const detail of shape.details) root.add(detail.mesh);

  buildPreviewBuildingTurrets(root, buildingBlueprintId, materials);
  return root;
}

function buildPreviewBuildingTurrets(
  root: THREE.Group,
  buildingBlueprintId: BuildingBlueprintId,
  materials: PreviewUnitMaterials,
): void {
  const turrets = createBuildingRuntimeTurrets(buildingBlueprintId);
  for (const turret of turrets) {
    const turretMesh = buildTurretMesh3D(root, turret, PREVIEW_GFX, {
      headGeom: turretHeadGeom,
      barrelGeom,
      coneBarrelGeom,
      primaryMat: materials.primary,
      turretAccentMat: materials.turretAccent,
      skipHead: false,
      skipBarrels: false,
    });
    // Building mounts are authored in absolute world units (see
    // BuildingEntityRenderer3D.updateTurretPoses): head pivots at
    // mount.z - headRadius, x/y map straight through.
    const headRadius = getTurretHeadRadius(turret.config);
    turretMesh.root.position.set(turret.mount.x, turret.mount.z - headRadius, turret.mount.y);
    applyTurretAimPose3D(turretMesh, 0, turret.rotation, turret.pitch);
  }
}

function buildPreviewUnitModel(
  unitBlueprintId: BuildableUnitBlueprintId,
  materials: PreviewUnitMaterials,
): THREE.Group {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  const radius = blueprint.radius.visual;
  const chassisLift = getChassisLiftY(blueprint, radius);
  const root = new THREE.Group();
  const yawGroup = new THREE.Group();
  root.add(yawGroup);

  buildPreviewLocomotion(yawGroup, blueprint, materials);

  const liftGroup = new THREE.Group();
  liftGroup.position.y = chassisLift;
  yawGroup.add(liftGroup);

  buildPreviewBody(liftGroup, blueprint, materials.primary);
  buildPreviewTurrets(liftGroup, blueprint, unitBlueprintId, chassisLift, materials);
  buildPreviewMirrors(liftGroup, blueprint, chassisLift, materials);
  return root;
}

function buildPreviewBody(
  liftGroup: THREE.Group,
  blueprint: UnitBlueprint,
  bodyMaterial: THREE.Material,
): void {
  const chassis = new THREE.Group();
  if (blueprint.unitBlueprintId === 'unitAlbatros') {
    buildAlbatrosChassis(chassis, bodyMaterial, SHELL_ENTITY_ID);
  } else {
    const bodyEntry = getBodyGeom(blueprint.bodyShape);
    for (const part of bodyEntry.parts) {
      const mesh = new THREE.Mesh(part.geometry, bodyMaterial);
      mesh.position.set(part.x, part.y, part.z);
      mesh.scale.set(part.scaleX, part.scaleY, part.scaleZ);
      if (part.rotZ) mesh.rotation.z = part.rotZ;
      chassis.add(mesh);
    }
  }
  chassis.scale.setScalar(blueprint.radius.visual);
  liftGroup.add(chassis);
}

function buildPreviewTurrets(
  liftGroup: THREE.Group,
  blueprint: UnitBlueprint,
  unitBlueprintId: BuildableUnitBlueprintId,
  chassisLift: number,
  materials: PreviewUnitMaterials,
): void {
  const turrets = createUnitRuntimeTurrets(unitBlueprintId, blueprint.radius.visual);
  for (const turret of turrets) {
    const showShieldEmitterCore =
      unitBlueprintId === 'unitAlbatros' &&
      turret.config.barrel?.type === 'complexSingleEmitter';
    const turretMesh = buildTurretMesh3D(liftGroup, turret, PREVIEW_GFX, {
      headGeom: turretHeadGeom,
      barrelGeom,
      coneBarrelGeom,
      primaryMat: materials.primary,
      turretAccentMat: materials.turretAccent,
      shieldEmitterMat: materials.mirrorShiny,
      showShieldEmitterCore,
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
  materials: PreviewUnitMaterials,
): void {
  const locomotion = blueprint.locomotion;
  if (!locomotion) return;
  const radius = blueprint.radius.visual;
  switch (locomotion.type) {
    case 'treads':
      buildTreads(yawGroup, radius, locomotion.config, true, HOST_PLAYER_ID);
      break;
    case 'wheels':
      buildWheels(yawGroup, radius, locomotion.config, HOST_PLAYER_ID);
      break;
    case 'hover':
      if (blueprint.unitBlueprintId === 'unitAlbatros') {
        buildAlbatrosHoverFans(
          yawGroup,
          radius,
          locomotion.config,
          'locomotionHovercraft',
          SHELL_ENTITY_ID,
          HOST_PLAYER_ID,
        );
      } else {
        buildHoverFans(
          yawGroup,
          radius,
          locomotion.config,
          'locomotionHovercraft',
          SHELL_ENTITY_ID,
          HOST_PLAYER_ID,
        );
      }
      break;
    case 'flying':
      buildFlyingRig(yawGroup, radius, locomotion.config, 'locomotionEagleFlying', SHELL_ENTITY_ID, HOST_PLAYER_ID);
      break;
    case 'legs':
      buildPreviewLegs(yawGroup, blueprint, materials.leg);
      break;
  }
}

function buildPreviewMirrors(
  liftGroup: THREE.Group,
  blueprint: UnitBlueprint,
  chassisLift: number,
  materials: PreviewUnitMaterials,
): void {
  const shieldPanels: CachedShieldPanel[] = [];
  buildShieldPanelCache(blueprint, shieldPanels);
  if (shieldPanels.length === 0) return;

  const turrets = createUnitRuntimeTurrets(blueprint.unitBlueprintId, blueprint.radius.visual);
  const shieldPanelTurret = turrets.find((turret) => turret.config.passive);
  const panelHalfSide = shieldPanels[0].halfWidth;
  const panelArmLength = shieldPanels[0].offsetX;

  buildShieldPanelMesh3D(
    liftGroup,
    shieldPanels,
    shieldPanelTurret?.mount.x ?? 0,
    (shieldPanelTurret?.mount.z ?? blueprint.bodyCenterHeight) - chassisLift,
    shieldPanelTurret?.mount.y ?? 0,
    panelHalfSide,
    panelArmLength,
    mirrorGeom,
    mirrorArmGeom,
    mirrorSupportGeom,
    materials.mirrorShiny,
    materials.primary,
  );
}

function buildPreviewLegs(
  yawGroup: THREE.Group,
  blueprint: UnitBlueprint,
  legMaterial: THREE.Material,
): void {
  const locomotion = blueprint.locomotion;
  if (!locomotion || locomotion.type !== 'legs') return;
  const radius = blueprint.radius.visual;
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
    addCylinderBetween(group, hip, kneeVec, upperRadius, legMaterial);
    addCylinderBetween(group, kneeVec, foot, lowerRadius, legMaterial);
    addSphere(group, hip, hipJointRadius, legMaterial);
    addSphere(group, kneeVec, kneeJointRadius, legMaterial);
    addFootPad(group, foot, footPadRadius, footPadHalfHeight, legMaterial);
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
