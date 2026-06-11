import * as THREE from 'three';
import { getProjRangeToggle } from '@/clientBarConfig';
import { COLORS } from '@/colorsConfig';
import type { Entity, EntityId } from '../sim/types';
import { getPlayerColors } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { RenderFrameState3D } from './RenderFrameState3D';
import {
  detachObject,
  disposeGeometries,
  disposeMaterials,
  disposeMesh,
} from './threeUtils';

const PROJECTILE_MIN_RADIUS = 0.5;
// 1 revolution per second.
const ROCKET_FIN_ROLL_RATE_RAD_PER_MS = (Math.PI * 2) / 2000;
// Multiples of the rocket body radius — how far the fin rear edge sits
// past the cylinder tail end. Avoids color z-fight at the tail cap.
const FIN_REAR_OVERHANG_MULT = 0.75;
const PROJECTILE_INSTANCED_CAP = 8192;
const PROJECTILE_ROCKET_FIN_COUNT = 3;
const CURVED_CONE_CURVE_SEGMENTS = 6;
const CURVED_CONE_RADIAL_SEGMENTS = 10;
const CURVED_CONE_VERTS_PER_TAIL = (CURVED_CONE_CURVE_SEGMENTS + 1) * CURVED_CONE_RADIAL_SEGMENTS;
const CURVED_CONE_INDICES_PER_TAIL = CURVED_CONE_CURVE_SEGMENTS * CURVED_CONE_RADIAL_SEGMENTS * 6;
// Trail stamps record the projectile's recent path as a polyline of
// positions frozen in render space the moment they were laid down, so
// MOVE POS / VEL EMAs only ever affect the live head — old stamps don't
// drift around behind the projectile. The drawn tail is resampled from
// this history every frame (resampleTrailCenterline) instead of mapping
// stamps to rings one-to-one, so the buffer is deeper than the ring
// count: the resample horizon is 7/6 of the tail length (kink pin +
// relax window), ordinary stamps land one drawn-segment-length apart,
// and forced reflection stamps can land arbitrarily close together.
// The extra slots keep the recorded polyline longer than the horizon,
// so evicting the oldest stamp never moves drawn geometry.
const TRAIL_STAMP_CAP = CURVED_CONE_CURVE_SEGMENTS + 4;
const TRAIL_MIN_TANGENT_SQ = 1e-6;
const PROJ_CYL_AXIS = new THREE.Vector3(0, 1, 0);
const CURVED_CONE_COS = Array.from(
  { length: CURVED_CONE_RADIAL_SEGMENTS },
  (_, i) => Math.cos((i / CURVED_CONE_RADIAL_SEGMENTS) * Math.PI * 2),
);
const CURVED_CONE_SIN = Array.from(
  { length: CURVED_CONE_RADIAL_SEGMENTS },
  (_, i) => Math.sin((i / CURVED_CONE_RADIAL_SEGMENTS) * Math.PI * 2),
);

function writeTranslateScaleMatrix(
  out: Float32Array,
  slot: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const o = slot * 16;
  out[o] = sx; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
  out[o + 4] = 0; out[o + 5] = sy; out[o + 6] = 0; out[o + 7] = 0;
  out[o + 8] = 0; out[o + 9] = 0; out[o + 10] = sz; out[o + 11] = 0;
  out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
}

function writeComposedMatrix(
  out: Float32Array,
  slot: number,
  x: number,
  y: number,
  z: number,
  quat: THREE.Quaternion,
  sx: number,
  sy: number,
  sz: number,
): void {
  const qx = quat.x, qy = quat.y, qz = quat.z, qw = quat.w;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  const o = slot * 16;

  out[o] = (1 - (yy + zz)) * sx;
  out[o + 1] = (xy + wz) * sx;
  out[o + 2] = (xz - wy) * sx;
  out[o + 3] = 0;
  out[o + 4] = (xy - wz) * sy;
  out[o + 5] = (1 - (xx + zz)) * sy;
  out[o + 6] = (yz + wx) * sy;
  out[o + 7] = 0;
  out[o + 8] = (xz + wy) * sz;
  out[o + 9] = (yz - wx) * sz;
  out[o + 10] = (1 - (xx + yy)) * sz;
  out[o + 11] = 0;
  out[o + 12] = x;
  out[o + 13] = y;
  out[o + 14] = z;
  out[o + 15] = 1;
}

type ProjectileRadiusMeshes = {
  collision?: THREE.LineSegments;
  explosion?: THREE.LineSegments;
};

type TrailStampBuffer = {
  // Length TRAIL_STAMP_CAP * 3, indexed newest-first. Slot 0 is the most
  // recent stamp; slot count-1 is the oldest. The oldest stamp is
  // evicted when stamping past the cap.
  points: Float32Array;
  // 1 where the matching slot is a forced reflection stamp (the exact
  // shield contact point), 0 for ordinary distance stamps. Kept in
  // lockstep with points so the resampler can pin a ring onto the kink.
  flags: Uint8Array;
  count: number;
};

type DynamicCurvedConeGeometry = {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  normals: Float32Array;
  positionAttr: THREE.BufferAttribute;
  normalAttr: THREE.BufferAttribute;
};

export type ProjectileRenderer3DOptions = {
  world: THREE.Group;
  clientViewState: ClientViewState;
  scope: ViewportFootprint;
  radiusSphereGeom: THREE.BufferGeometry;
};

export class ProjectileRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly scope: ViewportFootprint;
  private readonly radiusSphereGeom: THREE.BufferGeometry;

  private readonly projectileGeom = new THREE.SphereGeometry(1, 10, 8);
  private readonly projectileCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  private readonly projectileFinGeom = createProjectileFinGeometry();
  private readonly projectileMat = new THREE.MeshLambertMaterial({
    color: COLORS.effects.projectile.body.colorHex,
  });
  private readonly projectileCurvedConeMat = new THREE.MeshLambertMaterial({
    color: COLORS.effects.projectile.curvedCone.colorHex,
    side: THREE.DoubleSide,
  });
  private readonly projectileFinMat = new THREE.MeshLambertMaterial({
    color: COLORS.effects.projectile.fin.colorHex,
    side: THREE.DoubleSide,
  });
  private readonly projMatCollision = new THREE.LineBasicMaterial({
    color: COLORS.effects.projectile.collisionRadius.colorHex,
    transparent: true,
    opacity: COLORS.effects.projectile.collisionRadius.opacity,
    depthWrite: false,
  });
  private readonly projMatExplosion = new THREE.LineBasicMaterial({
    color: COLORS.effects.projectile.explosionRadius.colorHex,
    transparent: true,
    opacity: COLORS.effects.projectile.explosionRadius.opacity,
    depthWrite: false,
  });

  private readonly sphereInstanced: THREE.InstancedMesh;
  private readonly sphereMatrices: Float32Array;
  private readonly cylinderInstanced: THREE.InstancedMesh;
  private readonly cylinderMatrices: Float32Array;
  private readonly curvedCone: DynamicCurvedConeGeometry;
  private readonly curvedConeMesh: THREE.Mesh;
  private readonly finInstanced: THREE.InstancedMesh;
  private readonly finMatrices: Float32Array;
  private readonly finColors = new Float32Array(PROJECTILE_INSTANCED_CAP * 3);
  private readonly finColorAttr = new THREE.InstancedBufferAttribute(this.finColors, 3);
  private readonly seenProjectileIds = new Set<number>();
  private readonly projectileRadiusMeshes = new Map<number, ProjectileRadiusMeshes>();
  private readonly projectileRadiusMeshPool: THREE.LineSegments[] = [];
  private readonly trailStamps = new Map<EntityId, TrailStampBuffer>();
  // Scratch buffers reused across projectiles to avoid per-frame allocs.
  // resampleTrailCenterline fills tailCenterline with the drawn ring
  // centers, tailRingDist with each ring's arc distance behind the head,
  // and trailArcScratch with cumulative stamp-polyline arc lengths.
  private readonly tailCenterline = new Float32Array((CURVED_CONE_CURVE_SEGMENTS + 1) * 3);
  private readonly tailRingDist = new Float32Array(CURVED_CONE_CURVE_SEGMENTS + 1);
  private readonly trailArcScratch = new Float32Array(TRAIL_STAMP_CAP + 1);
  private lastProjectileEntitySetVersion = -1;
  private lastProjectileScopeVersion = -1;

  private readonly projDir = new THREE.Vector3();
  private readonly projQuat = new THREE.Quaternion();
  private readonly projPos = new THREE.Vector3();
  private readonly projScale = new THREE.Vector3();
  private readonly curveTangent = new THREE.Vector3();
  private readonly curveRight = new THREE.Vector3();
  private readonly curveUp = new THREE.Vector3();
  private readonly curveReference = new THREE.Vector3();
  private readonly finRollQuat = new THREE.Quaternion();
  private readonly finQuat = new THREE.Quaternion();
  private readonly finColor = new THREE.Color();
  private finColorDirty = false;

  constructor(options: ProjectileRenderer3DOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.scope = options.scope;
    this.radiusSphereGeom = options.radiusSphereGeom;

    this.sphereInstanced = new THREE.InstancedMesh(
      this.projectileGeom,
      this.projectileMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.sphereInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sphereMatrices = this.sphereInstanced.instanceMatrix.array as Float32Array;
    this.sphereInstanced.frustumCulled = false;
    this.sphereInstanced.count = 0;
    this.world.add(this.sphereInstanced);

    this.cylinderInstanced = new THREE.InstancedMesh(
      this.projectileCylinderGeom,
      this.projectileMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.cylinderInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cylinderMatrices = this.cylinderInstanced.instanceMatrix.array as Float32Array;
    this.cylinderInstanced.frustumCulled = false;
    this.cylinderInstanced.count = 0;
    this.world.add(this.cylinderInstanced);

    this.curvedCone = createProjectileCurvedConeGeometry(PROJECTILE_INSTANCED_CAP);
    this.curvedConeMesh = new THREE.Mesh(this.curvedCone.geometry, this.projectileCurvedConeMat);
    this.curvedConeMesh.frustumCulled = false;
    this.curvedConeMesh.visible = false;
    this.world.add(this.curvedConeMesh);

    this.finInstanced = new THREE.InstancedMesh(
      this.projectileFinGeom,
      this.projectileFinMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.finInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.finMatrices = this.finInstanced.instanceMatrix.array as Float32Array;
    this.finColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.finInstanced.instanceColor = this.finColorAttr;
    this.finInstanced.frustumCulled = false;
    this.finInstanced.count = 0;
    this.world.add(this.finInstanced);
  }

  update(frameState: RenderFrameState3D, projectiles: readonly Entity[]): void {
    const seen = this.seenProjectileIds;
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const scopeVersion = this.scope.getVersion();
    const pruneProjectiles =
      entitySetVersion !== this.lastProjectileEntitySetVersion ||
      (this.scope.getMode() !== 'all' && scopeVersion !== this.lastProjectileScopeVersion);
    if (pruneProjectiles) seen.clear();

    let sphereCount = 0;
    let cylinderCount = 0;
    let curvedConeCount = 0;
    let finCount = 0;
    const wantCol = getProjRangeToggle('collision');
    const wantExp = getProjRangeToggle('explosion');
    const projectileStyle = frameState.gfx.projectileStyle;
    const drawProjectileTail = projectileStyle !== 'dot' && projectileStyle !== 'core';
    const drawProjectileFins = projectileStyle === 'full';

    for (const e of projectiles) {
      if (pruneProjectiles) seen.add(e.id);
      const tx = e.transform.x;
      const ty = e.transform.y;
      const tz = e.transform.z;
      const proj = e.projectile;

      if (!this.scope.inScope(tx, ty, 50)) {
        this.hideProjRadiusMeshes(e.id);
        continue;
      }

      const shotProfile = e.projectile?.config.shotProfile;
      const visualProfile = shotProfile?.visual;
      const radius = shotProfile?.runtime.radius.visual ?? 4;
      const visualRadius = radius;
      const r = Math.max(visualRadius, PROJECTILE_MIN_RADIUS);

      if (sphereCount >= PROJECTILE_INSTANCED_CAP) {
        this.hideProjRadiusMeshes(e.id);
        continue;
      }
      writeTranslateScaleMatrix(
        this.sphereMatrices,
        sphereCount++,
        tx, tz, ty,
        r, r, r,
      );

      const tailShape = drawProjectileTail
        ? visualProfile?.projectileTailShape ?? 'cone'
        : 'none';
      const finSizeMult = drawProjectileFins
        ? visualProfile?.projectileFinSizeMult ?? 0
        : 0;
      if (tailShape !== 'none' || finSizeMult > 0) {
        const tailLength = r * (visualProfile?.projectileTailLengthMult ?? 8);
        const tailRadius = r * (visualProfile?.projectileTailRadiusMult ?? 1);
        this.composeProjectileTailPose(e, tx, ty, tz, tailLength, tailRadius);
        if (tailShape === 'cylinder') {
          if (cylinderCount < PROJECTILE_INSTANCED_CAP) {
            writeComposedMatrix(
              this.cylinderMatrices,
              cylinderCount++,
              this.projPos.x,
              this.projPos.y,
              this.projPos.z,
              this.projQuat,
              this.projScale.x,
              this.projScale.y,
              this.projScale.z,
            );
          }
        } else if (
          tailShape === 'cone' &&
          curvedConeCount < PROJECTILE_INSTANCED_CAP &&
          proj
        ) {
          const stamps = this.advanceTrailStamps(e.id, proj, tx, ty, tz, tailLength);
          if (stamps.count >= 1) {
            const drawnSpan = this.resampleTrailCenterline(tx, ty, tz, stamps, tailLength);
            this.writeProjectileCurvedConeTail(curvedConeCount++, tailRadius, drawnSpan);
          }
        }
        if (finSizeMult > 0 && finCount < PROJECTILE_INSTANCED_CAP) {
          const isRocketLike = proj?.config.shotProfile.runtime.isRocketLike === true;
          const rollAngle = proj && isRocketLike
            ? proj.timeAlive * ROCKET_FIN_ROLL_RATE_RAD_PER_MS
            : 0;
          // Push the fin's rear edge past the cylinder tail end so the
          // white fin tips don't z-fight with the rocket body cap.
          const finRearOffset = tailLength + r * FIN_REAR_OVERHANG_MULT;
          this.composeProjectileFinPose(tx, ty, tz, finRearOffset, r * finSizeMult, rollAngle);
          writeComposedMatrix(
            this.finMatrices,
            finCount,
            this.projPos.x,
            this.projPos.y,
            this.projPos.z,
            this.finQuat,
            this.projScale.x,
            this.projScale.y,
            this.projScale.z,
          );
          if (proj) {
            this.finColor.set(getPlayerColors(proj.ownerId).primary);
            const colorOffset = finCount * 3;
            this.finColors[colorOffset] = this.finColor.r;
            this.finColors[colorOffset + 1] = this.finColor.g;
            this.finColors[colorOffset + 2] = this.finColor.b;
            this.finColorDirty = true;
          }
          finCount++;
        }
      }

      this.updateProjRadiusMeshes(e, wantCol, wantExp);
    }

    this.sphereInstanced.count = sphereCount;
    if (sphereCount > 0) {
      this.markInstanceMatrixRange(this.sphereInstanced, 0, sphereCount - 1);
    }
    this.cylinderInstanced.count = cylinderCount;
    if (cylinderCount > 0) {
      this.markInstanceMatrixRange(this.cylinderInstanced, 0, cylinderCount - 1);
    }
    this.flushCurvedConeGeometry(curvedConeCount);
    this.finInstanced.count = finCount;
    if (finCount > 0) {
      this.markInstanceMatrixRange(this.finInstanced, 0, finCount - 1);
    }
    if (this.finColorDirty && this.finInstanced.instanceColor) {
      this.finInstanced.instanceColor.clearUpdateRanges();
      this.finInstanced.instanceColor.addUpdateRange(0, finCount * 3);
      this.finInstanced.instanceColor.needsUpdate = true;
      this.finColorDirty = false;
    }

    if (pruneProjectiles) {
      for (const [id, radii] of this.projectileRadiusMeshes) {
        if (!seen.has(id)) {
          this.releaseProjRadiusMesh(radii.collision);
          this.releaseProjRadiusMesh(radii.explosion);
          this.projectileRadiusMeshes.delete(id);
        }
      }
      for (const id of this.trailStamps.keys()) {
        if (!seen.has(id)) this.trailStamps.delete(id);
      }
      this.lastProjectileEntitySetVersion = entitySetVersion;
      this.lastProjectileScopeVersion = scopeVersion;
    }
  }

  destroy(): void {
    disposeMesh(this.sphereInstanced, { material: false, geometry: false });
    disposeMesh(this.cylinderInstanced, { material: false, geometry: false });
    disposeMesh(this.curvedConeMesh, { material: false, geometry: false });
    disposeMesh(this.finInstanced, { material: false, geometry: false });
    for (const radii of this.projectileRadiusMeshes.values()) {
      if (radii.collision) {
        disposeMesh(radii.collision, { material: false, geometry: false });
      }
      if (radii.explosion) {
        disposeMesh(radii.explosion, { material: false, geometry: false });
      }
    }
    for (const mesh of this.projectileRadiusMeshPool) {
      disposeMesh(mesh, { material: false, geometry: false });
    }
    this.seenProjectileIds.clear();
    this.projectileRadiusMeshes.clear();
    this.projectileRadiusMeshPool.length = 0;
    disposeGeometries([
      this.projectileGeom,
      this.projectileCylinderGeom,
      this.curvedCone.geometry,
      this.projectileFinGeom,
    ]);
    disposeMaterials([
      this.projectileMat,
      this.projectileCurvedConeMat,
      this.projectileFinMat,
      this.projMatCollision,
      this.projMatExplosion,
    ]);
  }

  // Shifts older stamps one slot deeper (dropping the oldest if at cap)
  // and writes the new stamp into slot 0.
  private insertTrailStamp(
    stamps: TrailStampBuffer,
    x: number,
    y: number,
    z: number,
    isReflection: boolean,
  ): void {
    const pts = stamps.points;
    const flags = stamps.flags;
    const newCount = Math.min(TRAIL_STAMP_CAP, stamps.count + 1);
    for (let i = newCount - 1; i >= 1; i--) {
      const dst = i * 3;
      const src = (i - 1) * 3;
      pts[dst] = pts[src];
      pts[dst + 1] = pts[src + 1];
      pts[dst + 2] = pts[src + 2];
      flags[i] = flags[i - 1];
    }
    pts[0] = x;
    pts[1] = y;
    pts[2] = z;
    flags[0] = isReflection ? 1 : 0;
    stamps.count = newCount;
  }

  private advanceTrailStamps(
    id: EntityId,
    proj: NonNullable<Entity['projectile']>,
    headX: number,
    headY: number,
    headZ: number,
    tailLength: number,
  ): TrailStampBuffer {
    let stamps = this.trailStamps.get(id);
    if (!stamps) {
      stamps = {
        points: new Float32Array(TRAIL_STAMP_CAP * 3),
        flags: new Uint8Array(TRAIL_STAMP_CAP),
        count: 0,
      };
      this.trailStamps.set(id, stamps);
    }

    // Forced reflection stamp: ClientViewState parks the exact
    // shield-sphere / shield-panel contact point on the projectile after each
    // bounce. Insert it ahead of the head's regular distance-threshold
    // stamp so the trail kinks at the actual shield surface rather than
    // one tick past it. The pre-bounce stamps shift deeper into the
    // buffer untouched, preserving the incoming arc.
    const bounceX = proj.pendingReflectionX;
    const bounceY = proj.pendingReflectionY;
    const bounceZ = proj.pendingReflectionZ;
    if (bounceX !== null && bounceY !== null && bounceZ !== null) {
      this.insertTrailStamp(stamps, bounceX, bounceY, bounceZ, true);
      proj.pendingReflectionX = null;
      proj.pendingReflectionY = null;
      proj.pendingReflectionZ = null;
    }

    // Step size determines how far the head travels between stamps. We
    // pick one segment's worth of tail length so the recorded polyline
    // naturally spans the resample horizon when fully populated.
    const stampStep = Math.max(0.25, tailLength / CURVED_CONE_CURVE_SEGMENTS);
    const stampStepSq = stampStep * stampStep;
    const pts = stamps.points;
    let shouldStamp = stamps.count === 0;
    if (!shouldStamp) {
      const dx = headX - pts[0];
      const dy = headY - pts[1];
      const dz = headZ - pts[2];
      if (dx * dx + dy * dy + dz * dz >= stampStepSq) shouldStamp = true;
    }
    if (shouldStamp) this.insertTrailStamp(stamps, headX, headY, headZ, false);
    return stamps;
  }

  // Rebuilds tailCenterline + tailRingDist by resampling the stamp
  // polyline [head, stamp0, stamp1, ...] at uniform arc-length spacing
  // over the drawn span. This decouples the drawn rings from the raw
  // stamps: every ring position is a continuous function of head motion,
  // so laying or evicting a stamp never moves tail geometry (the old
  // one-stamp-per-ring centerline popped the tail tip forward a whole
  // segment every time the oldest stamp dropped off). Returns the drawn
  // span — the arc length the emitted tail actually covers, which is
  // shorter than tailLength while a young projectile accumulates path.
  //
  // Reflection kinks stay exact: the newest reflection stamp inside the
  // horizon gets a ring pinned onto it, because the kink is the player's
  // evidence that a shot bounced and uniform resampling alone would cut
  // the corner. The pin slides continuously: while the kink's arc
  // distance sits between ring slots j and j+1 (tau in [j, j+1)), ring j
  // holds the kink and ring j-1 walks linearly back to its uniform spot
  // from the kink duty it just finished. At every handoff the affected
  // rings coincide, so no ring ever teleports.
  private resampleTrailCenterline(
    headX: number,
    headY: number,
    headZ: number,
    stamps: TrailStampBuffer,
    tailLength: number,
  ): number {
    const pts = stamps.points;
    const count = stamps.count;
    const cum = this.trailArcScratch;
    cum[0] = 0;
    let prevX = headX, prevY = headY, prevZ = headZ;
    let total = 0;
    for (let k = 0; k < count; k++) {
      const o = k * 3;
      const dx = pts[o] - prevX;
      const dy = pts[o + 1] - prevY;
      const dz = pts[o + 2] - prevZ;
      total += Math.sqrt(dx * dx + dy * dy + dz * dz);
      cum[k + 1] = total;
      prevX = pts[o];
      prevY = pts[o + 1];
      prevZ = pts[o + 2];
    }

    const centerline = this.tailCenterline;
    const dists = this.tailRingDist;
    centerline[0] = headX;
    centerline[1] = headY;
    centerline[2] = headZ;
    dists[0] = 0;

    const drawnSpan = Math.min(tailLength, total);
    if (drawnSpan < 1e-4) {
      // No usable path yet (fresh spawn) — collapse every ring onto the
      // head. writeProjectileCurvedConeTail zeroes the radii.
      for (let i = 1; i <= CURVED_CONE_CURVE_SEGMENTS; i++) {
        const dst = i * 3;
        centerline[dst] = headX;
        centerline[dst + 1] = headY;
        centerline[dst + 2] = headZ;
        dists[i] = 0;
      }
      return 0;
    }

    const step = drawnSpan / CURVED_CONE_CURVE_SEGMENTS;
    for (let i = 1; i <= CURVED_CONE_CURVE_SEGMENTS; i++) dists[i] = i * step;

    // Pin the newest reflection kink onto a ring (holder), and let the
    // ring that held it during the previous slot window relax home.
    const flags = stamps.flags;
    for (let k = 0; k < count; k++) {
      if (!flags[k]) continue;
      const d = cum[k + 1];
      const tau = d / step;
      const j = Math.floor(tau);
      // Ring 0 is the live head and the tip must stay at the span end,
      // so only interior rings hold the kink; past tau = 7 the kink and
      // its relax window have both left the drawn tail.
      if (j >= 1 && j < CURVED_CONE_CURVE_SEGMENTS) dists[j] = d;
      if (j >= 2 && j <= CURVED_CONE_CURVE_SEGMENTS) {
        dists[j - 1] = (2 * j - tau) * step;
      }
      break;
    }

    // Single forward walk emitting ring centers at each target distance
    // (dists is monotone by construction).
    let seg = 0;
    for (let i = 1; i <= CURVED_CONE_CURVE_SEGMENTS; i++) {
      let d = dists[i];
      if (d > total) d = total;
      while (seg < count - 1 && cum[seg + 1] < d) seg++;
      const segLen = cum[seg + 1] - cum[seg];
      let t = segLen > 1e-6 ? (d - cum[seg]) / segLen : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ao = (seg - 1) * 3;
      const ax = seg === 0 ? headX : pts[ao];
      const ay = seg === 0 ? headY : pts[ao + 1];
      const az = seg === 0 ? headZ : pts[ao + 2];
      const bo = seg * 3;
      const dst = i * 3;
      centerline[dst] = ax + (pts[bo] - ax) * t;
      centerline[dst + 1] = ay + (pts[bo + 1] - ay) * t;
      centerline[dst + 2] = az + (pts[bo + 2] - az) * t;
    }
    return drawnSpan;
  }

  private writeProjectileCurvedConeTail(
    slot: number,
    radius: number,
    drawnSpan: number,
  ): void {
    // tailCenterline and tailRingDist were just filled by
    // resampleTrailCenterline: vertex 0 is the live head, vertices 1..N
    // are resampled history points at known arc distances behind it.
    // The radius tapers linearly in arc length so the tube thickness at
    // a world point never depends on which ring currently samples it,
    // and the final ring (at the span end) always closes to zero.
    const centerline = this.tailCenterline;
    const dists = this.tailRingDist;
    const invSpan = drawnSpan > 1e-4 ? 1 / drawnSpan : 0;

    const positions = this.curvedCone.positions;
    const normals = this.curvedCone.normals;
    const vertexBase = slot * CURVED_CONE_VERTS_PER_TAIL;
    for (let segment = 0; segment <= CURVED_CONE_CURVE_SEGMENTS; segment++) {
      const ci = segment * 3;
      const px = centerline[ci];
      const py = centerline[ci + 1];
      const pz = centerline[ci + 2];

      // Tangent via centered difference (forward at the head, backward
      // at the tail end). Direction sign doesn't matter — setCurveBasis
      // only uses it to build an orthonormal frame for the ring.
      let tanX: number, tanY: number, tanZ: number;
      if (segment === 0) {
        tanX = centerline[3] - px;
        tanY = centerline[4] - py;
        tanZ = centerline[5] - pz;
      } else if (segment === CURVED_CONE_CURVE_SEGMENTS) {
        const pi = (segment - 1) * 3;
        tanX = px - centerline[pi];
        tanY = py - centerline[pi + 1];
        tanZ = pz - centerline[pi + 2];
      } else {
        const ni = (segment + 1) * 3;
        const pi = (segment - 1) * 3;
        tanX = centerline[ni] - centerline[pi];
        tanY = centerline[ni + 1] - centerline[pi + 1];
        tanZ = centerline[ni + 2] - centerline[pi + 2];
      }
      if (tanX * tanX + tanY * tanY + tanZ * tanZ < TRAIL_MIN_TANGENT_SQ) {
        // Padded collapsed tail — fall back to a stable axis so we don't
        // emit NaN rings.
        tanX = 0; tanY = 0; tanZ = 1;
      }
      this.setCurveBasis(tanX, tanY, tanZ);

      const ringRadius = invSpan > 0
        ? radius * (1 - dists[segment] * invSpan)
        : 0;
      for (let radial = 0; radial < CURVED_CONE_RADIAL_SEGMENTS; radial++) {
        const normalX = this.curveRight.x * CURVED_CONE_COS[radial] +
          this.curveUp.x * CURVED_CONE_SIN[radial];
        const normalY = this.curveRight.y * CURVED_CONE_COS[radial] +
          this.curveUp.y * CURVED_CONE_SIN[radial];
        const normalZ = this.curveRight.z * CURVED_CONE_COS[radial] +
          this.curveUp.z * CURVED_CONE_SIN[radial];
        const out = (vertexBase + segment * CURVED_CONE_RADIAL_SEGMENTS + radial) * 3;
        positions[out] = px + normalX * ringRadius;
        positions[out + 1] = pz + normalY * ringRadius;
        positions[out + 2] = py + normalZ * ringRadius;
        normals[out] = normalX;
        normals[out + 1] = normalY;
        normals[out + 2] = normalZ;
      }
    }
  }

  private setCurveBasis(tangentX: number, tangentY: number, tangentZ: number): void {
    this.curveTangent.set(tangentX, tangentZ, tangentY);
    if (this.curveTangent.lengthSq() <= 1e-8) {
      this.curveTangent.set(0, 0, -1);
    } else {
      this.curveTangent.normalize();
    }
    if (Math.abs(this.curveTangent.y) < 0.92) {
      this.curveReference.set(0, 1, 0);
    } else {
      this.curveReference.set(1, 0, 0);
    }
    this.curveRight.crossVectors(this.curveReference, this.curveTangent).normalize();
    this.curveUp.crossVectors(this.curveTangent, this.curveRight).normalize();
  }

  private flushCurvedConeGeometry(count: number): void {
    this.curvedConeMesh.visible = count > 0;
    this.curvedCone.geometry.setDrawRange(0, count * CURVED_CONE_INDICES_PER_TAIL);
    if (count <= 0) return;

    const updatedComponents = count * CURVED_CONE_VERTS_PER_TAIL * 3;
    this.curvedCone.positionAttr.clearUpdateRanges();
    this.curvedCone.positionAttr.addUpdateRange(0, updatedComponents);
    this.curvedCone.positionAttr.needsUpdate = true;
    this.curvedCone.normalAttr.clearUpdateRanges();
    this.curvedCone.normalAttr.addUpdateRange(0, updatedComponents);
    this.curvedCone.normalAttr.needsUpdate = true;
  }

  private composeProjectileFinPose(
    x: number, y: number, z: number,
    rearOffset: number,
    finScale: number,
    rollAngle: number,
  ): void {
    this.projPos.set(
      x + this.projDir.x * rearOffset,
      z + this.projDir.y * rearOffset,
      y + this.projDir.z * rearOffset,
    );
    this.projScale.setScalar(finScale);
    if (rollAngle !== 0) {
      // Fin geometry's local +Y is the rocket axis (projDir after projQuat),
      // so rolling around local Y spins the blades around that axis.
      this.finRollQuat.setFromAxisAngle(PROJ_CYL_AXIS, rollAngle);
      this.finQuat.copy(this.projQuat).multiply(this.finRollQuat);
    } else {
      this.finQuat.copy(this.projQuat);
    }
  }

  private composeProjectileTailPose(
    entity: Entity,
    x: number, y: number, z: number,
    length: number,
    radius: number,
  ): void {
    const proj = entity.projectile;
    if (proj) {
      const vx = proj.velocityX, vy = proj.velocityY, vz = proj.velocityZ;
      const len2 = vx * vx + vy * vy + vz * vz;
      if (len2 > 1e-6) {
        const inv = 1 / Math.sqrt(len2);
        this.projDir.set(-vx * inv, -vz * inv, -vy * inv);
      } else {
        this.projDir.set(
          -Math.cos(entity.transform.rotation),
          0,
          -Math.sin(entity.transform.rotation),
        );
      }
    } else {
      this.projDir.set(0, 0, -1);
    }
    this.projQuat.setFromUnitVectors(PROJ_CYL_AXIS, this.projDir);
    this.projPos.set(
      x + this.projDir.x * length * 0.5,
      z + this.projDir.y * length * 0.5,
      y + this.projDir.z * length * 0.5,
    );
    this.projScale.set(radius, length, radius);
  }

  private updateProjRadiusMeshes(
    entity: Entity,
    wantCol: boolean,
    wantExp: boolean,
  ): void {
    const proj = entity.projectile;
    if (!proj) return;
    const profile = proj.config.shotProfile;
    if (!profile.runtime.isProjectile) return;

    if (!wantCol && !wantExp) {
      const existing = this.projectileRadiusMeshes.get(entity.id);
      if (existing) {
        if (existing.collision) existing.collision.visible = false;
        if (existing.explosion) existing.explosion.visible = false;
      }
      return;
    }

    let radii = this.projectileRadiusMeshes.get(entity.id);
    if (!radii) {
      radii = {};
      this.projectileRadiusMeshes.set(entity.id, radii);
    }

    const projX = entity.transform.x;
    const projY = entity.transform.y;
    const projZ = entity.transform.z;

    this.setProjRadiusMesh(
      radii, 'collision', wantCol,
      projX, projY, projZ,
      profile.runtime.radius.collision,
      this.projMatCollision,
    );
    this.setProjRadiusMesh(
      radii, 'explosion', wantExp && !proj.hasExploded,
      projX, projY, projZ,
      profile.runtime.deathExplosionRadius,
      this.projMatExplosion,
    );
  }

  private hideProjRadiusMeshes(entityId: EntityId): void {
    const radii = this.projectileRadiusMeshes.get(entityId);
    if (!radii) return;
    if (radii.collision) radii.collision.visible = false;
    if (radii.explosion) radii.explosion.visible = false;
  }

  private setProjRadiusMesh(
    radii: ProjectileRadiusMeshes,
    key: 'collision' | 'explosion',
    want: boolean,
    x: number, y: number, z: number,
    radius: number,
    mat: THREE.LineBasicMaterial,
  ): void {
    if (!want || radius <= 0) {
      const m = radii[key];
      if (m) m.visible = false;
      return;
    }
    let mesh = radii[key];
    if (!mesh) {
      mesh = this.projectileRadiusMeshPool.pop() ??
        new THREE.LineSegments(this.radiusSphereGeom, mat);
      mesh.material = mat;
      this.world.add(mesh);
      radii[key] = mesh;
    }
    mesh.visible = true;
    mesh.position.set(x, z, y);
    mesh.scale.setScalar(radius);
  }

  private releaseProjRadiusMesh(mesh?: THREE.LineSegments): void {
    if (!mesh) return;
    mesh.visible = false;
    detachObject(mesh);
    this.projectileRadiusMeshPool.push(mesh);
  }

  private markInstanceMatrixRange(
    mesh: THREE.InstancedMesh,
    minSlot: number,
    maxSlot: number,
  ): void {
    if (maxSlot < minSlot) return;
    const attr = mesh.instanceMatrix;
    attr.clearUpdateRanges();
    attr.addUpdateRange(minSlot * 16, (maxSlot - minSlot + 1) * 16);
    attr.needsUpdate = true;
  }
}

// Local +Y aligns with projDir (rocket-rearward) after the instance
// quaternion is applied. The local origin sits at the fin's rear edge so
// the caller can place it directly at the rocket tail end; the fin tapers
// forward along local -Y toward the rocket body.
function createProjectileFinGeometry(): THREE.BufferGeometry {
  const FIN_FORWARD = -2;
  const FIN_REAR = 0;
  const FIN_OUT = 1;
  // Half-thickness perpendicular to each blade's plane.
  const FIN_THICK = 0.15;
  // Each blade becomes a triangular prism: front face + back face + 3 side
  // quads, all emitted as non-indexed triangles.
  const fin = (angleRad: number): number[] => {
    const radialX = Math.cos(angleRad);
    const radialZ = Math.sin(angleRad);
    const ox = radialX * FIN_OUT;
    const oz = radialZ * FIN_OUT;
    const px = -radialZ * FIN_THICK;
    const pz = radialX * FIN_THICK;
    // Six prism vertices: A/B/C with +perp, A'/B'/C' with -perp.
    const A = [0, FIN_FORWARD, 0];
    const B = [0, FIN_REAR, 0];
    const C = [ox, FIN_REAR, oz];
    const Ap = [A[0] + px, A[1], A[2] + pz];
    const Bp = [B[0] + px, B[1], B[2] + pz];
    const Cp = [C[0] + px, C[1], C[2] + pz];
    const An = [A[0] - px, A[1], A[2] - pz];
    const Bn = [B[0] - px, B[1], B[2] - pz];
    const Cn = [C[0] - px, C[1], C[2] - pz];
    return [
      // Front face (perp side).
      ...Ap, ...Bp, ...Cp,
      // Back face (opposite winding).
      ...An, ...Cn, ...Bn,
      // Forward edge quad (apex A → rear-inner B), connecting Ap-Bp to An-Bn.
      ...Ap, ...An, ...Bp,
      ...Bp, ...An, ...Bn,
      // Rear edge quad (B → C).
      ...Bp, ...Bn, ...Cp,
      ...Cp, ...Bn, ...Cn,
      // Outer slanted edge (C → A).
      ...Cp, ...Cn, ...Ap,
      ...Ap, ...Cn, ...An,
    ];
  };
  const verts = new Float32Array(
    Array.from({ length: PROJECTILE_ROCKET_FIN_COUNT }, (_, i) =>
      fin((i / PROJECTILE_ROCKET_FIN_COUNT) * Math.PI * 2),
    ).flat(),
  );
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geom.computeVertexNormals();
  return geom;
}

function createProjectileCurvedConeGeometry(capacity: number): DynamicCurvedConeGeometry {
  const positions = new Float32Array(capacity * CURVED_CONE_VERTS_PER_TAIL * 3);
  const normals = new Float32Array(capacity * CURVED_CONE_VERTS_PER_TAIL * 3);
  const indices = new Uint32Array(capacity * CURVED_CONE_INDICES_PER_TAIL);
  for (let slot = 0; slot < capacity; slot++) {
    const vertexBase = slot * CURVED_CONE_VERTS_PER_TAIL;
    let indexOut = slot * CURVED_CONE_INDICES_PER_TAIL;
    for (let segment = 0; segment < CURVED_CONE_CURVE_SEGMENTS; segment++) {
      const ringA = vertexBase + segment * CURVED_CONE_RADIAL_SEGMENTS;
      const ringB = ringA + CURVED_CONE_RADIAL_SEGMENTS;
      for (let radial = 0; radial < CURVED_CONE_RADIAL_SEGMENTS; radial++) {
        const next = (radial + 1) % CURVED_CONE_RADIAL_SEGMENTS;
        const a = ringA + radial;
        const b = ringB + radial;
        const c = ringB + next;
        const d = ringA + next;
        indices[indexOut++] = a;
        indices[indexOut++] = b;
        indices[indexOut++] = d;
        indices[indexOut++] = b;
        indices[indexOut++] = c;
        indices[indexOut++] = d;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const normalAttr = new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('normal', normalAttr);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  return { geometry, positions, normals, positionAttr, normalAttr };
}
