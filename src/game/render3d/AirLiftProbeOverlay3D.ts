import * as THREE from 'three';
import { getAirLiftProbeDebug } from '@/clientBarConfig';
import { WATER_LEVEL } from '../sim/Terrain';
import type { Entity } from '../sim/types';
import { isBuildInProgress } from '../sim/buildableHelpers';
import { createWorldSupportSurface } from '../sim/supportSurface';
import { sampleLocomotionSupportSurface } from './LocomotionTerrainSampler';
import {
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
} from './PrimitiveGeometryQuality3D';

const FORWARD_PROBE_COUNT = 5;
const INITIAL_INSTANCE_CAPACITY = 16;
const THRUST_DIRECTION_EPSILON_SQ = 0.0001;
const MARKER_RADIUS = 5;
const LINE_RADIUS = 1.25;
const MIN_LINE_LENGTH = 0.5;
const SURFACE_LIFT = 0.8;
const RENDER_ORDER = 92;

export class AirLiftProbeOverlay3D {
  private readonly root = new THREE.Group();
  private readonly markerGeometry = createPrimitiveSphereGeometry('debug', 'close', MARKER_RADIUS);
  private readonly lineGeometry = createPrimitiveCylinderGeometry(
    'debug',
    'close',
    LINE_RADIUS,
    LINE_RADIUS,
  );
  private readonly markerMaterial = new THREE.MeshBasicMaterial({
    color: 0x36e6ff,
    transparent: true,
    opacity: 0.88,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly lineMaterial = new THREE.MeshBasicMaterial({
    color: 0x36e6ff,
    transparent: true,
    opacity: 0.58,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly supportScratch = createWorldSupportSurface();
  private readonly dummy = new THREE.Object3D();
  private markerMesh: THREE.InstancedMesh | null = null;
  private lineMesh: THREE.InstancedMesh | null = null;
  private instanceCapacity = 0;

  constructor(
    private readonly parentWorld: THREE.Group,
    private readonly mapWidth: number,
    private readonly mapHeight: number,
  ) {
    this.root.visible = false;
    this.ensureCapacity(INITIAL_INSTANCE_CAPACITY);
    parentWorld.add(this.root);
  }

  update(selectedUnits: readonly Entity[]): void {
    if (!getAirLiftProbeDebug()) {
      this.hide();
      return;
    }

    const probeUnits = selectedUnits.filter(unitShouldShowAirLiftProbes);
    const instanceCount = probeUnits.length * FORWARD_PROBE_COUNT;
    if (instanceCount === 0) {
      this.hide();
      return;
    }

    this.ensureCapacity(instanceCount);
    const markers = this.markerMesh;
    const lines = this.lineMesh;
    if (markers === null || lines === null) return;

    let cursor = 0;
    for (let i = 0; i < probeUnits.length; i++) {
      const entity = probeUnits[i];
      const unit = entity.unit;
      if (unit === null) continue;
      const direction = probeDirection(entity);
      if (direction === null) continue;
      const aheadDistance =
        unit.locomotion.airLiftGroundProbeAheadDistance +
        unit.radius.collision * unit.locomotion.airLiftGroundProbeAheadRadiusMultiplier;
      if (!Number.isFinite(aheadDistance) || aheadDistance <= 0) continue;

      for (let step = 1; step <= FORWARD_PROBE_COUNT; step++) {
        const t = step / FORWARD_PROBE_COUNT;
        const x = entity.transform.x + direction.x * aheadDistance * t;
        const z = entity.transform.y + direction.y * aheadDistance * t;
        const bodyY = entity.transform.z;
        if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(bodyY)) continue;

        const support = sampleLocomotionSupportSurface(
          x,
          z,
          this.mapWidth,
          this.mapHeight,
          undefined,
          undefined,
          entity.id,
          this.supportScratch,
        );
        const surfaceY = Math.max(support.groundZ, WATER_LEVEL) + SURFACE_LIFT;
        this.writeMarkerInstance(markers, cursor, x, bodyY, z);
        this.writeLineInstance(lines, cursor, x, bodyY, z, surfaceY);
        cursor++;
      }
    }

    markers.count = cursor;
    lines.count = cursor;
    markers.instanceMatrix.needsUpdate = true;
    lines.instanceMatrix.needsUpdate = true;
    this.root.visible = cursor > 0;
    markers.visible = cursor > 0;
    lines.visible = cursor > 0;
  }

  destroy(): void {
    this.parentWorld.remove(this.root);
    this.markerGeometry.dispose();
    this.lineGeometry.dispose();
    this.markerMaterial.dispose();
    this.lineMaterial.dispose();
  }

  private hide(): void {
    this.root.visible = false;
    if (this.markerMesh) this.markerMesh.visible = false;
    if (this.lineMesh) this.lineMesh.visible = false;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.instanceCapacity && this.markerMesh !== null && this.lineMesh !== null) {
      return;
    }
    let next = Math.max(INITIAL_INSTANCE_CAPACITY, this.instanceCapacity);
    while (next < required) next *= 2;
    if (this.markerMesh !== null) this.root.remove(this.markerMesh);
    if (this.lineMesh !== null) this.root.remove(this.lineMesh);
    this.markerMesh = new THREE.InstancedMesh(this.markerGeometry, this.markerMaterial, next);
    this.lineMesh = new THREE.InstancedMesh(this.lineGeometry, this.lineMaterial, next);
    this.markerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lineMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.markerMesh.frustumCulled = false;
    this.lineMesh.frustumCulled = false;
    this.markerMesh.renderOrder = RENDER_ORDER;
    this.lineMesh.renderOrder = RENDER_ORDER - 1;
    this.markerMesh.visible = false;
    this.lineMesh.visible = false;
    this.root.add(this.lineMesh, this.markerMesh);
    this.instanceCapacity = next;
  }

  private writeMarkerInstance(
    mesh: THREE.InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
  ): void {
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.setScalar(1);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }

  private writeLineInstance(
    mesh: THREE.InstancedMesh,
    index: number,
    x: number,
    bodyY: number,
    z: number,
    surfaceY: number,
  ): void {
    const dy = surfaceY - bodyY;
    const length = Math.max(MIN_LINE_LENGTH, Math.abs(dy));
    this.dummy.position.set(x, bodyY + dy * 0.5, z);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(1, length, 1);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }
}

function unitShouldShowAirLiftProbes(entity: Entity): boolean {
  const unit = entity.unit;
  if (unit === null) return false;
  if (isBuildInProgress(entity.buildable)) return false;
  const locomotion = unit.locomotion;
  if (locomotion.type !== 'hover' && locomotion.type !== 'flying') return false;
  const air = locomotion.physics.air;
  const airLiftAuthored =
    air.gravityCounterUpwardForceRatio > 0 ||
    air.heightUpwardForce > 0;
  if (!airLiftAuthored) return false;
  const aheadDistance =
    locomotion.airLiftGroundProbeAheadDistance +
    unit.radius.collision * locomotion.airLiftGroundProbeAheadRadiusMultiplier;
  return Number.isFinite(aheadDistance) && aheadDistance > 0;
}

function probeDirection(entity: Entity): { x: number; y: number } | null {
  const unit = entity.unit;
  if (unit === null) return null;
  const yaw = Number.isFinite(entity.transform.rotation) ? entity.transform.rotation : 0;
  const dirX = Number.isFinite(unit.thrustDirX) ? unit.thrustDirX : 0;
  const dirY = Number.isFinite(unit.thrustDirY) ? unit.thrustDirY : 0;
  const lenSq = dirX * dirX + dirY * dirY;
  if (!unit.locomotion.forwardForceRequiresFacing) {
    if (lenSq > THRUST_DIRECTION_EPSILON_SQ) {
      const invLen = 1 / Math.sqrt(lenSq);
      return { x: dirX * invLen, y: dirY * invLen };
    }
    const velX = Number.isFinite(unit.velocityX) ? unit.velocityX : 0;
    const velY = Number.isFinite(unit.velocityY) ? unit.velocityY : 0;
    const velLenSq = velX * velX + velY * velY;
    if (velLenSq > THRUST_DIRECTION_EPSILON_SQ) {
      const invLen = 1 / Math.sqrt(velLenSq);
      return { x: velX * invLen, y: velY * invLen };
    }
  }
  return { x: Math.cos(yaw), y: Math.sin(yaw) };
}
