import * as THREE from 'three';
import { getAirLiftProbeDebug } from '@/clientBarConfig';
import type { Entity } from '../sim/types';
import { isBuildInProgress } from '../sim/buildableHelpers';
import { getSurfaceProbePointCount } from '../sim/surfaceProbeSets';
import type { EntityId } from '@/types/sim';
import type { SurfaceLiftProbeDebugFrame } from '@/types/game';
import {
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
} from './PrimitiveGeometryQuality3D';

const INITIAL_INSTANCE_CAPACITY = 16;
const MARKER_RADIUS = 5;
const GROUND_LINE_RADIUS = 3.5;
const WATER_LINE_RADIUS = 0.35;
const MIN_VISIBLE_LINE_LENGTH = 0.01;
const RENDER_ORDER = 92;
const BODY_PROBE_COLOR = new THREE.Color(0xffd447);
const DIRECT_PROBE_COLOR = new THREE.Color(0xff7a36);

export type SurfaceLiftProbeDebugSource = {
  setEntityIds: (entityIds: readonly EntityId[]) => void;
  getFrame: (entityId: EntityId) => SurfaceLiftProbeDebugFrame | undefined;
};

export class SurfaceLiftProbeOverlay3D {
  private readonly root = new THREE.Group();
  private readonly markerGeometry = createPrimitiveSphereGeometry('debug', 'close', MARKER_RADIUS);
  private readonly groundLineGeometry = createPrimitiveCylinderGeometry(
    'debug',
    'close',
    GROUND_LINE_RADIUS,
    GROUND_LINE_RADIUS,
  );
  private readonly waterLineGeometry = createPrimitiveCylinderGeometry(
    'debug',
    'close',
    WATER_LINE_RADIUS,
    WATER_LINE_RADIUS,
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
  private readonly groundLineMaterial = new THREE.MeshBasicMaterial({
    color: 0x8b5a2b,
    transparent: true,
    opacity: 0.82,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly waterLineMaterial = new THREE.MeshBasicMaterial({
    color: 0x2389da,
    transparent: true,
    opacity: 0.72,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly dummy = new THREE.Object3D();
  private markerMesh: THREE.InstancedMesh | null = null;
  private groundLineMesh: THREE.InstancedMesh | null = null;
  private waterLineMesh: THREE.InstancedMesh | null = null;
  private instanceCapacity = 0;

  constructor(
    private readonly parentWorld: THREE.Group,
    private readonly debugSource: SurfaceLiftProbeDebugSource | null,
  ) {
    this.root.visible = false;
    this.ensureCapacity(INITIAL_INSTANCE_CAPACITY);
    parentWorld.add(this.root);
  }

  update(selectedUnits: readonly Entity[]): void {
    if (!getAirLiftProbeDebug()) {
      this.debugSource?.setEntityIds([]);
      this.hide();
      return;
    }

    const probeUnits = selectedUnits.filter(unitShouldShowSurfaceLiftProbes);
    let instanceCount = 0;
    for (const entity of probeUnits) {
      if (entity.unit !== null) {
        instanceCount += getSurfaceProbePointCount(
          entity.unit.locomotion.surfaceFollowing.altitudeProbeSetId,
        );
      }
    }
    if (instanceCount === 0) {
      this.debugSource?.setEntityIds([]);
      this.hide();
      return;
    }

    const debugSource = this.debugSource;
    if (debugSource === null) {
      this.hide();
      return;
    }
    const probeEntityIds = new Array<EntityId>(probeUnits.length);
    for (let i = 0; i < probeUnits.length; i++) probeEntityIds[i] = probeUnits[i].id;
    debugSource.setEntityIds(probeEntityIds);

    // A probe can draw one ground-inverse line plus both water-surface lines.
    this.ensureCapacity(instanceCount * 3);
    const markers = this.markerMesh;
    const groundLines = this.groundLineMesh;
    const waterLines = this.waterLineMesh;
    if (markers === null || groundLines === null || waterLines === null) return;

    let markerCursor = 0;
    let groundLineCursor = 0;
    let waterLineCursor = 0;
    for (let i = 0; i < probeUnits.length; i++) {
      const entity = probeUnits[i];
      const frame = debugSource.getFrame(entity.id);
      if (frame === undefined) continue;
      for (let sampleIndex = 0; sampleIndex < frame.samples.length; sampleIndex++) {
        const sample = frame.samples[sampleIndex];
        const { x, y: z, bodyZ: bodyY } = sample;
        if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(bodyY)) continue;
        this.writeMarkerInstance(
          markers,
          markerCursor,
          x,
          bodyY,
          z,
          sample.isCenter ? DIRECT_PROBE_COLOR : BODY_PROBE_COLOR,
        );
        markerCursor++;
        if (
          sample.usesGroundInverseDistance &&
          this.writeLineInstance(
            groundLines,
            groundLineCursor,
            x,
            bodyY,
            z,
            bodyY - sample.groundInverseDistanceWorld,
          )
        ) {
          groundLineCursor++;
        }
        if (
          sample.usesWaterSurfaceInverseDistance &&
          sample.waterSurfaceInverseDistanceWorld !== null &&
          this.writeLineInstance(
            waterLines,
            waterLineCursor,
            x,
            bodyY,
            z,
            bodyY - sample.waterSurfaceInverseDistanceWorld,
          )
        ) {
          waterLineCursor++;
        }
        if (
          sample.usesWaterSurfaceDepth &&
          sample.waterSurfaceDepthWorld !== null &&
          this.writeLineInstance(
            waterLines,
            waterLineCursor,
            x,
            bodyY,
            z,
            bodyY + sample.waterSurfaceDepthWorld,
          )
        ) {
          waterLineCursor++;
        }
      }
    }

    markers.count = markerCursor;
    groundLines.count = groundLineCursor;
    waterLines.count = waterLineCursor;
    markers.instanceMatrix.needsUpdate = true;
    groundLines.instanceMatrix.needsUpdate = true;
    waterLines.instanceMatrix.needsUpdate = true;
    if (markers.instanceColor !== null) markers.instanceColor.needsUpdate = true;
    this.root.visible = markerCursor > 0;
    markers.visible = markerCursor > 0;
    groundLines.visible = groundLineCursor > 0;
    waterLines.visible = waterLineCursor > 0;
  }

  destroy(): void {
    this.debugSource?.setEntityIds([]);
    this.parentWorld.remove(this.root);
    this.markerGeometry.dispose();
    this.groundLineGeometry.dispose();
    this.waterLineGeometry.dispose();
    this.markerMaterial.dispose();
    this.groundLineMaterial.dispose();
    this.waterLineMaterial.dispose();
  }

  private hide(): void {
    this.root.visible = false;
    if (this.markerMesh) this.markerMesh.visible = false;
    if (this.groundLineMesh) this.groundLineMesh.visible = false;
    if (this.waterLineMesh) this.waterLineMesh.visible = false;
  }

  private ensureCapacity(required: number): void {
    if (
      required <= this.instanceCapacity &&
      this.markerMesh !== null &&
      this.groundLineMesh !== null &&
      this.waterLineMesh !== null
    ) {
      return;
    }
    let next = Math.max(INITIAL_INSTANCE_CAPACITY, this.instanceCapacity);
    while (next < required) next *= 2;
    if (this.markerMesh !== null) this.root.remove(this.markerMesh);
    if (this.groundLineMesh !== null) this.root.remove(this.groundLineMesh);
    if (this.waterLineMesh !== null) this.root.remove(this.waterLineMesh);
    this.markerMesh = new THREE.InstancedMesh(this.markerGeometry, this.markerMaterial, next);
    this.groundLineMesh = new THREE.InstancedMesh(
      this.groundLineGeometry,
      this.groundLineMaterial,
      next,
    );
    this.waterLineMesh = new THREE.InstancedMesh(
      this.waterLineGeometry,
      this.waterLineMaterial,
      next,
    );
    this.markerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.groundLineMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.waterLineMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.markerMesh.frustumCulled = false;
    this.groundLineMesh.frustumCulled = false;
    this.waterLineMesh.frustumCulled = false;
    this.markerMesh.renderOrder = RENDER_ORDER + 1;
    this.groundLineMesh.renderOrder = RENDER_ORDER - 1;
    this.waterLineMesh.renderOrder = RENDER_ORDER;
    this.markerMesh.visible = false;
    this.groundLineMesh.visible = false;
    this.waterLineMesh.visible = false;
    this.root.add(this.groundLineMesh, this.waterLineMesh, this.markerMesh);
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
  ): boolean {
    const dy = surfaceY - bodyY;
    const length = Math.abs(dy);
    if (!Number.isFinite(length) || length < MIN_VISIBLE_LINE_LENGTH) return false;
    this.dummy.position.set(x, bodyY + dy * 0.5, z);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(1, length, 1);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
    return true;
  }
}

function unitShouldShowSurfaceLiftProbes(entity: Entity): boolean {
  const unit = entity.unit;
  if (unit === null) return false;
  if (isBuildInProgress(entity.buildable)) return false;
  return unit.locomotion.physics.air.lift.surfaceFollowingInverseForceFromGround > 0 ||
    unit.locomotion.physics.air.lift.surfaceFollowingInverseForceFromWater > 0 ||
    unit.locomotion.physics.water.lift.surfaceFollowingInverseForceFromGround > 0 ||
    unit.locomotion.physics.water.lift.surfaceFollowingProportionalForceFromWater > 0;
}
