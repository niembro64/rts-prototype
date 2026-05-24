import * as THREE from 'three';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { FlyingSmokeUseId, HoverSmokeUseId } from '@/smokeConfig';
import type { BuildableUnitId } from '@/game/sim/blueprints';
import {
  BUILDABLE_UNIT_IDS,
  getUnitBlueprint,
} from '@/game/sim/blueprints';
import { createUnitRuntimeTurrets } from '@/game/sim/runtimeTurrets';
import type { UnitBlueprint } from '@/types/blueprints';
import { getTurretHeadRadius } from '@/game/math';
import { getSegmentMidYAt } from '@/game/math/BodyDimensions';
import { resolveMirroredLegConfigs } from '@/game/math/LegLayout';
import { getBodyGeom } from '@/game/render3d/BodyShape3D';
import { buildFlyingRig } from '@/game/render3d/FlyingRig3D';
import { buildHoverFans } from '@/game/render3d/HoverRig3D';
import { getChassisLift } from '@/game/render3d/Locomotion3D';
import { kneeFromIK } from '@/game/render3d/LocomotionRigShared3D';
import { createShellMaterial } from '@/game/render3d/ShellMaterial';
import { buildTreads } from '@/game/render3d/TreadRig3D';
import { buildTurretMesh3D } from '@/game/render3d/TurretMesh3D';
import { buildWheels } from '@/game/render3d/WheelRig3D';

export type LoadingUnitPreviewSelection = {
  id: BuildableUnitId;
  name: string;
};

export type LoadingUnitPreviewRuntime = {
  destroy: () => void;
};

export type LoadingUnitPreviewOptions = {
  fullBleed?: boolean;
};

const PREVIEW_ENTITY_ID = 0;
const PREVIEW_ROTATION_RAD_PER_SEC = 0.82;
const FULL_BLEED_FPS = 12;
const CAMERA_FOV_DEG = 33;
const CAMERA_DIR = new THREE.Vector3(1.35, 0.86, 1.7).normalize();

export function pickRandomLoadingUnit(): LoadingUnitPreviewSelection {
  const unitIds = BUILDABLE_UNIT_IDS;
  const selected = unitIds[Math.floor(Math.random() * unitIds.length)] ?? unitIds[0];
  const blueprint = getUnitBlueprint(selected);
  return { id: selected, name: blueprint.name };
}

export function mountLoadingUnitPreview(
  host: HTMLElement,
  unitId: BuildableUnitId,
  options: LoadingUnitPreviewOptions = {},
): LoadingUnitPreviewRuntime {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.1, 10000);
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: options.fullBleed !== true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.fullBleed === true ? 1 : 1.5));
  renderer.domElement.className = 'loader-unit-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);

  const ownedGeometries: THREE.BufferGeometry[] = [];
  const shellMaterial = createShellMaterial();
  const model = buildLoadingUnitModel(unitId, shellMaterial, ownedGeometries);
  const spinRoot = new THREE.Group();
  spinRoot.add(model);
  scene.add(spinRoot);

  const bounds = centerModel(model);
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  let frameId = 0;
  let timerId = 0;
  let destroyed = false;
  let lastTime = performance.now();
  let lastRenderTime = 0;

  function resize(): void {
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    fitCamera(camera, bounds, width / height, options.fullBleed === true);
  }

  const resizeObserver = new ResizeObserver(() => {
    resize();
    renderer.render(scene, camera);
  });
  resizeObserver.observe(host);
  resize();

  function scheduleFrame(delayMs = 0): void {
    if (destroyed) return;
    if (delayMs > 0) {
      timerId = window.setTimeout(() => {
        timerId = 0;
        frameId = window.requestAnimationFrame(animate);
      }, delayMs);
      return;
    }
    frameId = window.requestAnimationFrame(animate);
  }

  function animate(now: number): void {
    if (destroyed) return;
    const minFrameMs = options.fullBleed === true ? 1000 / FULL_BLEED_FPS : 0;
    if (minFrameMs > 0 && now - lastRenderTime < minFrameMs) {
      scheduleFrame(minFrameMs - (now - lastRenderTime));
      return;
    }
    const dt = Math.min(0.12, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    lastRenderTime = now;
    if (!reducedMotion) {
      spinRoot.rotation.y += dt * PREVIEW_ROTATION_RAD_PER_SEC;
    }
    renderer.render(scene, camera);
    scheduleFrame(minFrameMs);
  }
  scheduleFrame();

  return {
    destroy: () => {
      destroyed = true;
      window.cancelAnimationFrame(frameId);
      if (timerId !== 0) window.clearTimeout(timerId);
      resizeObserver.disconnect();
      if (renderer.domElement.parentElement === host) {
        host.removeChild(renderer.domElement);
      }
      renderer.dispose();
      shellMaterial.dispose();
      for (const geometry of ownedGeometries) geometry.dispose();
    },
  };
}

function buildLoadingUnitModel(
  unitId: BuildableUnitId,
  shellMaterial: THREE.Material,
  ownedGeometries: THREE.BufferGeometry[],
): THREE.Group {
  const blueprint = getUnitBlueprint(unitId);
  const radius = blueprint.radius.body;
  const root = new THREE.Group();
  const yawGroup = new THREE.Group();
  root.add(yawGroup);

  buildPreviewLocomotion(yawGroup, blueprint, radius, shellMaterial, ownedGeometries);

  const liftGroup = new THREE.Group();
  const chassisLift = getChassisLift(blueprint, radius);
  liftGroup.position.y = chassisLift;
  yawGroup.add(liftGroup);

  const chassis = new THREE.Group();
  chassis.scale.setScalar(radius);
  const bodyEntry = getBodyGeom(blueprint.bodyShape);
  for (const part of bodyEntry.parts) {
    const mesh = new THREE.Mesh(part.geometry, shellMaterial);
    mesh.position.set(part.x, part.y, part.z);
    mesh.scale.set(part.scaleX, part.scaleY, part.scaleZ);
    if (part.rotZ) mesh.rotation.z = part.rotZ;
    chassis.add(mesh);
  }
  liftGroup.add(chassis);

  const turrets = createUnitRuntimeTurrets(unitId, radius);
  const gfx = getGraphicsConfig();
  const turretHeadGeom = new THREE.SphereGeometry(1, 16, 12);
  const barrelGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  const coneBarrelGeom = new THREE.CylinderGeometry(0, 1, 1, 10);
  ownedGeometries.push(turretHeadGeom, barrelGeom, coneBarrelGeom);

  for (const turret of turrets) {
    const turretMesh = buildTurretMesh3D(liftGroup, turret, gfx, {
      headGeom: turretHeadGeom,
      barrelGeom,
      coneBarrelGeom,
      primaryMat: shellMaterial,
      turretAccentMat: shellMaterial,
    });
    const headRadius = turretMesh.headRadius ?? getTurretHeadRadius(turret.config);
    turretMesh.root.position.set(
      turret.mount.x,
      turret.mount.z - chassisLift - headRadius,
      turret.mount.y,
    );
  }

  applyMaterial(root, shellMaterial);
  return root;
}

function buildPreviewLocomotion(
  parent: THREE.Group,
  blueprint: UnitBlueprint,
  radius: number,
  shellMaterial: THREE.Material,
  ownedGeometries: THREE.BufferGeometry[],
): void {
  const locomotion = blueprint.locomotion;
  switch (locomotion.type) {
    case 'wheels':
      buildWheels(parent, radius, locomotion.config, undefined);
      return;
    case 'treads':
      buildTreads(parent, radius, locomotion.config, true, undefined);
      return;
    case 'hover':
      buildHoverFans(
        parent,
        radius,
        locomotion.config,
        hoverSmokeUseId(blueprint.locomotionId),
        PREVIEW_ENTITY_ID,
        undefined,
      );
      return;
    case 'flying':
      buildFlyingRig(parent, radius, locomotion.config, flyingSmokeUseId(), PREVIEW_ENTITY_ID, undefined);
      return;
    case 'legs':
      buildStaticLegs(parent, blueprint, radius, shellMaterial, ownedGeometries);
      return;
  }
}

function buildStaticLegs(
  parent: THREE.Group,
  blueprint: UnitBlueprint,
  radius: number,
  shellMaterial: THREE.Material,
  ownedGeometries: THREE.BufferGeometry[],
): void {
  if (blueprint.locomotion.type !== 'legs') return;
  const legGroup = new THREE.Group();
  parent.add(legGroup);
  const cylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 8);
  const jointGeom = new THREE.SphereGeometry(1, 10, 8);
  ownedGeometries.push(cylinderGeom, jointGeom);

  const chassisLift = getChassisLift(blueprint, radius);
  const { all: legs } = resolveMirroredLegConfigs(blueprint.locomotion.config, radius);
  const upperThickness = Math.max(blueprint.locomotion.config.upperThickness, 1) * 0.6;
  const lowerThickness = Math.max(blueprint.locomotion.config.lowerThickness, 1) * 0.6;

  for (const leg of legs) {
    const hipY = blueprint.legAttachHeightFrac !== null
      ? blueprint.legAttachHeightFrac * radius
      : chassisLift + getSegmentMidYAt(blueprint.bodyShape, radius, leg.attachOffsetX);
    const totalLength = leg.upperLegLength + leg.lowerLegLength;
    const restDistance = totalLength * leg.snapDistanceMultiplier;
    const hip = new THREE.Vector3(leg.attachOffsetX, hipY, leg.attachOffsetY);
    const foot = new THREE.Vector3(
      leg.attachOffsetX + Math.cos(leg.snapTargetAngle) * restDistance,
      0.8,
      leg.attachOffsetY + Math.sin(leg.snapTargetAngle) * restDistance,
    );
    const kneeData = kneeFromIK(
      hip.x, hip.y, hip.z,
      foot.x, foot.y, foot.z,
      leg.upperLegLength,
      leg.lowerLegLength,
      0, 1, 0,
    );
    const knee = new THREE.Vector3(kneeData.x, kneeData.y, kneeData.z);
    addCylinderBetween(legGroup, cylinderGeom, shellMaterial, hip, knee, upperThickness);
    addCylinderBetween(legGroup, cylinderGeom, shellMaterial, knee, foot, lowerThickness);
    addJoint(legGroup, jointGeom, shellMaterial, hip, Math.max(1, blueprint.locomotion.config.hipRadius));
    addJoint(legGroup, jointGeom, shellMaterial, knee, Math.max(1, blueprint.locomotion.config.kneeRadius));
    addJoint(legGroup, jointGeom, shellMaterial, foot, Math.max(1.1, lowerThickness * 1.2));
  }
}

function addCylinderBetween(
  parent: THREE.Group,
  geometry: THREE.CylinderGeometry,
  material: THREE.Material,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
): void {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  if (length < 1e-4) return;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(radius, length, radius);
  mesh.position.copy(start).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  parent.add(mesh);
}

function addJoint(
  parent: THREE.Group,
  geometry: THREE.SphereGeometry,
  material: THREE.Material,
  position: THREE.Vector3,
  radius: number,
): void {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.scale.setScalar(radius);
  parent.add(mesh);
}

function applyMaterial(root: THREE.Object3D, material: THREE.Material): void {
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh === true) {
      (object as THREE.Mesh).material = material;
    }
  });
}

function centerModel(model: THREE.Object3D): THREE.Box3 {
  const bounds = new THREE.Box3().setFromObject(model);
  const center = new THREE.Vector3();
  bounds.getCenter(center);
  model.position.sub(center);
  const recenteredBounds = new THREE.Box3().setFromObject(model);
  const minY = recenteredBounds.min.y;
  model.position.y -= minY;
  return new THREE.Box3().setFromObject(model);
}

function fitCamera(
  camera: THREE.PerspectiveCamera,
  bounds: THREE.Box3,
  aspect: number,
  fullBleed: boolean,
): void {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);
  const maxHorizontal = fullBleed
    ? Math.hypot(size.x, size.z)
    : Math.max(size.x, size.z);
  const reservedBottomFraction = fullBleed ? 0.3 : 0;
  const usableAspect = aspect * (fullBleed ? 1 - reservedBottomFraction : 1);
  const maxVertical = Math.max(size.y, maxHorizontal / Math.max(0.7, usableAspect));
  const distance = (maxVertical * 0.5) / Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG) * 0.5);
  const fullBleedDistanceMultiplier = aspect < 0.75 ? 2.15 : 1.68;
  const paddedDistance = Math.max(
    fullBleed ? 8 : 28,
    distance * (fullBleed ? fullBleedDistanceMultiplier : 1.78),
  );
  camera.aspect = aspect;
  const cameraTarget = new THREE.Vector3(
    center.x,
    center.y + size.y * (fullBleed ? (aspect < 0.75 ? -0.12 : -0.25) : 0.08),
    center.z,
  );
  camera.position.copy(CAMERA_DIR).multiplyScalar(paddedDistance).add(cameraTarget);
  camera.near = Math.max(0.1, paddedDistance - maxVertical * 5);
  camera.far = paddedDistance + maxVertical * 6;
  camera.lookAt(cameraTarget);
  camera.updateProjectionMatrix();
}

function hoverSmokeUseId(locomotionId: string): HoverSmokeUseId {
  return locomotionId === 'dragonflyHovercraft'
    ? 'dragonflyHovercraft'
    : 'hovercraft';
}

function flyingSmokeUseId(): FlyingSmokeUseId {
  return 'eagleFlying';
}
