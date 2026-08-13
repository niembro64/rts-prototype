// BeamRenderer3D — renders beam and laser projectiles as thin 3D cylinders.
//
// ClientViewState receives authoritative start/end/reflections (including z)
// from the host snapshots. This renderer reads those fields and draws one
// cylinder per path segment using each segment's real altitude, so reflected
// beam visuals match the server collision path without client-side tracing.
//
// Beam cylinders are drawn through two visual InstancedMesh layers. Each live
// path segment writes one outer matrix and one smaller inner matrix, so a
// beam-heavy fight stays two segment draw calls instead of one mesh/material
// draw per segment.

import * as THREE from 'three';
import type { BeamPoint, Entity } from '../sim/types';
import { isRayType } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { GraphicsConfig } from '@/types/graphics';
import { BEAM_SNAP_ORIGIN_TO_TURRET } from '@/config';
import { detachObject, disposeMesh } from './threeUtils';
import { uploadPrefixRange } from './instancedBufferUpdate';
import beamConfig from '@/beamConfig.json';
import { getSmokeProfile } from '@/smokeConfig';
import {
  BEAM_INNER_VISUAL_CONFIG,
  BEAM_LAYER_INNER_SCALE,
  BEAM_OUTER_VISUAL_CONFIG,
  BEAM_SEGMENT_VERTEX_SHADER,
  BEAM_WAVE_TIME,
  beamWaveFlowPhase,
  beamWaveFlowRepeats,
  createBeamSegmentFragmentShader,
  tickBeamWaveTime,
  type BeamVisualConfig,
} from './BeamWaveVisual3D';
import {
  createPrimitiveCylinderGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import type { SmokePuffEmitter } from './SmokeTrail3D';
import type { RenderViewState3D } from './RenderFrameState3D';
import { entityDetailLevelForView } from './EntityLod3D';
import {
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_MID,
  detailRungForLevel,
  type DetailRung,
} from './EntityDetailLevel3D';

// Visual tuning (color, wave alpha range, wave spacing/speed) lives in
// beamConfig.json + colorsConfig.json and is resolved by BeamWaveVisual3D —
// edit those files to retune how beams look. Beam cylinders originate at
// the selected rendered QueryWeapon muzzle, matching the authoritative path.
const BEAM_SEGMENT_CAP = 8192;
const BEAM_ENDPOINT_SMOKE_EMITTER_CAP = 4096;
const BEAM_IMPOSTER_SEGMENT_CAP = BEAM_SEGMENT_CAP;
const BEAM_MIN_RADIUS = 0.35;
const BEAM_RADIUS_SCALE = 0.55;
const DEFAULT_OPEN_ENDED_LINE_VISUAL_LENGTH = 12000;
const DEFAULT_IMPOSTER_SEGMENT_COLOR = 0xd7f4ff;
const DEFAULT_IMPOSTER_MIN_SCREEN_RADIUS_PX = 0.9;

type TurretMountResolver = {
  getTurretMountWorldState(
    entityId: number,
    turretIdx: number,
    emissionLaneIdx?: number,
  ): {
    x: number; y: number; z: number;
    forwardX: number; forwardY: number; forwardZ: number;
    hasForward: boolean;
    vx: number; vy: number; vz: number;
    ax: number; ay: number; az: number;
  } | null;
};

type OpenEndedLineConfig = {
  extendToInfinity: boolean;
  infinityVisualLength: number;
};

type BeamImposterSegmentConfig = {
  enabled: boolean;
  color: number;
  minScreenRadiusPx: number;
};

type BeamStaggeredPathUpdateConfig = {
  bucketCount: number;
};

type BeamConfigFile = {
  openEndedLine?: Partial<OpenEndedLineConfig>;
  imposterSegment?: Partial<BeamImposterSegmentConfig>;
  staggeredPathUpdates?: Partial<BeamStaggeredPathUpdateConfig>;
};

type BeamEmissionLodResolver = (entity: Entity) => boolean;
type BeamDetailRungResolver = (entity: Entity) => DetailRung;

export type BeamSegmentPoseScratch3D = {
  a: THREE.Vector3;
  b: THREE.Vector3;
  mid: THREE.Vector3;
  direction: THREE.Vector3;
  up: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
};

export function createBeamSegmentPoseScratch3D(): BeamSegmentPoseScratch3D {
  return {
    a: new THREE.Vector3(),
    b: new THREE.Vector3(),
    mid: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(),
  };
}

/** Geometry-independent beam pose shared by High, Medium, and Low segments. */
export function composeBeamSegmentMatrix3D(
  out: THREE.Matrix4,
  scratch: BeamSegmentPoseScratch3D,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cylinderRadius: number,
  length: number,
): THREE.Matrix4 {
  // sim-(x, y, z) maps to three-(x, z, y).
  scratch.a.set(ax, az, ay);
  scratch.b.set(bx, bz, by);
  scratch.mid.copy(scratch.a).lerp(scratch.b, 0.5);
  scratch.direction.copy(scratch.b).sub(scratch.a);
  if (length > 1e-5) scratch.direction.multiplyScalar(1 / length);
  else scratch.direction.set(1, 0, 0);
  scratch.quaternion.setFromUnitVectors(scratch.up, scratch.direction);
  scratch.scale.set(cylinderRadius, Math.max(length, 1e-3), cylinderRadius);
  return out.compose(scratch.mid, scratch.quaternion, scratch.scale);
}

export function constrainDirectBeamEndpointToMountRay(
  end: { x: number; y: number; z: number },
  mountX: number,
  mountY: number,
  mountZ: number,
  forwardX: number,
  forwardY: number,
  forwardZ: number,
): boolean {
  const forwardLength = Math.sqrt(
    forwardX * forwardX + forwardY * forwardY + forwardZ * forwardZ,
  );
  if (forwardLength <= 1e-9) return false;
  const fx = forwardX / forwardLength;
  const fy = forwardY / forwardLength;
  const fz = forwardZ / forwardLength;
  const along = Math.max(0,
    (end.x - mountX) * fx +
    (end.y - mountY) * fy +
    (end.z - mountZ) * fz,
  );
  end.x = mountX + fx * along;
  end.y = mountY + fy * along;
  end.z = mountZ + fz * along;
  return true;
}

const NEVER_EMISSION_LOW_LOD: BeamEmissionLodResolver = () => false;

const rawBeamConfig = beamConfig as unknown as BeamConfigFile;

const configuredInfinityVisualLength =
  rawBeamConfig.openEndedLine?.infinityVisualLength ?? DEFAULT_OPEN_ENDED_LINE_VISUAL_LENGTH;

const OPEN_ENDED_LINE_CONFIG: OpenEndedLineConfig = {
  extendToInfinity: rawBeamConfig.openEndedLine?.extendToInfinity ?? true,
  infinityVisualLength:
    Number.isFinite(configuredInfinityVisualLength) && configuredInfinityVisualLength > 0
      ? configuredInfinityVisualLength
      : DEFAULT_OPEN_ENDED_LINE_VISUAL_LENGTH,
};

const configuredImposterMinScreenRadiusPx =
  rawBeamConfig.imposterSegment?.minScreenRadiusPx;

const BEAM_IMPOSTER_SEGMENT_CONFIG: BeamImposterSegmentConfig = {
  enabled: rawBeamConfig.imposterSegment?.enabled ?? true,
  color: rawBeamConfig.imposterSegment?.color ?? DEFAULT_IMPOSTER_SEGMENT_COLOR,
  minScreenRadiusPx:
    typeof configuredImposterMinScreenRadiusPx === 'number' &&
    Number.isFinite(configuredImposterMinScreenRadiusPx) &&
    configuredImposterMinScreenRadiusPx > 0
      ? configuredImposterMinScreenRadiusPx
      : DEFAULT_IMPOSTER_MIN_SCREEN_RADIUS_PX,
};

/** Low uses the same outer-layer transparency as Medium/High instead of
 *  maintaining an unrelated, much more opaque imposter alpha. */
export const BEAM_LOW_LOD_OPACITY = BEAM_OUTER_VISUAL_CONFIG.waveHighAlpha;

/** Keep the Low solid cylinder at a minimum projected radius. This converts
 *  the screen-space target back into world units at the closest point on the
 *  segment. Using the midpoint made long beams that passed near the camera
 *  inflate from the distance to their far-away center. */
export function beamImposterWorldRadiusForSegment(
  view: RenderViewState3D | undefined,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  authoredRadius: number,
  minScreenRadiusPx: number = BEAM_IMPOSTER_SEGMENT_CONFIG.minScreenRadiusPx,
): number {
  if (!view || !(view.viewportHeightPx > 0) || !(minScreenRadiusPx > 0)) {
    return authoredRadius;
  }
  // Convert Three camera coordinates back to sim (x, y, z) before the
  // point-to-segment projection: Three (x, y, z) = sim (x, z, y).
  const cameraX = view.cameraX;
  const cameraY = view.cameraZ;
  const cameraZ = view.cameraY;
  const segmentX = bx - ax;
  const segmentY = by - ay;
  const segmentZ = bz - az;
  const segmentLengthSq =
    segmentX * segmentX + segmentY * segmentY + segmentZ * segmentZ;
  const closestT = segmentLengthSq > 1e-9
    ? THREE.MathUtils.clamp(
        ((cameraX - ax) * segmentX +
          (cameraY - ay) * segmentY +
          (cameraZ - az) * segmentZ) / segmentLengthSq,
        0,
        1,
      )
    : 0;
  const dx = cameraX - (ax + segmentX * closestT);
  const dy = cameraY - (ay + segmentY * closestT);
  const dz = cameraZ - (az + segmentZ * closestT);
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const worldRadiusForScreenTarget =
    minScreenRadiusPx * distance * 2 * Math.tan(view.fovYRad * 0.5) /
    view.viewportHeightPx;
  return Math.max(authoredRadius, worldRadiusForScreenTarget);
}

const configuredBeamUpdateBucketCount =
  rawBeamConfig.staggeredPathUpdates?.bucketCount ?? 1;

/** Number of deterministic refresh phases in the beam path update ring.
 *  One disables staggering so live beam paths and turret-mounted origins
 *  retain the renderer's full frame cadence. Larger values are available as
 *  an explicit throughput tradeoff for extreme beam counts. */
export const BEAM_UPDATE_BUCKET_COUNT = THREE.MathUtils.clamp(
  Math.round(Number.isFinite(configuredBeamUpdateBucketCount)
    ? configuredBeamUpdateBucketCount
    : 1),
  1,
  8,
);

/** Stable pseudo-random bucket assignment. Entity IDs never change during a
 *  beam's life, unlike array indices, so insertion/removal cannot reshuffle
 *  every live beam onto a new refresh frame. */
export function beamUpdateBucketForEntityId(
  entityId: number,
  bucketCount: number = BEAM_UPDATE_BUCKET_COUNT,
): number {
  const count = Number.isFinite(bucketCount)
    ? Math.max(1, Math.round(bucketCount))
    : 1;
  let hash = entityId | 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) % count;
}

const BEAM_VISUAL_LAYERS: readonly {
  config: BeamVisualConfig;
  radiusMultiplier: number;
}[] = [
  { config: BEAM_OUTER_VISUAL_CONFIG, radiusMultiplier: 1.0 },
  { config: BEAM_INNER_VISUAL_CONFIG, radiusMultiplier: BEAM_LAYER_INNER_SCALE },
];

type BeamVisualLayer = {
  readonly config: BeamVisualConfig;
  readonly radiusMultiplier: number;
  readonly segmentMesh: THREE.InstancedMesh;
  readonly segmentFlow: Float32Array;
  readonly segmentFlowAttr: THREE.InstancedBufferAttribute;
  activeSegmentCount: number;
};

const BEAM_ENDPOINT_SMOKE_PROFILE = getSmokeProfile('beamDamageEndpoint');

/** Configure one pooled SmokeTrail3D emitter at a beam's damage endpoint.
 * The puff begins at the rendered beam cylinder and expands until it is
 * slightly larger than the authored damage region. */
export function configureBeamEndpointSmokeEmitter(
  emitter: SmokePuffEmitter | undefined,
  beamEntityId: number,
  x: number,
  y: number,
  z: number,
  beamRadius: number,
  damageRadius: number,
): SmokePuffEmitter {
  const out = emitter ?? {
    x,
    y,
    z,
    useId: BEAM_ENDPOINT_SMOKE_PROFILE.useId,
    maxPoolSize: BEAM_ENDPOINT_SMOKE_PROFILE.maxPoolSize,
    capPolicy: BEAM_ENDPOINT_SMOKE_PROFILE.capPolicy,
    emitFramesSkip: BEAM_ENDPOINT_SMOKE_PROFILE.emitFramesSkip,
    fadeInMs: BEAM_ENDPOINT_SMOKE_PROFILE.fadeInMs,
    fadeOutMs: BEAM_ENDPOINT_SMOKE_PROFILE.fadeOutMs,
    startRadius: 0,
    endRadiusMultiplier: BEAM_ENDPOINT_SMOKE_PROFILE.endRadiusMultiplier,
    maxAlpha: BEAM_ENDPOINT_SMOKE_PROFILE.maxAlpha,
  };
  out.x = x;
  out.y = y;
  out.z = z;
  out.startRadius = Number.isFinite(beamRadius) ? Math.max(0, beamRadius) : 0;
  const safeDamageRadius = Number.isFinite(damageRadius)
    ? Math.max(0, damageRadius)
    : 0;
  const finalRadius = Math.max(
    out.startRadius,
    safeDamageRadius * BEAM_ENDPOINT_SMOKE_PROFILE.endRadiusMultiplier,
  );
  out.endRadiusMultiplier = out.startRadius > 1e-6
    ? finalRadius / out.startRadius
    : 1;
  out.phase = beamEntityId;
  // A very small upward drift makes overlapping impact puffs read as smoke
  // while keeping the growing plume anchored close to the termination point.
  out.vx = 0;
  out.vy = 0;
  out.vz = Math.max(1, out.startRadius * 0.1);
  return out;
}

type CachedBeamPoint = Pick<
  BeamPoint,
  'x' | 'y' | 'z' | 'reflectorEntityId' | 'reflectorKind'
>;

type CachedBeamPath = {
  readonly points: CachedBeamPoint[];
  baseStartX: number;
  baseStartY: number;
  baseStartZ: number;
  endpointDamageable: boolean | null;
  lastSeenFrame: number;
};

function createBeamVisualLayer(
  root: THREE.Group,
  config: BeamVisualConfig,
  radiusMultiplier: number,
  renderOrder: number,
  geometryTier: PrimitiveGeometryTier,
): BeamVisualLayer {
  const segmentGeom = createPrimitiveCylinderGeometry(
    'beam', geometryTier, 1, 1, 1, 1, geometryTier !== 'close',
  );
  const segmentAlpha = new Float32Array(BEAM_SEGMENT_CAP);
  segmentAlpha.fill(1);
  const segmentAlphaAttr = new THREE.InstancedBufferAttribute(segmentAlpha, 1);
  segmentAlphaAttr.setUsage(THREE.StaticDrawUsage);
  segmentGeom.setAttribute('aAlpha', segmentAlphaAttr);
  const segmentFlow = new Float32Array(BEAM_SEGMENT_CAP * 4);
  const segmentFlowAttr = new THREE.InstancedBufferAttribute(segmentFlow, 4);
  segmentFlowAttr.setUsage(THREE.DynamicDrawUsage);
  segmentGeom.setAttribute('aFlow', segmentFlowAttr);
  const segmentMat = new THREE.ShaderMaterial({
    vertexShader: BEAM_SEGMENT_VERTEX_SHADER,
    fragmentShader: createBeamSegmentFragmentShader(config),
    uniforms: {
      uTime: BEAM_WAVE_TIME,
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const segmentMesh = new THREE.InstancedMesh(
    segmentGeom,
    segmentMat,
    BEAM_SEGMENT_CAP,
  );
  segmentMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  segmentMesh.frustumCulled = false;
  segmentMesh.renderOrder = renderOrder;
  segmentMesh.count = 0;
  root.add(segmentMesh);

  return {
    config,
    radiusMultiplier,
    segmentMesh,
    segmentFlow,
    segmentFlowAttr,
    activeSegmentCount: 0,
  };
}

export class BeamRenderer3D {
  private root: THREE.Group;
  private readonly layers: BeamVisualLayer[];
  private readonly mediumLayer: BeamVisualLayer;
  private readonly imposterSegmentMesh: THREE.InstancedMesh;
  private activeImposterSegmentCount = 0;

  // RENDER: WIN/PAD/ALL visibility scope — beams with BOTH endpoints
  // outside the scope rect skip segment placement entirely.
  private scope: ViewportFootprint;
  private lastContentVersion = -1;
  private lastScopeVersion = -1;
  private beamUpdateFrameIndex = -1;
  private readonly cachedPathByEntityId = new Map<number, CachedBeamPath>();
  private readonly endpointSmokeEmitters: SmokePuffEmitter[] = [];

  // Scratch vectors reused per frame (no per-segment allocations).
  private readonly segmentPoseScratch = createBeamSegmentPoseScratch3D();
  private _matrix = new THREE.Matrix4();

  constructor(parentWorld: THREE.Group, scope: ViewportFootprint) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.scope = scope;
    this.layers = new Array<BeamVisualLayer>(BEAM_VISUAL_LAYERS.length);
    for (let i = 0; i < BEAM_VISUAL_LAYERS.length; i++) {
      const layer = BEAM_VISUAL_LAYERS[i];
      this.layers[i] = createBeamVisualLayer(
        this.root,
        layer.config,
        layer.radiusMultiplier,
        12 + i,
        'close',
      );
    }

    this.mediumLayer = createBeamVisualLayer(
      this.root,
      BEAM_OUTER_VISUAL_CONFIG,
      1,
      11,
      'mid',
    );

    const imposterSegmentGeom = createPrimitiveCylinderGeometry(
      'beam', 'far', 1, 1, 1, 1, true,
    );
    const imposterSegmentMat = new THREE.MeshBasicMaterial({
      color: BEAM_IMPOSTER_SEGMENT_CONFIG.color,
      transparent: true,
      opacity: BEAM_LOW_LOD_OPACITY,
      depthTest: true,
      depthWrite: false,
    });
    this.imposterSegmentMesh = new THREE.InstancedMesh(
      imposterSegmentGeom,
      imposterSegmentMat,
      BEAM_IMPOSTER_SEGMENT_CAP,
    );
    this.imposterSegmentMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.imposterSegmentMesh.frustumCulled = false;
    this.imposterSegmentMesh.renderOrder = 11;
    this.imposterSegmentMesh.count = 0;
    this.imposterSegmentMesh.visible = BEAM_IMPOSTER_SEGMENT_CONFIG.enabled;
    this.root.add(this.imposterSegmentMesh);
  }

  private placeSegment(
    mesh: THREE.InstancedMesh,
    slot: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cylRadius: number,
    length: number,
  ): void {
    composeBeamSegmentMatrix3D(
      this._matrix,
      this.segmentPoseScratch,
      ax, ay, az,
      bx, by, bz,
      cylRadius,
      length,
    );
    mesh.setMatrixAt(slot, this._matrix);
  }

  private writeSegment(
    layer: BeamVisualLayer,
    slot: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cylRadius: number,
    length: number,
    flowPhase: number,
  ): void {
    if (slot >= BEAM_SEGMENT_CAP) return;
    const flowBase = slot * 4;
    layer.segmentFlow[flowBase] = 1.0;
    layer.segmentFlow[flowBase + 1] = beamWaveFlowRepeats(length, layer.config.waveSpacing);
    layer.segmentFlow[flowBase + 2] = flowPhase;
    layer.segmentFlow[flowBase + 3] = layer.config.waveSpeed;
    this.placeSegment(layer.segmentMesh, slot, ax, ay, az, bx, by, bz, cylRadius, length);
  }

  private writeImposterSegment(
    slot: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cylRadius: number,
    length: number,
  ): void {
    if (slot >= BEAM_IMPOSTER_SEGMENT_CAP) return;
    this.placeSegment(
      this.imposterSegmentMesh,
      slot,
      ax, ay, az,
      bx, by, bz,
      cylRadius,
      length,
    );
  }

  private isOpenEndedLinePath(path: CachedBeamPath): boolean {
    if (path.endpointDamageable !== false) return false;
    const points = path.points;
    if (points.length < 2) return false;
    const endPoint = points[points.length - 1];
    return (
      endPoint.reflectorEntityId === null &&
      endPoint.reflectorKind === null
    );
  }

  private refreshCachedPath(
    path: CachedBeamPath,
    proj: NonNullable<Entity['projectile']>,
    sourcePoints: readonly BeamPoint[],
    snapToTurret: boolean,
    turretMountResolver: TurretMountResolver | undefined,
  ): void {
    for (let i = 0; i < sourcePoints.length; i++) {
      const source = sourcePoints[i];
      let point = path.points[i];
      if (!point) {
        point = {
          x: 0,
          y: 0,
          z: 0,
          reflectorEntityId: null,
          reflectorKind: null,
        };
        path.points[i] = point;
      }
      point.x = source.x;
      point.y = source.y;
      point.z = source.z;
      point.reflectorEntityId = source.reflectorEntityId;
      point.reflectorKind = source.reflectorKind;
    }
    path.points.length = sourcePoints.length;
    path.endpointDamageable = proj.endpointDamageable;

    const startPoint = sourcePoints[0];
    path.baseStartX = startPoint.x;
    path.baseStartY = startPoint.y;
    path.baseStartZ = startPoint.z;
    if (snapToTurret && turretMountResolver) {
      const turretIdx = proj.config.turretIndex ?? 0;
      const mount = turretMountResolver.getTurretMountWorldState(
        proj.sourceEntityId,
        turretIdx,
        proj.sourceBarrelIndex >= 0 ? proj.sourceBarrelIndex : 0,
      );
      if (mount) {
        path.baseStartX = mount.x;
        path.baseStartY = mount.y;
        path.baseStartZ = mount.z;
        if (mount.hasForward && sourcePoints.length === 2) {
          // A direct beam is one constrained turret ray. Re-project the
          // authoritative terminal distance onto the rendered barrel forward
          // from the selected muzzle. Reflected paths retain their surface vertices.
          const end = path.points[1];
          if (end !== undefined) constrainDirectBeamEndpointToMountRay(
            end,
            path.baseStartX,
            path.baseStartY,
            path.baseStartZ,
            mount.forwardX,
            mount.forwardY,
            mount.forwardZ,
          );
        }
      }
    }
  }

  private cachedPathFor(
    entityId: number,
    proj: NonNullable<Entity['projectile']>,
    sourcePoints: readonly BeamPoint[],
    activeUpdateBucket: number,
    snapToTurret: boolean,
    turretMountResolver: TurretMountResolver | undefined,
  ): CachedBeamPath {
    let path = this.cachedPathByEntityId.get(entityId);
    const isNew = path === undefined;
    if (!path) {
      path = {
        points: [],
        baseStartX: sourcePoints[0].x,
        baseStartY: sourcePoints[0].y,
        baseStartZ: sourcePoints[0].z,
        endpointDamageable: proj.endpointDamageable,
        lastSeenFrame: this.beamUpdateFrameIndex,
      };
      this.cachedPathByEntityId.set(entityId, path);
    }
    if (
      isNew ||
      beamUpdateBucketForEntityId(entityId) === activeUpdateBucket
    ) {
      this.refreshCachedPath(
        path,
        proj,
        sourcePoints,
        snapToTurret,
        turretMountResolver,
      );
    }
    path.lastSeenFrame = this.beamUpdateFrameIndex;
    return path;
  }

  private hasActiveVisuals(): boolean {
    if (this.activeImposterSegmentCount > 0) return true;
    if (this.mediumLayer.activeSegmentCount > 0) return true;
    const layers = this.layers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (layer.activeSegmentCount > 0) return true;
    }
    return false;
  }

  getEndpointSmokeEmitters(): readonly SmokePuffEmitter[] {
    return this.endpointSmokeEmitters;
  }

  update(
    projectiles: readonly Entity[],
    graphicsConfig?: GraphicsConfig,
    contentVersion?: number,
    turretMountResolver?: TurretMountResolver,
    isEntityEmissionLowLod: BeamEmissionLodResolver = NEVER_EMISSION_LOW_LOD,
    view?: RenderViewState3D,
    entityDetailRung?: BeamDetailRungResolver,
  ): void {
    if (
      projectiles.length === 0 &&
      !this.hasActiveVisuals() &&
      this.cachedPathByEntityId.size === 0
    ) {
      this.endpointSmokeEmitters.length = 0;
      return;
    }
    tickBeamWaveTime();
    this.beamUpdateFrameIndex = (this.beamUpdateFrameIndex + 1) & 0x3fffffff;
    const activeUpdateBucket =
      this.beamUpdateFrameIndex % BEAM_UPDATE_BUCKET_COUNT;
    const snapToTurret = BEAM_SNAP_ORIGIN_TO_TURRET && !!turretMountResolver;
    const scopeVersion = this.scope.getVersion();
    if (
      BEAM_UPDATE_BUCKET_COUNT === 1 &&
      !snapToTurret &&
      contentVersion !== undefined &&
      contentVersion === this.lastContentVersion &&
      scopeVersion === this.lastScopeVersion
    ) {
      return;
    }
    if (contentVersion !== undefined) this.lastContentVersion = contentVersion;
    this.lastScopeVersion = scopeVersion;

    let segIdx = 0;
    let mediumSegIdx = 0;
    let imposterSegIdx = 0;
    let endpointSmokeEmitterIdx = 0;
    const layers = this.layers;
    const layerCount = layers.length;

    for (let projectileIndex = 0; projectileIndex < projectiles.length; projectileIndex++) {
      const e = projectiles[projectileIndex];
      const pt = e.projectile?.projectileType;
      if (!pt || !isRayType(pt)) continue;

      const proj = e.projectile!;
      const sourcePoints = proj.points;
      if (!sourcePoints || sourcePoints.length < 2) continue;
      const path = this.cachedPathFor(
        e.id,
        proj,
        sourcePoints,
        activeUpdateBucket,
        snapToTurret,
        turretMountResolver,
      );
      const points = path.points;
      const startPoint = points[0];
      const endPoint = points[points.length - 1];
      // Scope gate before segment placement. Off-screen beam segments
      // can be numerous in large fights.
      const startIn = this.scope.inScope(startPoint.x, startPoint.y, 200);
      const endIn = this.scope.inScope(endPoint.x, endPoint.y, 200);
      if (!startIn && !endIn) continue;

      const profile = proj.config.shotProfile.visual;
      // lineRadius already equals shot.width / 2 for line shots, so using it
      // directly as the cylinder scale makes the diameter = shot.width.
      const cylRadius = Math.max(
        BEAM_MIN_RADIUS,
        profile.lineRadius * BEAM_RADIUS_SCALE,
      );
      const useLowLodSegments =
        BEAM_IMPOSTER_SEGMENT_CONFIG.enabled &&
        isEntityEmissionLowLod(e);
      const detailRung = entityDetailRung?.(e) ?? detailRungForLevel(
        view ? entityDetailLevelForView(view, e) : 1,
      );
      const beamStyle = graphicsConfig?.beamStyle ?? 'complex';
      const useImposterSegments =
        useLowLodSegments || beamStyle === 'simple' || detailRung < DETAIL_RUNG_MID;
      const useMediumSegments =
        !useImposterSegments &&
        (beamStyle === 'standard' || detailRung < DETAIL_RUNG_CLOSE);

      // Walk the polyline pairwise and draw one cylinder per segment.
      // Each reflection vertex carries its own (x, y, z), so pitched
      // beams bouncing off vertical mirrors trace the correct 3D path.
      // Per-segment alpha is held at 1.0 — the wave shader handles all
      // brightness modulation via mix(LOW_ALPHA, HIGH_ALPHA, pulse).
      const lastIdx = points.length - 1;
      const openEndedLine =
        OPEN_ENDED_LINE_CONFIG.extendToInfinity && this.isOpenEndedLinePath(path);

      // Sim's points[0] sits at the authoritative muzzle; snap-to-turret
      // re-anchors to the live mount so the start tracks the turret
      // smoothly between snapshots. This is both the logical and visual
      // start of the beam.
      const baseStartX = path.baseStartX;
      const baseStartY = path.baseStartY;
      const baseStartZ = path.baseStartZ;

      for (let i = 0; i < lastIdx; i++) {
        const a = points[i];
        const b = points[i + 1];
        const useSnappedStart = i === 0;
        const ax = useSnappedStart ? baseStartX : a.x;
        const ay = useSnappedStart ? baseStartY : a.y;
        const az = useSnappedStart ? baseStartZ : a.z;
        let bx = b.x;
        let by = b.y;
        let bz = b.z;
        if (
          openEndedLine &&
          i + 1 === lastIdx
        ) {
          const prev = points[lastIdx - 1];
          let tailDx = endPoint.x - prev.x;
          let tailDy = endPoint.y - prev.y;
          let tailDz = endPoint.z - prev.z;
          let tailLen = Math.sqrt(tailDx * tailDx + tailDy * tailDy + tailDz * tailDz);
          if (tailLen <= 1e-6) {
            tailDx = endPoint.x - ax;
            tailDy = endPoint.y - ay;
            tailDz = endPoint.z - az;
            tailLen = Math.sqrt(tailDx * tailDx + tailDy * tailDy + tailDz * tailDz);
          }
          if (tailLen > 1e-6) {
            const tailScale = OPEN_ENDED_LINE_CONFIG.infinityVisualLength / tailLen;
            bx = endPoint.x + tailDx * tailScale;
            by = endPoint.y + tailDy * tailScale;
            bz = endPoint.z + tailDz * tailScale;
          }
        }
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (useImposterSegments) {
          if (imposterSegIdx < BEAM_IMPOSTER_SEGMENT_CAP) {
            const imposterRadius = beamImposterWorldRadiusForSegment(
              view,
              ax, ay, az,
              bx, by, bz,
              cylRadius,
            );
            this.writeImposterSegment(
              imposterSegIdx,
              ax, ay, az,
              bx, by, bz,
              imposterRadius,
              segLen,
            );
            imposterSegIdx++;
          }
        } else if (useMediumSegments) {
          if (mediumSegIdx < BEAM_SEGMENT_CAP) {
            this.writeSegment(
              this.mediumLayer,
              mediumSegIdx,
              ax, ay, az,
              bx, by, bz,
              cylRadius,
              segLen,
              beamWaveFlowPhase(e.id, mediumSegIdx),
            );
            mediumSegIdx++;
          }
        } else if (segIdx < BEAM_SEGMENT_CAP) {
          const phase = beamWaveFlowPhase(e.id, segIdx);
          for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
            const layer = layers[layerIndex];
            this.writeSegment(
              layer,
              segIdx,
              ax, ay, az,
              bx, by, bz,
              cylRadius * layer.radiusMultiplier,
              segLen,
              phase,
            );
          }
          segIdx++;
        }
      }

      if (
        path.endpointDamageable !== false &&
        profile.lineDamageSphereRadius > 0.001 &&
        endpointSmokeEmitterIdx < BEAM_ENDPOINT_SMOKE_EMITTER_CAP
      ) {
        this.endpointSmokeEmitters[endpointSmokeEmitterIdx] =
          configureBeamEndpointSmokeEmitter(
            this.endpointSmokeEmitters[endpointSmokeEmitterIdx],
            e.id,
            endPoint.x,
            endPoint.y,
            endPoint.z,
            cylRadius,
            profile.lineDamageSphereRadius,
          );
        endpointSmokeEmitterIdx++;
      }
    }

    this.endpointSmokeEmitters.length = endpointSmokeEmitterIdx;

    for (const [entityId, path] of this.cachedPathByEntityId) {
      if (path.lastSeenFrame !== this.beamUpdateFrameIndex) {
        this.cachedPathByEntityId.delete(entityId);
      }
    }

    for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
      const layer = layers[layerIndex];
      layer.segmentMesh.count = segIdx;
      if (segIdx > 0) {
        uploadPrefixRange(layer.segmentMesh.instanceMatrix, segIdx * 16);
        uploadPrefixRange(layer.segmentFlowAttr, segIdx * 4);
      }
      layer.activeSegmentCount = segIdx;
    }

    this.mediumLayer.segmentMesh.count = mediumSegIdx;
    if (mediumSegIdx > 0) {
      uploadPrefixRange(this.mediumLayer.segmentMesh.instanceMatrix, mediumSegIdx * 16);
      uploadPrefixRange(this.mediumLayer.segmentFlowAttr, mediumSegIdx * 4);
    }
    this.mediumLayer.activeSegmentCount = mediumSegIdx;

    this.activeImposterSegmentCount = imposterSegIdx;
    this.imposterSegmentMesh.visible =
      BEAM_IMPOSTER_SEGMENT_CONFIG.enabled && imposterSegIdx > 0;
    this.imposterSegmentMesh.count = imposterSegIdx;
    if (imposterSegIdx > 0) {
      uploadPrefixRange(this.imposterSegmentMesh.instanceMatrix, imposterSegIdx * 16);
    }
  }

  destroy(): void {
    this.cachedPathByEntityId.clear();
    this.endpointSmokeEmitters.length = 0;
    disposeMesh(this.imposterSegmentMesh);
    disposeMesh(this.mediumLayer.segmentMesh);
    for (const layer of this.layers) {
      disposeMesh(layer.segmentMesh);
    }
    detachObject(this.root);
  }
}
