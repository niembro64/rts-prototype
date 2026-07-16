import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { getBuildingBlueprint, getUnitBlueprint } from '@/game/sim/blueprints';
import type { StructureBlueprintId, UnitBlueprintId } from '@/types/blueprintIds';
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
import { buildTreads, type TreadMesh } from '@/game/render3d/TreadRig3D';
import { buildWheels, type WheelMesh } from '@/game/render3d/WheelRig3D';
import {
  buildAlbatrosHoverFans,
  buildHoverFans,
  setHoverFanAnimationTime,
  type HoverMesh,
} from '@/game/render3d/HoverRig3D';
import { buildFlyingRig } from '@/game/render3d/FlyingRig3D';
import type { FlyingMesh } from '@/game/render3d/FlyingRig3D';
import {
  buildFlippers,
  poseFlippersAtCycle,
  type FlipperMesh,
} from '@/game/render3d/FlipperRig3D';
import {
  buildSwimRig,
  poseSwimRigAtCycle,
  type SwimMesh,
} from '@/game/render3d/SwimRig3D';
import { buildAlbatrosChassis } from '@/game/render3d/AlbatrosMesh3D';
import { buildShieldPanelMesh3D } from '@/game/render3d/ShieldPanelMesh3D';
import { kneeFromIK } from '@/game/render3d/LocomotionRigShared3D';
import {
  buildProductionHoldRingMesh,
  type ProductionHoldRingOrientation,
} from '@/game/render3d/ProductionHoldRing3D';
import { getTurretHeadRadius } from '@/game/math';
import { COLORS } from '@/colorsConfig';
import { SUN_RENDER_CONFIG } from '@/config';
import type { PlayerId } from '@/game/sim/types';
import { productionHoldRingRadiusForProducedUnit } from '@/game/sim/factoryProductionHold';
import {
  entityBodyColorHexForPlayer,
  turretAccentColorHexForPlayer,
} from '@/game/render3d/EntityInstanceColor3D';
import { createShieldFallbackPanelMaterial } from '@/game/render3d/ShieldReflectorVisual3D';
import {
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
} from '@/game/render3d/PrimitiveGeometryQuality3D';
import { writeSunDirectionThree } from '@/game/render3d/SunLighting';
import { locomotionPieceColorHex } from '@/game/render3d/colorUtils';

type PreviewCanvas = HTMLCanvasElement | OffscreenCanvas;

/** What kind of entity the loading screen is previewing. Towers and
 *  buildings render through the same building-shape path; the distinction
 *  only matters for the stats panel (towers carry turrets). */
export type LoadingPreviewKind = 'unit' | 'tower' | 'building';
export type LoadingEntityBlueprintId = UnitBlueprintId | StructureBlueprintId;

type LoadingUnitPreviewSceneOptions = {
  canvas: PreviewCanvas;
  kind: LoadingPreviewKind;
  blueprintId: LoadingEntityBlueprintId;
  fullBleed: boolean;
  preserveDrawingBuffer?: boolean;
};

export type LoadingUnitPreviewSceneSize = {
  width: number;
  height: number;
  dpr: number;
};

export type LoadingUnitPreviewControls = {
  rotate: boolean;
  rotationSpeed: number;
  yaw: number;
  pitch: number;
  motion: boolean;
  motionSpeed: number;
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
// Extra soft fill added only on the loading stage so the spinning unit
// isn't dimly lit; bump toward ~0.8 for a brighter hero, drop toward 0 to
// match the battlefield exactly.
const PREVIEW_FILL_INTENSITY = 0.5;
const SHELL_ENTITY_ID = 1;
// Render the loading unit as the primary host player (slot 1 → red),
// matching GameCanvas's `localPlayerId` default so it looks exactly as
// it will in-game for the host.
const HOST_PLAYER_ID: PlayerId = 1;
const LEG_SEGMENT_COLOR = COLORS.units.locomotion.leg.segment.colorHex;
const DEFAULT_CONTROLS: LoadingUnitPreviewControls = {
  rotate: true,
  rotationSpeed: 1,
  yaw: 0,
  pitch: 0,
  motion: false,
  motionSpeed: 1,
};

type PreviewLocomotionRig =
  | { type: 'wheels'; mesh: WheelMesh }
  | { type: 'treads'; mesh: TreadMesh }
  | { type: 'hover'; mesh: HoverMesh }
  | { type: 'flying'; mesh: FlyingMesh }
  | { type: 'flippers'; mesh: FlipperMesh }
  | { type: 'swim'; mesh: SwimMesh }
  | { type: 'legs'; group: THREE.Group };

type PreviewModel = {
  root: THREE.Group;
  locomotion: PreviewLocomotionRig | null;
};

type PreviewProductionRing = {
  producedUnitBlueprintId: string;
  centerX: number;
  centerY: number;
  centerZ: number;
  ringRadius: number;
  ringOrientation: ProductionHoldRingOrientation;
};

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
    primary: new THREE.MeshLambertMaterial({ color: entityBodyColorHexForPlayer(playerId) }),
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
  // Loading-screen-only hero fill. The battlefield sun alone leaves the
  // shaded side of the unit dark against the black loading stage. A gentle
  // hemisphere fill (warm sky above, dim cool ground below) lifts the
  // shadow side without shifting the lit-side hue, so the unit still reads
  // as its in-game self — just brighter and better presented here.
  scene.add(new THREE.HemisphereLight(SUN_RENDER_CONFIG.color, 0x2c3340, PREVIEW_FILL_INTENSITY));
}

/** Mirror ThreeApp's image-based lighting: a PMREM-preprocessed
 *  RoomEnvironment cube assigned to `scene.environment`. The in-game
 *  shield/chrome PBR panels reflect this cube — they render dark and flat
 *  without it — and it lends the lit Lambert body the same subtle fill it
 *  receives on the battlefield, so the preview grades like the game. */
function installPreviewEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  const texture = pmrem.fromScene(roomEnv, 0.04).texture;
  scene.environment = texture;
  roomEnv.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ('dispose' in (mesh.geometry ?? {})) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) for (const mat of material) mat.dispose();
    else material?.dispose();
  });
  pmrem.dispose();
  return texture;
}

const turretHeadGeom = createPrimitiveSphereGeometry('turret', 'close');
const barrelGeom = createPrimitiveCylinderGeometry('turret', 'close');
const coneBarrelGeom = createPrimitiveCylinderGeometry('turret', 'close', 0, 1);
const mirrorGeom = new THREE.BoxGeometry(1, 1, 1);
const mirrorArmGeom = new THREE.BoxGeometry(1, 1, 1);
const mirrorSupportGeom = createPrimitiveCylinderGeometry('shield', 'mid', 0.5, 0.5);
const legCylinderGeom = createPrimitiveCylinderGeometry('locomotion', 'mid');
const legJointGeom = createPrimitiveSphereGeometry('locomotion', 'close');
const legFootGeom = createPrimitiveCylinderGeometry('locomotion', 'mid');
const scratchUp = new THREE.Vector3(0, 1, 0);
const scratchDir = new THREE.Vector3();
const scratchTarget = new THREE.Vector3();

export class LoadingUnitPreviewScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 1, 0.1, 10000);
  private readonly materials = createPreviewUnitMaterials(HOST_PLAYER_ID);
  private readonly spinRoot = new THREE.Group();
  private readonly motionRoot = new THREE.Group();
  private readonly model: PreviewModel;
  private readonly fullBleed: boolean;
  private controls: LoadingUnitPreviewControls = { ...DEFAULT_CONTROLS };
  private boundsRadius = 1;
  private fitHalfWidth = 1;
  private fitHalfHeight = 1;
  private startTime = 0;
  private previousRenderTime = 0;
  private rotationAngle = 0;
  private motionPhase = 0;
  private width = DEFAULT_WIDTH;
  private height = DEFAULT_HEIGHT;
  private environmentTexture: THREE.Texture | null = null;
  private disposed = false;

  constructor(options: LoadingUnitPreviewSceneOptions) {
    this.fullBleed = options.fullBleed;
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power',
      preserveDrawingBuffer: options.preserveDrawingBuffer === true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Match ThreeApp's color pipeline so the preview grades identically to
    // the battlefield. Without ACES the raw colors read more saturated than
    // in-game — that mismatch was why the loading unit's team color looked
    // slightly off.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(this.spinRoot);
    installPreviewLighting(this.scene);
    this.environmentTexture = installPreviewEnvironment(this.renderer, this.scene);

    this.spinRoot.add(this.motionRoot);
    this.model = buildPreviewModel(options.kind, options.blueprintId, this.materials);
    this.centerModel(this.model.root);
    this.motionRoot.add(this.model.root);
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
    const dtMs = this.previousRenderTime > 0 ? Math.min(80, Math.max(0, now - this.previousRenderTime)) : 16.7;
    this.previousRenderTime = now;
    const elapsed = now - this.startTime;
    this.updatePreviewMotion(elapsed, dtMs);
    this.renderer.render(this.scene, this.camera);
  }

  updateControls(controls: Partial<LoadingUnitPreviewControls>): void {
    this.controls = { ...this.controls, ...controls };
  }

  private updatePreviewMotion(elapsed: number, dtMs: number): void {
    const controls = this.controls;
    if (controls.rotate) {
      this.rotationAngle += dtMs * SPIN_RAD_PER_MS * controls.rotationSpeed;
    }
    const motionScale = controls.motion ? controls.motionSpeed : 0;
    if (motionScale > 0) {
      this.motionPhase += (dtMs / 1000) * motionScale;
    }

    this.spinRoot.rotation.y = controls.yaw + this.rotationAngle;
    const idlePitch = controls.pitch + Math.sin(elapsed * 0.00055) * 0.055;
    this.spinRoot.rotation.x = idlePitch;

    const stride = this.motionPhase * Math.PI * 2;
    if (motionScale > 0) {
      const bob = Math.sin(stride * 2) * this.boundsRadius * 0.025;
      const sway = Math.sin(stride) * this.boundsRadius * 0.035;
      this.motionRoot.position.set(sway, bob, 0);
      this.motionRoot.rotation.z = Math.sin(stride) * 0.025;
    } else {
      this.motionRoot.position.set(0, 0, 0);
      this.motionRoot.rotation.z = 0;
    }

    animatePreviewLocomotion(this.model.locomotion, this.motionPhase, motionScale, elapsed / 1000);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.spinRoot.clear();
    this.scene.clear();
    this.renderer.renderLists.dispose();
    disposePreviewUnitMaterials(this.materials);
    this.environmentTexture?.dispose();
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
): PreviewModel {
  return kind === 'unit'
    ? buildPreviewUnitModel(blueprintId as UnitBlueprintId, materials)
    : buildPreviewBuildingModel(blueprintId as StructureBlueprintId, materials);
}

/** Build a static preview of a building/tower, mirroring the in-game
 *  building renderer (BuildingEntityRenderer3D): a team-colored primary
 *  body scaled to the grid footprint + shape height, the type-specific
 *  detail meshes, and any mounted turrets posed at their absolute mounts.
 *  Animation rigs (spinning rotors, scanning radar, etc.) are left static
 *  — the whole model already spins on the loading stage. */
function buildPreviewBuildingModel(
  buildingBlueprintId: StructureBlueprintId,
  materials: PreviewUnitMaterials,
): PreviewModel {
  const blueprint = getBuildingBlueprint(buildingBlueprintId);
  const width = blueprint.gridWidth * BUILD_GRID_CELL_SIZE;
  const depth = blueprint.gridHeight * BUILD_GRID_CELL_SIZE;
  const root = new THREE.Group();

  const shape = buildBuildingShape(
    blueprint.renderProfile,
    width,
    depth,
    materials.primary,
    buildingBlueprintId,
  );
  if (!shape.bodyless) {
    // Match updateBuildingMesh: the primary body sits on the footprint
    // base and scales to (width, shapeHeight, depth).
    shape.primary.position.set(0, shape.height / 2, 0);
    shape.primary.scale.set(width, shape.height, depth);
    root.add(shape.primary);
  }
  for (const detail of shape.details) root.add(detail.mesh);

  buildPreviewBuildingTurrets(root, buildingBlueprintId, materials);
  return { root, locomotion: null };
}

function buildPreviewBuildingTurrets(
  root: THREE.Group,
  buildingBlueprintId: StructureBlueprintId,
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
  unitBlueprintId: UnitBlueprintId,
  materials: PreviewUnitMaterials,
): PreviewModel {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  const radius = blueprint.radius.other;
  const chassisLift = getChassisLiftY(blueprint, radius);
  const root = new THREE.Group();
  const yawGroup = new THREE.Group();
  root.add(yawGroup);

  const locomotion = buildPreviewLocomotion(yawGroup, blueprint, materials);

  const liftGroup = new THREE.Group();
  liftGroup.position.y = chassisLift;
  yawGroup.add(liftGroup);

  const productionRing = getPreviewProductionRing(blueprint, radius, chassisLift);
  buildPreviewBody(liftGroup, blueprint, materials.primary);
  buildPreviewProductionRing(liftGroup, productionRing, materials.primary);
  buildPreviewTurrets(liftGroup, blueprint, unitBlueprintId, chassisLift, materials, productionRing);
  buildPreviewMirrors(liftGroup, blueprint, chassisLift, materials);
  return { root, locomotion };
}

function getPreviewProductionRing(
  blueprint: UnitBlueprint,
  radius: number,
  chassisLift: number,
): PreviewProductionRing | null {
  const spawnMount = blueprint.turrets.find((mount) => mount.producedBlueprintId !== undefined);
  const producedUnitBlueprintId = spawnMount?.producedBlueprintId;
  if (spawnMount === undefined || producedUnitBlueprintId === undefined) return null;
  return {
    producedUnitBlueprintId,
    centerX: spawnMount.mount.x * radius,
    centerY: blueprint.bodyCenterHeight - chassisLift,
    centerZ: spawnMount.mount.y * radius,
    ringRadius: productionHoldRingRadiusForProducedUnit(producedUnitBlueprintId),
    ringOrientation: 'forward',
  };
}

function buildPreviewProductionRing(
  liftGroup: THREE.Group,
  productionRing: PreviewProductionRing | null,
  material: THREE.Material,
): void {
  if (productionRing === null) return;
  const ring = buildProductionHoldRingMesh(
    productionRing.ringRadius,
    material,
    productionRing.ringOrientation,
  );
  ring.position.set(productionRing.centerX, productionRing.centerY, productionRing.centerZ);
  liftGroup.add(ring);
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
  chassis.scale.setScalar(blueprint.radius.other);
  liftGroup.add(chassis);
}

function buildPreviewTurrets(
  liftGroup: THREE.Group,
  blueprint: UnitBlueprint,
  unitBlueprintId: UnitBlueprintId,
  chassisLift: number,
  materials: PreviewUnitMaterials,
  productionRing: PreviewProductionRing | null,
): void {
  const turrets = createUnitRuntimeTurrets(unitBlueprintId, blueprint.radius.other);
  let productionPylonOrdinal = 0;
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
    let mountX = turret.mount.x;
    let mountY = turret.mount.z - chassisLift;
    let mountZ = turret.mount.y;
    if (productionRing !== null && turret.config.constructionEmitter !== null) {
      const side = productionPylonOrdinal === 0 ? -1 : 1;
      mountX = productionRing.centerX;
      mountY = productionRing.centerY;
      mountZ = productionRing.centerZ + productionRing.ringRadius * side;
      productionPylonOrdinal++;
    }
    turretMesh.root.position.set(
      mountX,
      mountY - headRadius,
      mountZ,
    );
    applyTurretAimPose3D(turretMesh, 0, turret.rotation, turret.pitch);
  }
}

function buildPreviewLocomotion(
  yawGroup: THREE.Group,
  blueprint: UnitBlueprint,
  materials: PreviewUnitMaterials,
): PreviewLocomotionRig | null {
  const locomotion = blueprint.unitLocomotion;
  const radius = blueprint.radius.other;
  switch (locomotion.type) {
    case 'treads':
      return { type: 'treads', mesh: buildTreads(yawGroup, radius, locomotion.config, true, HOST_PLAYER_ID) };
    case 'wheels':
      return { type: 'wheels', mesh: buildWheels(yawGroup, radius, locomotion.config, HOST_PLAYER_ID) };
    case 'flippers':
      return {
        type: 'flippers',
        mesh: buildFlippers(yawGroup, radius, locomotion.config, HOST_PLAYER_ID),
      };
    case 'swim':
      return {
        type: 'swim',
        mesh: buildSwimRig(yawGroup, radius, locomotion.config, HOST_PLAYER_ID),
      };
    case 'hover':
      if (blueprint.unitBlueprintId === 'unitAlbatros') {
        return {
          type: 'hover',
          mesh: buildAlbatrosHoverFans(
            yawGroup,
            radius,
            locomotion.config,
            'locomotionAlbatrosHoverFans',
            SHELL_ENTITY_ID,
            HOST_PLAYER_ID,
          ),
        };
      }
      return {
        type: 'hover',
        mesh: buildHoverFans(
          yawGroup,
          radius,
          locomotion.config,
          'locomotionHovercraft',
          SHELL_ENTITY_ID,
          HOST_PLAYER_ID,
        ),
      };
    case 'flying':
      return {
        type: 'flying',
        mesh: buildFlyingRig(
          yawGroup,
          radius,
          locomotion.config,
          blueprint.unitBlueprintId === 'unitAlbatros' ? 'locomotionAlbatrosFlying' : 'locomotionEagleFlying',
          SHELL_ENTITY_ID,
          HOST_PLAYER_ID,
        ),
      };
    case 'legs':
      return { type: 'legs', group: buildPreviewLegs(yawGroup, blueprint, materials.leg) };
  }
  return null;
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

  const turrets = createUnitRuntimeTurrets(blueprint.unitBlueprintId, blueprint.radius.other);
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
): THREE.Group {
  const locomotion = blueprint.unitLocomotion;
  if (locomotion.type !== 'legs') return new THREE.Group();
  const radius = blueprint.radius.other;
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
    const legGroup = new THREE.Group();
    group.add(legGroup);
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
    addCylinderBetween(legGroup, hip, kneeVec, upperRadius, legMaterial);
    addCylinderBetween(legGroup, kneeVec, foot, lowerRadius, legMaterial);
    addSphere(legGroup, hip, hipJointRadius, legMaterial);
    addSphere(legGroup, kneeVec, kneeJointRadius, legMaterial);
    addFootPad(legGroup, foot, footPadRadius, footPadHalfHeight, legMaterial);
  }
  return group;
}

function animatePreviewLocomotion(
  rig: PreviewLocomotionRig | null,
  phase: number,
  motionScale: number,
  timeSec: number,
): void {
  if (rig === null) return;
  const stride = phase * Math.PI * 2;
  const active = motionScale > 0;
  switch (rig.type) {
    case 'wheels':
      animatePreviewWheels(rig.mesh, active ? stride : 0);
      return;
    case 'flippers':
      poseFlippersAtCycle(rig.mesh, active ? stride : 0, 0);
      return;
    case 'swim':
      poseSwimRigAtCycle(rig.mesh, active ? stride : 0);
      return;
    case 'treads':
      animatePreviewTreads(rig.mesh, active ? stride : 0);
      return;
    case 'hover':
      setHoverFanAnimationTime(active ? timeSec * motionScale : 0);
      rig.mesh.group.position.y = active ? Math.sin(stride * 2) * 1.4 : 0;
      return;
    case 'flying':
      rig.mesh.group.rotation.z = active ? Math.sin(stride) * 0.08 : 0;
      rig.mesh.group.rotation.y = active ? Math.sin(stride * 0.7) * 0.035 : 0;
      return;
    case 'legs':
      animatePreviewLegs(rig.group, active ? stride : 0, active);
      return;
  }
}

function animatePreviewWheels(mesh: WheelMesh, stride: number): void {
  for (let i = 0; i < mesh.wheels.length; i++) {
    mesh.wheels[i].rotation.y = -stride * 2.4;
    const group = mesh.wheelGroups[i];
    if (group !== undefined) group.position.y = mesh.wheelMounts[i].wheelR + Math.sin(stride + i) * 0.45;
  }
}

function animatePreviewTreads(mesh: TreadMesh, stride: number): void {
  for (let i = 0; i < mesh.wheels.length; i++) {
    mesh.wheels[i].rotation.y = -stride * 2;
  }
  for (let i = 0; i < mesh.sides.length; i++) {
    mesh.sides[i].group.position.y = Math.sin(stride + i * Math.PI) * 0.35;
  }
  for (let i = 0; i < mesh.cleats.length; i++) {
    const cleat = mesh.cleats[i];
    const userData = cleat.userData as { previewBaseX?: number };
    if (userData.previewBaseX === undefined) userData.previewBaseX = cleat.position.x;
    cleat.position.x = userData.previewBaseX + Math.sin(stride * 1.6 + i * 0.35) * 0.75;
  }
}

function animatePreviewLegs(group: THREE.Group, stride: number, active: boolean): void {
  for (let i = 0; i < group.children.length; i++) {
    const leg = group.children[i];
    if (!active) {
      leg.position.y = 0;
      leg.rotation.z = 0;
      continue;
    }
    const legPhase = stride + i * Math.PI * 0.68;
    leg.position.y = Math.max(0, Math.sin(legPhase)) * 2.6;
    leg.rotation.z = Math.sin(legPhase) * 0.08;
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
