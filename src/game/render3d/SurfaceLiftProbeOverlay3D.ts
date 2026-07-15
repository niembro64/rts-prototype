import * as THREE from 'three';
import { getAirLiftProbeDebug } from '@/clientBarConfig';
import { WATER_LEVEL, isWaterAt } from '../sim/Terrain';
import type { Entity } from '../sim/types';
import { isBuildInProgress } from '../sim/buildableHelpers';
import { createWorldSupportSurface } from '../sim/supportSurface';
import {
  type SurfaceProbePointRole,
  forEachSurfaceProbePoint,
  getSurfaceProbePointCount,
} from '../sim/surfaceProbeSets';
import { sampleLocomotionSupportSurface } from './LocomotionTerrainSampler';
import {
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
} from './PrimitiveGeometryQuality3D';

const INITIAL_INSTANCE_CAPACITY = 16;
const THRUST_DIRECTION_EPSILON_SQ = 0.0001;
const MARKER_RADIUS = 5;
const LINE_RADIUS = 1.25;
const MIN_LINE_LENGTH = 0.5;
const SURFACE_LIFT = 0.8;
const RENDER_ORDER = 92;
const FORWARD_PROBE_COLOR = new THREE.Color(0x36e6ff);
const BODY_PROBE_COLOR = new THREE.Color(0xffd447);
const DIRECT_PROBE_COLOR = new THREE.Color(0xff7a36);
const WATER_SURFACE_PROBE_COLOR = new THREE.Color(0x3d8dff);

export class SurfaceLiftProbeOverlay3D {
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
    vertexColors: true,
    transparent: true,
    opacity: 0.88,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly lineMaterial = new THREE.MeshBasicMaterial({
    color: 0x36e6ff,
    vertexColors: true,
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

    const probeUnits = selectedUnits.filter(unitShouldShowSurfaceLiftProbes);
    let instanceCount = 0;
    for (const entity of probeUnits) {
      if (entity.unit !== null) {
        instanceCount += getSurfaceProbePointCount(entity.unit.locomotion.surfaceProbeSetId);
      }
    }
    if (instanceCount === 0) {
      this.hide();
      return;
    }

    this.ensureCapacity(instanceCount * 2);
    const markers = this.markerMesh;
    const lines = this.lineMesh;
    if (markers === null || lines === null) return;

    let markerCursor = 0;
    let lineCursor = 0;
    for (let i = 0; i < probeUnits.length; i++) {
      const entity = probeUnits[i];
      const unit = entity.unit;
      if (unit === null) continue;
      const direction = probeDirection(entity);
      if (direction === null) continue;
      const probeRadius = unitProbeRadius(unit);
      const samplesGroundSurface =
        unit.locomotion.physics.air.lift.liftForceFromGroundSurface > 0 ||
        unit.locomotion.physics.water.lift.liftForceFromGroundSurface > 0;
      const samplesWaterSurface =
        unit.locomotion.physics.air.lift.liftForceFromWaterSurface > 0;

      const bodyY = entity.transform.z;
      if (!Number.isFinite(bodyY)) continue;
      forEachSurfaceProbePoint(
        unit.locomotion.surfaceProbeSetId,
        entity.transform.x,
        entity.transform.y,
        direction.x,
        direction.y,
        probeRadius,
        (x, z, role) => {
          if (!Number.isFinite(x) || !Number.isFinite(z)) return;

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
          const color = probeColor(role);
          this.writeMarkerInstance(markers, markerCursor, x, bodyY, z, color);
          markerCursor++;
          if (samplesGroundSurface) {
            this.writeLineInstance(
              lines,
              lineCursor,
              x,
              bodyY,
              z,
              support.groundZ + SURFACE_LIFT,
              color,
            );
            lineCursor++;
          }
          if (samplesWaterSurface && isWaterAt(x, z, this.mapWidth, this.mapHeight)) {
            this.writeLineInstance(
              lines,
              lineCursor,
              x,
              bodyY,
              z,
              WATER_LEVEL + SURFACE_LIFT,
              WATER_SURFACE_PROBE_COLOR,
            );
            lineCursor++;
          }
        },
      );
    }

    markers.count = markerCursor;
    lines.count = lineCursor;
    markers.instanceMatrix.needsUpdate = true;
    lines.instanceMatrix.needsUpdate = true;
    if (markers.instanceColor !== null) markers.instanceColor.needsUpdate = true;
    if (lines.instanceColor !== null) lines.instanceColor.needsUpdate = true;
    this.root.visible = markerCursor > 0;
    markers.visible = markerCursor > 0;
    lines.visible = lineCursor > 0;
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
    color: THREE.Color,
  ): void {
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.setScalar(1);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
    mesh.setColorAt(index, color);
  }

  private writeLineInstance(
    mesh: THREE.InstancedMesh,
    index: number,
    x: number,
    bodyY: number,
    z: number,
    surfaceY: number,
    color: THREE.Color,
  ): void {
    const dy = surfaceY - bodyY;
    const length = Math.max(MIN_LINE_LENGTH, Math.abs(dy));
    this.dummy.position.set(x, bodyY + dy * 0.5, z);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(1, length, 1);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
    mesh.setColorAt(index, color);
  }
}

function unitShouldShowSurfaceLiftProbes(entity: Entity): boolean {
  const unit = entity.unit;
  if (unit === null) return false;
  if (isBuildInProgress(entity.buildable)) return false;
  return unit.locomotion.physics.air.lift.liftForceFromGroundSurface > 0 ||
    unit.locomotion.physics.air.lift.liftForceFromWaterSurface > 0 ||
    unit.locomotion.physics.water.lift.liftForceFromGroundSurface > 0;
}

function unitProbeRadius(unit: NonNullable<Entity['unit']>): number {
  return firstFinitePositive(unit.radius.collision, unit.radius.hitbox, unit.radius.other, 10);
}

function firstFinitePositive(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 0;
}

function probeColor(role: SurfaceProbePointRole): THREE.Color {
  if (role === 'center') return DIRECT_PROBE_COLOR;
  if (role === 'forward') return FORWARD_PROBE_COLOR;
  return BODY_PROBE_COLOR;
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
