// Render3DEntities — extrudes the 2D sim primitives into 3D shapes.
//
// - Units:        cylinder (radius from unitRadiusCollider.scale, height ∝ radius)
// - Turrets:      one per entry in entity.turrets, positioned at chassis-local
//                 offset, rotated to the turret's firing angle, with white
//                 barrel cylinders whose length comes from config.barrel.
// - Buildings:    box (width/height from building component, y-depth ∝ scale)
// - Projectiles:  small sphere (radius from projectile collision)
//
// Coordinate mapping: sim (x, y) → three (x, z). Y is up. Ground at y=0.

import * as THREE from 'three';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { getPlayerColors } from '../sim/types';
import type { SpinConfig } from '../../config';
import { MIRROR_EXTRA_HEIGHT } from '../../config';
import type { ClientViewState } from '../network/ClientViewState';
import {
  buildLocomotion,
  updateLocomotion,
  destroyLocomotion,
  type Locomotion3DMesh,
} from './Locomotion3D';
import { snapshotLod, type Lod3DState } from './Lod3D';
import { getBodyGeom, disposeBodyGeoms } from './BodyShape3D';
import {
  buildBuildingShape,
  disposeBuildingGeoms,
  type BuildingShapeType,
} from './BuildingShape3D';
import type { ViewportFootprint } from '../ViewportFootprint';
import { getUnitBlueprint } from '../sim/blueprints';
import { getUnitRadiusToggle, getRangeToggle, getProjRangeToggle } from '@/clientBarConfig';
import { getWeaponWorldPosition, getTurretHeadRadius } from '../math';
import { buildTurretMesh3D, type TurretMesh } from './TurretMesh3D';
import { buildMirrorMesh3D, type MirrorMesh } from './MirrorMesh3D';

// Turret head height is the one remaining shared vertical constant —
// chassis heights are now per-unit (see getBodyTopY in BodyDimensions.ts).
// The sim's projectile-spawn code (getUnitMuzzleHeight in
// combat/combatUtils.ts) derives muzzle altitude from the same body-top
// value so visual barrel tip and sim muzzle stay locked together.

const BUILDING_HEIGHT = 120;
const PROJECTILE_MIN_RADIUS = 1.5;   // floor so very-small shots stay visible
const BARREL_COLOR = 0xffffff;

// Module-level rotation axis reused by the LOW-tier instanced sphere
// path. Three.js' Quaternion.setFromAxisAngle reads the axis as an
// (input) Vector3, but never mutates it.
const _INST_UP = new THREE.Vector3(0, 1, 0);

// Mirror panels (reflective mirror-unit armor plates): standing rectangular
// slabs positioned in the unit's TURRET frame (not chassis frame), since the
// turret/mirror rotates independently of the hull.
// Mirror panels span at least the full unit silhouette so they actually
// read as deflector armor. Start just above the ground to avoid clipping
// into the tile layer, end at the unit's body top + TURRET_HEIGHT so the
// top of the panel is flush with the top of the turret head (which is the
// tallest part of the unit). The top is computed per-unit now that body
// heights vary.
// MIRROR_BASE_Y comes from src/config.ts — same value the sim uses so
// the beam-reflection tracer and the rendered panel mesh line up.

type EntityMesh = {
  group: THREE.Group;
  /** Parent for the chassis body parts. For units this is uniformly
   *  scaled by unitRadius so each BodyMeshPart's unit-radius-1 offset
   *  and per-axis scale both enlarge correctly. For buildings the group
   *  holds a single box mesh that's sized each frame to (w, renderH, d). */
  chassis: THREE.Group;
  /** All meshes inside `chassis` that carry the team primary material —
   *  updated whenever the owner changes (team reassignment, capture). */
  chassisMeshes: THREE.Mesh[];
  /** Cached renderer id (e.g. 'arachnid', 'tank') resolved once at
   *  mesh-build time. Unit-blueprint lookups in the per-frame update
   *  loop are wasted work — the unitType never changes for a live
   *  entity, so we stash the result here. */
  rendererId: string;
  turrets: TurretMesh[];
  mirrors?: MirrorMesh;
  locomotion?: Locomotion3DMesh;
  /** Selection ring mesh — material is the renderer-owned shared
   *  `selectionRingMat` (white for every selection), so we don't store
   *  a per-unit material reference. The mesh itself lives under
   *  `m.group` and is GC'd with the group on death. */
  ring?: THREE.Mesh;
  /** UNIT RAD wireframe spheres. All three channels are now 3D in
   *  the sim:
   *    - scale → pure visual horizontal footprint (no sim collision);
   *      rendered as a sphere for visual consistency with the others.
   *    - shot  → 3D swept + area-damage check (lineSphereIntersectionT
   *      + sqrt(dx²+dy²+dz²) in DamageSystem).
   *    - push  → full 3D sphere-vs-sphere push in PhysicsEngine3D.
   *
   *  Meshes are created lazily on first show and hidden (not destroyed)
   *  when toggled off. All three parent to the unit group at local
   *  y = push radius so the sphere center sits on the unit's sim
   *  sphere center and rides along with altitude changes. */
  radiusRings?: {
    scale?: THREE.LineSegments;
    shot?: THREE.LineSegments;
    push?: THREE.LineSegments;
  };
  /** Builder-unit BLD wireframe sphere — 3D now that the build-range
   *  check includes altitude. Parented to the WORLD group and
   *  positioned at the unit's sim sphere center each frame. */
  buildRing?: THREE.LineSegments;
  /** Per-building accent meshes (chimney, solar cells, etc.). Tracked
   *  so rebuilds / destroy() know what to clean up alongside the primary
   *  slab. Empty / undefined for units. */
  buildingDetails?: THREE.Mesh[];
  /** Per-building render height (solar is shorter than the default). */
  buildingHeight?: number;
  /** The LOD key this unit's geometry was built at. Render3DEntities rebuilds
   *  the mesh when the current frame's LOD key differs. */
  lodKey: string;
};

export class Render3DEntities {
  private world: THREE.Group;
  private clientViewState: ClientViewState;
  /** Visibility scope (RENDER: WIN/PAD/ALL). Each per-entity update
   *  loop early-outs when the entity is outside this rect — skipping
   *  transform writes, locomotion IK, turret placement, etc.
   *  Three.js still handles GPU-side culling for the
   *  meshes themselves; this guards the CPU-side setup. */
  private scope: ViewportFootprint;

  private unitMeshes = new Map<number, EntityMesh>();
  private buildingMeshes = new Map<number, EntityMesh>();
  private projectileMeshes = new Map<number, THREE.Mesh>();
  // Reusable "seen this frame" sets — the four per-frame update loops
  // (barrel-spin, unit, building, projectile) each need to track which
  // entity ids were visited so stale Map entries get pruned. Keeping
  // them as instance fields and calling `.clear()` at the top of each
  // loop avoids allocating a fresh Set on every render frame — four
  // Set allocations × 60 Hz = ~240 GC objects/sec otherwise.
  private _seenUnitIds = new Set<EntityId>();
  private _seenSpinIds = new Set<EntityId>();
  private _seenBuildingIds = new Set<number>();
  private _seenProjectileIds = new Set<number>();
  /** SHOT RAD overlay meshes per projectile. Wireframe spheres —
   *  not ground rings — because the matching sim checks ARE 3D
   *  (lineSphereIntersectionT for collision, sqrt(dx²+dy²+dz²) for
   *  area damage against units). Lazily created on first visible
   *  toggle and hidden (not destroyed) when toggled off, so churning
   *  the buttons doesn't churn GPU allocations. */
  private projectileRadiusMeshes = new Map<number, {
    collision?: THREE.LineSegments;
    primary?: THREE.LineSegments;
    secondary?: THREE.LineSegments;
  }>();

  // Per-unit barrel-spin state (one per unit with any multi-barrel turret).
  // Angle advances by `speed` radians/sec; speed accelerates toward
  // spinConfig.max while any turret on the unit is engaged, decelerates toward
  // spinConfig.idle otherwise. Mirrors the 2D barrel-spin system exactly.
  private barrelSpins = new Map<EntityId, { angle: number; speed: number }>();
  private _lastSpinMs = performance.now();

  // LOD state — read once per frame in update(), then every builder/drawer
  // consults these values instead of calling getGraphicsConfig() ad-hoc.
  // When `lod.key` changes, any pre-built unit mesh is rebuilt.
  private lod: Lod3DState = snapshotLod();

  // Shared geometries & per-team materials (avoid per-entity allocation).
  // Unit chassis geometries are per-renderer extrusions handled by BodyShape3D.
  // Sphere (not cylinder) so the barrels can pivot freely in any
  // direction — the head reads as a turret ball the barrels swing
  // around, letting pitch aim up toward AA targets without the
  // barrels clipping through a flat cylinder top.
  private turretHeadGeom = new THREE.SphereGeometry(1, 16, 12);
  // Plain sphere used at MIN / LOW LOD as the entire unit body — mirrors
  // the 2D "circles" representation. Coarser tessellation than the
  // turret-head sphere because at low tiers we trade detail for draw
  // speed and the unit count is what hurts.
  private unitSphereLowGeom = new THREE.SphereGeometry(1, 10, 8);
  private barrelGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  private projectileGeom = new THREE.SphereGeometry(1, 10, 8);
  /** Velocity-aligned body for rocket-style projectiles (shot.shape ===
   *  'cylinder'). Geometry has its long axis on Y; per-frame orientation
   *  rotates that Y to match the projectile's velocity vector. */
  private projectileCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  /** Reusable scratch objects for per-frame cylinder orientation —
   *  every rocket would otherwise allocate a Vector3 + Quaternion per
   *  frame. */
  private _projDir = new THREE.Vector3();
  private _projQuat = new THREE.Quaternion();
  private static readonly _PROJ_CYL_AXIS = new THREE.Vector3(0, 1, 0);
  /** Engine fallback values used when a shape:'cylinder' shot doesn't
   *  define its own `cylinderShape` block. World length =
   *  collision.radius × LENGTH_MULT; world diameter = collision.radius
   *  × DIAMETER_MULT. Per-shot overrides live on the shot blueprint
   *  (see CylinderShapeSpec) — these only kick in when the blueprint
   *  is silent. */
  private static readonly _PROJ_CYL_LENGTH_MULT_DEFAULT = 4.0;
  private static readonly _PROJ_CYL_DIAMETER_MULT_DEFAULT = 0.5;
  // White projectile mat — team-agnostic so any shot reads as "can hit
  // anyone". Shooter identity comes from the turret/barrel and impact
  // effects, not the projectile body. Matches the 2D getProjectileColor
  // override.
  private projectileMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private buildingGeom = new THREE.BoxGeometry(1, 1, 1);
  private barrelMat = new THREE.MeshLambertMaterial({ color: BARREL_COLOR });
  // Mirror panel = flat unit square plane. Default orientation: face
  // in XY plane with normal +Z; we rotate it into the panel-local frame
  // (edge → +Z, normal → +X) per panel below. Plane has zero physical
  // thickness so the visible mesh and the sim collision rectangle live
  // on EXACTLY the same surface — no front/back offset where a beam
  // could appear to clip the visible chrome but miss the sim plane.
  private mirrorGeom = new THREE.PlaneGeometry(1, 1);
  // Thin ring for the selection indicator (flat, sits just above the ground plane)
  private ringGeom = new THREE.RingGeometry(0.9, 1.0, 28);
  // Unit-radius indicator wireframe spheres (SCAL/SHOT/PUSH). Unit
  // radius = 1 → scale per mesh to the actual collider radius. The
  // sim's hit-detection uses 3D spheres centered on transform.z, so
  // the debug viz is a matching 3D wireframe sphere (not a flat
  // ground ring) that shows exactly what volume the collision code
  // tests against.
  private radiusSphereGeom = new THREE.WireframeGeometry(
    new THREE.SphereGeometry(1, 16, 10),
  );
  private radiusMatScale = new THREE.LineBasicMaterial({
    color: 0x44ffff, transparent: true, opacity: 0.7, depthWrite: false,
  });
  private radiusMatShot = new THREE.LineBasicMaterial({
    color: 0xff44ff, transparent: true, opacity: 0.7, depthWrite: false,
  });
  private radiusMatPush = new THREE.LineBasicMaterial({
    color: 0x44ff44, transparent: true, opacity: 0.7, depthWrite: false,
  });

  // TURR RAD sphere materials. Colors mirror the 2D RangeCircles
  // palette so the same toggle reads the same regardless of renderer.
  // The sphere geometry is the shared radiusSphereGeom (wireframe
  // unit sphere) built above.
  private ringMatTrackAcquire = new THREE.LineBasicMaterial({ color: 0xffff88, transparent: true, opacity: 0.25, depthWrite: false });
  private ringMatTrackRelease = new THREE.LineBasicMaterial({ color: 0xffff88, transparent: true, opacity: 0.12, depthWrite: false });
  private ringMatEngageAcquire = new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.30, depthWrite: false });
  private ringMatEngageRelease = new THREE.LineBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0.25, depthWrite: false });
  private ringMatBuild = new THREE.LineBasicMaterial({ color: 0x44ff44, transparent: true, opacity: 0.30, depthWrite: false });
  // Selection ring material — color is always white, so one shared
  // instance covers every unit. Was previously allocated fresh on
  // every (deselect → select) toggle, with a matching dispose on
  // deselect/death; that churned a MeshBasicMaterial per click.
  private selectionRingMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  // SHOT RAD wireframe spheres. These sim checks ARE 3D
  // (lineSphereIntersectionT for collision, 3D sqrt(dx²+dy²+dz²) for
  // area damage), so the viz is a 3D sphere — not a ring — to match
  // the real volume the sim tests. Separate materials per toggle so
  // overlapping spheres stay visually distinct.
  private projMatCollision = new THREE.LineBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.55, depthWrite: false });
  private projMatPrimary = new THREE.LineBasicMaterial({ color: 0xff8844, transparent: true, opacity: 0.35, depthWrite: false });
  private projMatSecondary = new THREE.LineBasicMaterial({ color: 0xffdd44, transparent: true, opacity: 0.30, depthWrite: false });

  private primaryMats = new Map<PlayerId, THREE.MeshLambertMaterial>();
  private neutralMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
  // Super-shiny PBR materials for mirror panels. metalness=1 + near-zero
  // roughness turns the panel into team-tinted chrome that reflects the
  // scene's PMREM-processed RoomEnvironment cube set on the scene in
  // ThreeApp. One material per team color (plus a neutral).
  private mirrorShinyMats = new Map<PlayerId, THREE.MeshStandardMaterial>();
  // DoubleSide so the flat plane is visible from either side — beams
  // can come from any angle, and a single-sided plane would silently
  // disappear when viewed from behind.
  private mirrorShinyNeutralMat = new THREE.MeshStandardMaterial({
    color: 0xdddddd, metalness: 1.0, roughness: 0.0, side: THREE.DoubleSide,
  });

  // ── LOW-tier instanced sphere ─────────────────────────────────────
  // At MIN / LOW LOD every unit is a single sphere. Stamping each one
  // as a separate Mesh costs 1 draw call per unit; a single
  // InstancedMesh collapses thousands of spheres into one draw + one
  // shader invocation per instance. Per-unit transform/colour go into
  // the instance buffers; unused slots are kept at scale 0 so they
  // contribute no visible geometry.
  private static readonly LOW_INSTANCED_CAP = 16384;
  private unitInstanced: THREE.InstancedMesh | null = null;
  /** Maps entityId → instance slot index for fast per-frame writes. */
  private unitInstancedSlot = new Map<EntityId, number>();
  /** Reuse pool of vacated slots so a long game doesn't burn through cap. */
  private unitInstancedFreeSlots: number[] = [];
  /** High-water mark; everything ≥ this is unused. */
  private unitInstancedNextSlot = 0;
  /** Hidden-slot transform: scale=0 collapses the geometry to a point. */
  private static readonly _ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
  /** Reusable scratch matrix to avoid allocations in the per-instance write hot loop. */
  private _instMatrix = new THREE.Matrix4();
  /** Reusable scratch quaternion + vector. */
  private _instQuat = new THREE.Quaternion();
  private _instPos = new THREE.Vector3();
  private _instScale = new THREE.Vector3();
  private _instColor = new THREE.Color();

  constructor(
    world: THREE.Group,
    clientViewState: ClientViewState,
    scope: ViewportFootprint,
  ) {
    this.world = world;
    this.clientViewState = clientViewState;
    this.scope = scope;
    // Per-team materials are created lazily on first use (see
    // getPrimaryMat / getSecondaryMat / getMirrorShinyMat). The
    // player-color generator (sim/types.getPlayerColors) supports any
    // pid, so we don't pre-allocate for a fixed table here.

    // Build the LOW-tier instanced sphere up front. The material is
    // white because per-instance colour comes from the InstancedMesh
    // colour attribute (setColorAt). DynamicDrawUsage hints to the
    // driver that the matrix buffer changes every frame.
    const baseMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.unitInstanced = new THREE.InstancedMesh(
      this.unitSphereLowGeom,
      baseMat,
      Render3DEntities.LOW_INSTANCED_CAP,
    );
    this.unitInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Allocate the instanceColor buffer so setColorAt works without a
    // first-frame initialization branch.
    this.unitInstanced.setColorAt(0, this._instColor.set(0xffffff));
    this.unitInstanced.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    // Frustum culling on an InstancedMesh uses the LOCAL geometry's
    // bounding sphere — for our unit sphere that's a 1-radius ball at
    // the origin. Instances live anywhere on the (up to 6000-wu) map,
    // so the default cull would hide the whole mesh whenever the
    // camera wasn't looking at world origin (which is most of the
    // time). Disabling cull is cheap because hidden slots use a
    // scale-0 matrix and contribute zero rasterized pixels.
    this.unitInstanced.frustumCulled = false;
    // Hide every slot up front; updateUnitsInstanced fills active ones
    // each frame.
    for (let i = 0; i < Render3DEntities.LOW_INSTANCED_CAP; i++) {
      this.unitInstanced.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
    }
    this.unitInstanced.count = Render3DEntities.LOW_INSTANCED_CAP;
    this.unitInstanced.instanceMatrix.needsUpdate = true;
    this.world.add(this.unitInstanced);
  }

  private getMirrorShinyMat(pid: PlayerId | undefined): THREE.MeshStandardMaterial {
    if (pid === undefined) return this.mirrorShinyNeutralMat;
    let mat = this.mirrorShinyMats.get(pid);
    if (!mat) {
      // Mirror panels share the team's primary color (same color +
      // saturation as the chassis); the chrome look comes from
      // metalness=1, near-zero roughness reflecting the scene's
      // PMREM environment, not from a desaturated secondary tint.
      mat = new THREE.MeshStandardMaterial({
        color: getPlayerColors(pid).primary,
        metalness: 1.0,
        roughness: 0.0,
        side: THREE.DoubleSide,
      });
      this.mirrorShinyMats.set(pid, mat);
    }
    return mat;
  }


  private getPrimaryMat(pid: PlayerId | undefined): THREE.MeshLambertMaterial {
    if (pid === undefined) return this.neutralMat;
    let mat = this.primaryMats.get(pid);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color: getPlayerColors(pid).primary });
      this.primaryMats.set(pid, mat);
    }
    return mat;
  }


  /**
   * Show/hide the per-unit SCAL / SHOT / PUSH radius rings, matching the 2D
   * renderUnitRadiusCircles toggles. Rings are lazily created on first show
   * and simply hidden (not destroyed) when toggled off, so flipping toggles
   * repeatedly doesn't churn geometry.
   *
   * Wireframe SPHERE centered at the unit's hit-sphere center (= push
   * radius above the group's ground origin). Scale is the collider
   * value for the selected channel. Shows the actual 3D volume the
   * sim tests against, so overlapping spheres of different colors
   * immediately communicate which check is hitting or missing.
   */
  private updateRadiusRings(m: EntityMesh, entity: Entity): void {
    const collider = entity.unit?.unitRadiusCollider;
    if (!collider) return;

    const rings = m.radiusRings ?? (m.radiusRings = {});

    // All three UNIT RAD spheres sit at the unit's sim sphere center.
    // Because the unit group is positioned at (x, groundZ, y) in
    // three-space and the sim sphere center is `push radius` above
    // that ground, a local-Y of `collider.push` puts the sphere
    // exactly where the collision code measures from. The sphere
    // follows altitude changes for free.
    const centerY = collider.push;

    this.setUnitRadiusSphere(
      rings, 'scale', getUnitRadiusToggle('visual'), m.group,
      centerY, collider.scale, this.radiusMatScale,
    );
    this.setUnitRadiusSphere(
      rings, 'shot', getUnitRadiusToggle('shot'), m.group,
      centerY, collider.shot, this.radiusMatShot,
    );
    this.setUnitRadiusSphere(
      rings, 'push', getUnitRadiusToggle('push'), m.group,
      centerY, collider.push, this.radiusMatPush,
    );
  }

  /** Internal helper for the three UNIT RAD sphere toggles. All three
   *  share the same placement (unit sphere center, parented to the
   *  unit group) and differ only by color + radius. */
  private setUnitRadiusSphere(
    rings: { scale?: THREE.LineSegments; shot?: THREE.LineSegments; push?: THREE.LineSegments },
    key: 'scale' | 'shot' | 'push',
    want: boolean,
    parent: THREE.Group,
    centerY: number,
    radius: number,
    mat: THREE.LineBasicMaterial,
  ): void {
    let mesh = rings[key];
    if (want) {
      if (!mesh) {
        mesh = new THREE.LineSegments(this.radiusSphereGeom, mat);
        parent.add(mesh);
        rings[key] = mesh;
      }
      mesh.visible = true;
      mesh.position.y = centerY;
      mesh.scale.setScalar(radius);
    } else if (mesh) {
      mesh.visible = false;
    }
  }

  /** Show/hide the per-unit TURR RAD wireframe spheres: tracking
   *  acquire/release and engage acquire/release are per-turret,
   *  centered at each weapon's 3D mount point (matches the sim's
   *  distance3 check in targetingSystem). Build range is per-unit,
   *  centered at the unit's sim sphere center (matches construction's
   *  distance3 check).
   *
   *  Spheres are parented to the WORLD group rather than the unit/
   *  turret group — they represent absolute world volumes and don't
   *  rotate with the hull. */
  private updateRangeRings(m: EntityMesh, entity: Entity): void {
    const unit = entity.unit;
    if (!unit) return;

    const showTrackAcquire = getRangeToggle('trackAcquire');
    const showTrackRelease = getRangeToggle('trackRelease');
    const showEngageAcquire = getRangeToggle('engageAcquire');
    const showEngageRelease = getRangeToggle('engageRelease');
    const showBuild = getRangeToggle('build');

    const ux = entity.transform.x;
    const uy = entity.transform.y;
    const uz = entity.transform.z;
    const cos = Math.cos(entity.transform.rotation);
    const sin = Math.sin(entity.transform.rotation);

    // Per-turret spheres — same center the sim's targeting code uses,
    // so what you see is exactly the volume the sim tests against.
    if (entity.turrets) {
      for (let i = 0; i < entity.turrets.length; i++) {
        const weapon = entity.turrets[i];
        const tm = m.turrets[i];
        if (!tm) continue;
        const wp = getWeaponWorldPosition(ux, uy, cos, sin, weapon.offset.x, weapon.offset.y);
        // Mount Z was cached on weapon.worldPos by targetingSystem;
        // fall back to unit-sphere-center when targeting hasn't run
        // yet this tick (new units).
        const mountZ = weapon.worldPos?.z ?? uz;

        this.setRangeSphere(
          tm, 'trackAcquire', showTrackAcquire, wp.x, wp.y, mountZ,
          weapon.ranges.tracking.acquire, this.ringMatTrackAcquire,
        );
        this.setRangeSphere(
          tm, 'trackRelease', showTrackRelease, wp.x, wp.y, mountZ,
          weapon.ranges.tracking.release, this.ringMatTrackRelease,
        );
        this.setRangeSphere(
          tm, 'engageAcquire', showEngageAcquire, wp.x, wp.y, mountZ,
          weapon.ranges.engage.acquire, this.ringMatEngageAcquire,
        );
        this.setRangeSphere(
          tm, 'engageRelease', showEngageRelease, wp.x, wp.y, mountZ,
          weapon.ranges.engage.release, this.ringMatEngageRelease,
        );
      }
    }

    // Build range (builder-only, centered on the unit's sim sphere).
    const builder = entity.builder;
    if (showBuild && builder) {
      if (!m.buildRing) {
        m.buildRing = new THREE.LineSegments(this.radiusSphereGeom, this.ringMatBuild);
        this.world.add(m.buildRing);
      }
      m.buildRing.visible = true;
      // sim(x,y,z) → three(x,z,y).
      m.buildRing.position.set(ux, uz, uy);
      m.buildRing.scale.setScalar(builder.buildRange);
    } else if (m.buildRing) {
      m.buildRing.visible = false;
    }
  }

  /** Internal helper: create-if-missing / update-if-visible / hide for
   *  a single per-turret TURR RAD sphere. Keeps the four toggle
   *  branches in updateRangeRings from duplicating the lazy-create
   *  dance. */
  private setRangeSphere(
    tm: TurretMesh,
    key: 'trackAcquire' | 'trackRelease' | 'engageAcquire' | 'engageRelease',
    want: boolean,
    cx: number, cy: number, cz: number,
    radius: number,
    mat: THREE.LineBasicMaterial,
  ): void {
    const rings = tm.rangeRings ?? (tm.rangeRings = {});
    let ring = rings[key];
    if (want) {
      if (!ring) {
        ring = new THREE.LineSegments(this.radiusSphereGeom, mat);
        this.world.add(ring);
        rings[key] = ring;
      }
      ring.visible = true;
      // sim(x,y,z) → three(x,z,y).
      ring.position.set(cx, cz, cy);
      ring.scale.setScalar(radius);
    } else if (ring) {
      ring.visible = false;
    }
  }

  update(): void {
    // Refresh LOD snapshot once per frame. If the global LOD changed since
    // the last frame, tear down all unit meshes so updateUnits() rebuilds
    // them at the new level — the simplest way to keep every sub-mesh
    // (body, turrets, legs, locomotion, mirrors) consistent with the
    // current GraphicsConfig.
    const newLod = snapshotLod();
    if (newLod.key !== this.lod.key) {
      this.rebuildAllUnitsOnLodChange();
    }
    this.lod = newLod;

    // Time step for continuous-rotation effects (barrel spin, wheel roll).
    // Clamp in case the tab was backgrounded.
    const now = performance.now();
    const spinDt = Math.min((now - this._lastSpinMs) / 1000, 0.1);
    this._lastSpinMs = now;
    this._currentDtMs = spinDt * 1000;

    this.updateBarrelSpins(spinDt);
    this.updateUnits();
    this.updateBuildings();
    this.updateProjectiles();
  }

  private _currentDtMs = 0;

  /** Wipe every cached unit mesh so the next updateUnits() rebuilds them at
   *  the current LOD. Explosions / projectiles / tile grid don't need a rebuild
   *  — their per-frame loops already read the LOD snapshot directly. */
  private rebuildAllUnitsOnLodChange(): void {
    for (const m of this.unitMeshes.values()) {
      destroyLocomotion(m.locomotion);
      this.world.remove(m.group);
      this.disposeWorldParentedOverlays(m);
    }
    this.unitMeshes.clear();
    this.barrelSpins.clear();
  }

  /** LOW-tier per-frame instance write. Each visible unit takes one
   *  slot in the InstancedMesh; the slot's matrix encodes its world
   *  pose (translation + Y-rotation + uniform scale by render radius)
   *  and the color attribute carries its team primary. Slots vacated
   *  by removed units go on the free list to be reused.
   *
   *  GPU cost: one draw call total + N vertex-shader invocations.
   *  CPU cost: one Matrix4.compose + setMatrixAt + setColorAt per
   *  visible unit per frame, no allocations. */
  private updateUnitsInstanced(): void {
    const im = this.unitInstanced;
    if (!im) return;

    const units = this.clientViewState.getUnits();
    const seen = this._seenUnitIds;
    seen.clear();

    for (const e of units) {
      seen.add(e.id);
      // Out-of-scope units still get a slot (so they reappear instantly
      // when the camera pans back) but their slot transform stays at
      // the last known pose; instanced rendering doesn't have the
      // per-unit destruction cost the per-Mesh path was avoiding.
      if (!this.scope.inScope(e.transform.x, e.transform.y, 100)) continue;

      let slot = this.unitInstancedSlot.get(e.id);
      if (slot === undefined) {
        if (this.unitInstancedFreeSlots.length > 0) {
          slot = this.unitInstancedFreeSlots.pop()!;
        } else if (this.unitInstancedNextSlot < Render3DEntities.LOW_INSTANCED_CAP) {
          slot = this.unitInstancedNextSlot++;
        } else {
          // Cap exhausted — drop this unit's render. Sim still runs.
          continue;
        }
        this.unitInstancedSlot.set(e.id, slot);
      }

      const radius = e.unit?.unitRadiusCollider.scale
        ?? e.unit?.unitRadiusCollider.shot
        ?? 15;
      const pushR = e.unit?.unitRadiusCollider.push ?? 0;

      // Mirror of the per-unit Mesh path: group at (x, z-pushR, y),
      // chassis at origin, sphere at chassis-local y=1 with chassis
      // scaled by radius. Composed into a single matrix here.
      this._instPos.set(
        e.transform.x,
        e.transform.z - pushR + radius,
        e.transform.y,
      );
      this._instQuat.setFromAxisAngle(_INST_UP, -e.transform.rotation);
      this._instScale.set(radius, radius, radius);
      this._instMatrix.compose(this._instPos, this._instQuat, this._instScale);
      im.setMatrixAt(slot, this._instMatrix);

      const pid = e.ownership?.playerId;
      this._instColor.set(pid !== undefined ? getPlayerColors(pid).primary : 0x888888);
      im.setColorAt(slot, this._instColor);
    }

    // Free slots for units that disappeared this frame.
    for (const [id, slot] of this.unitInstancedSlot) {
      if (!seen.has(id)) {
        im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
        this.unitInstancedFreeSlots.push(slot);
        this.unitInstancedSlot.delete(id);
      }
    }

    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  /** Tier flipped from LOW to MED+: hide every active instanced slot
   *  and drop the slot map so the next LOW pass starts fresh (and
   *  colors get re-applied to whatever pid currently owns each slot). */
  private releaseAllInstancedSlots(): void {
    const im = this.unitInstanced;
    if (!im) return;
    for (const slot of this.unitInstancedSlot.values()) {
      im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
    }
    this.unitInstancedSlot.clear();
    this.unitInstancedFreeSlots.length = 0;
    this.unitInstancedNextSlot = 0;
    im.instanceMatrix.needsUpdate = true;
  }

  /** Remove every overlay mesh that lives in the world group (not the
   *  unit group) so a teardown/rebuild cycle doesn't leak them into
   *  the scene. TURR RAD spheres (per-turret) and BLD build sphere
   *  are the only ones in this category — they represent absolute
   *  world volumes keyed to the turret mount / unit center. UNIT RAD
   *  spheres (SCAL/SHOT/PUSH) ride the unit group and leave alongside
   *  m.group. */
  private disposeWorldParentedOverlays(m: EntityMesh): void {
    if (m.buildRing) this.world.remove(m.buildRing);
    for (const tm of m.turrets) {
      if (tm.rangeRings) {
        if (tm.rangeRings.trackAcquire)  this.world.remove(tm.rangeRings.trackAcquire);
        if (tm.rangeRings.trackRelease)  this.world.remove(tm.rangeRings.trackRelease);
        if (tm.rangeRings.engageAcquire) this.world.remove(tm.rangeRings.engageAcquire);
        if (tm.rangeRings.engageRelease) this.world.remove(tm.rangeRings.engageRelease);
      }
    }
    // Selection ring is parented to m.group and gets GC'd with the
    // group; its material is the shared `selectionRingMat`, owned by
    // the renderer, so no per-unit dispose.
    m.ring = undefined;
  }


  /**
   * Advance each unit's barrel-spin state (angle, speed). Mirrors the 2D
   * updateBarrelSpins loop exactly: pick the first multi-barrel turret on
   * each unit for its spin config, accelerate toward max while any turret
   * is engaged, decelerate toward idle otherwise.
   */
  private updateBarrelSpins(dt: number): void {
    const units = this.clientViewState.getUnits();
    const seen = this._seenSpinIds;
    seen.clear();

    for (const entity of units) {
      if (!entity.turrets) continue;
      seen.add(entity.id);

      let spinConfig: SpinConfig | undefined;
      for (const w of entity.turrets) {
        const bc = w.config.barrel;
        if (
          bc
          && (bc.type === 'simpleMultiBarrel' || bc.type === 'coneMultiBarrel')
        ) {
          spinConfig = bc.spin;
          break;
        }
      }
      if (!spinConfig) continue;

      let state = this.barrelSpins.get(entity.id);
      if (!state) {
        state = { angle: 0, speed: spinConfig.idle };
        this.barrelSpins.set(entity.id, state);
      }

      const firing = entity.turrets.some((w) => w.state === 'engaged');
      if (firing) {
        state.speed = Math.min(state.speed + spinConfig.accel * dt, spinConfig.max);
      } else {
        state.speed = Math.max(state.speed - spinConfig.decel * dt, spinConfig.idle);
      }
      // Keep angle bounded to [0, 2π) so Float32 precision doesn't drift over long games.
      state.angle = (state.angle + state.speed * dt) % (Math.PI * 2);
    }

    // Drop state for units that no longer exist.
    for (const id of this.barrelSpins.keys()) {
      if (!seen.has(id)) this.barrelSpins.delete(id);
    }
  }

  private updateUnits(): void {
    // MIN tier only: every unit is a single sphere drawn from one
    // InstancedMesh — collapses thousands of per-unit draw calls into
    // a single GPU dispatch. LOW and above still build the full
    // per-unit Group (chassis, turrets, legs/wheels, mirrors) so
    // there's a visible step between MIN and LOW: MIN trades all
    // detail for raw throughput, LOW keeps the simplified chassis
    // shapes shown in the 2D LOW preset.
    const isMinTier = this.lod.gfx.tier === 'min';
    if (isMinTier) {
      this.updateUnitsInstanced();
      return;
    }
    // We left MIN tier — release every instanced slot so stale ghosts
    // don't sit at scale 0 forever (and so colors recycle quickly when
    // we drop back to MIN).
    if (this.unitInstancedSlot.size > 0) {
      this.releaseAllInstancedSlots();
    }

    const units = this.clientViewState.getUnits();
    const seen = this._seenUnitIds;
    seen.clear();

    for (const e of units) {
      seen.add(e.id);
      // RENDER scope gate — skip all per-frame work for units outside
      // the camera rect. `seen` is still populated above so an off-
      // scope unit isn't mistakenly removed from the mesh map. The
      // mesh, if it exists, stays at its last-known pose; Three.js
      // frustum-culls it so there's nothing visible anyway. When the
      // unit re-enters scope the next frame's update repositions it.
      if (!this.scope.inScope(e.transform.x, e.transform.y, 100)) continue;
      // Use `scale` (visual) rather than `shot` (collider) for horizontal
      // footprint, matching the 2D renderer. Body height is per-unit
      // (see BodyShape3D / BodyDimensions); turrets mount on top of
      // whatever height the body resolves to.
      const radius = e.unit?.unitRadiusCollider.scale
        ?? e.unit?.unitRadiusCollider.shot
        ?? 15;
      const pid = e.ownership?.playerId;
      const turrets = e.turrets ?? [];

      let m = this.unitMeshes.get(e.id);
      if (!m) {
        const group = new THREE.Group();
        // Pull the 2D renderer id from the unit blueprint and use the
        // matching 3D body (scout=diamond, tank=pentagon, arachnid=big
        // sphere + small sphere, etc.). Falls back to arachnid for
        // unknown renderers.
        let rendererId = 'arachnid';
        try { rendererId = getUnitBlueprint(e.unit!.unitType).renderer ?? 'arachnid'; }
        catch { /* leave default */ }
        const bodyEntry = getBodyGeom(rendererId);
        // The chassis is a group so composite bodies (arachnid, beam,
        // commander — multiple spheres/spheroids) and single-part bodies
        // (tank, loris, …) share one code path. Each BodyMeshPart's
        // center offset and per-axis scale are expressed in
        // unit-radius-1 space, so we uniformly scale the whole chassis
        // group by the unit's render radius below and every part ends
        // up at the right world size and position.
        const chassis = new THREE.Group();
        chassis.userData.entityId = e.id;
        const chassisMeshes: THREE.Mesh[] = [];
        for (const part of bodyEntry.parts) {
          const mesh = new THREE.Mesh(part.geometry, this.getPrimaryMat(pid));
          mesh.position.set(part.x, part.y, part.z);
          mesh.scale.set(part.scaleX, part.scaleY, part.scaleZ);
          mesh.userData.entityId = e.id;
          chassis.add(mesh);
          chassisMeshes.push(mesh);
        }
        group.add(chassis);

        // Build one TurretMesh per actual turret on the entity. Each turret
        // has an optional head + barrel cylinders matching its barrel config.
        //
        // On mirror units (e.g. Loris) the blueprint lists the mirror turret
        // at index 0 and the shooting turret after it. The mirror panels are
        // aggregated to entity.unit.mirrorPanels with no per-turret tag, so
        // we mirror the 2D convention: the mirror host is turret[0], and any
        // additional turrets render normally with their own cylinder body.
        const unitHasMirrors = (e.unit?.mirrorPanels?.length ?? 0) > 0;
        const turretMeshes: TurretMesh[] = [];
        for (let ti = 0; ti < turrets.length; ti++) {
          const t = turrets[ti];
          const isMirrorHost = unitHasMirrors && ti === 0;
          const tm = buildTurretMesh3D(group, t, radius, isMirrorHost, this.lod.gfx, {
            headGeom: this.turretHeadGeom,
            barrelGeom: this.barrelGeom,
            barrelMat: this.barrelMat,
            primaryMat: this.getPrimaryMat(pid),
          });
          if (tm.head) tm.head.userData.entityId = e.id;
          for (const b of tm.barrels) b.userData.entityId = e.id;
          turretMeshes.push(tm);
        }

        this.world.add(group);
        m = { group, chassis, chassisMeshes, rendererId, turrets: turretMeshes, lodKey: this.lod.key };

        // Locomotion (tank treads / vehicle wheels / arachnid legs). Built
        // once per unit at the current LOD.
        //  - Treads / wheels are parented to the unit's group (they rotate
        //    with the chassis).
        //  - Legs are parented to the WORLD group directly so that feet can
        //    plant in world space during the snap-lerp gait while the unit
        //    rotates above them.
        m.locomotion = buildLocomotion(group, this.world, e, radius, pid, this.lod.gfx);


        // Mirror panels (e.g. Loris): standing slabs that track the turret.
        const mirrorPanels = e.unit?.mirrorPanels;
        if (mirrorPanels && mirrorPanels.length > 0) {
          // Panel column rises 2 × hostHeadRadius above the chassis top
          // — the same span the host turret's spherical head would
          // occupy if it weren't hidden — plus MIRROR_EXTRA_HEIGHT so
          // the panels read as taller than the head they replace. Host
          // turret is index 0; its bodyRadius (when set) wins.
          const hostHeadRadius = getTurretHeadRadius(radius, turrets[0]?.config);
          const panelTopY = bodyEntry.topY * radius + 2 * hostHeadRadius + MIRROR_EXTRA_HEIGHT;
          m.mirrors = buildMirrorMesh3D(
            group, mirrorPanels, panelTopY,
            this.mirrorGeom, this.getMirrorShinyMat(pid),
          );
          for (const panel of m.mirrors.panels) {
            panel.userData.entityId = e.id;
          }
        }

        this.unitMeshes.set(e.id, m);
      } else {
        const primaryMat = this.getPrimaryMat(pid);
        for (const mesh of m.chassisMeshes) mesh.material = primaryMat;
        for (const tm of m.turrets) {
          if (tm.head) tm.head.material = this.getPrimaryMat(pid);
        }
      }

      // Position group at the unit's footprint. sim.x → Three.x, sim.y
      // → Three.z (the existing horizontal convention). Vertical =
      // sim.z - radius: for a ground-resting unit sim.z == radius, so
      // the group sits at y=0 and the chassis/turret meshes inside it
      // still stack from the ground up. If the unit is pushed airborne
      // by an explosion or falling from an overhang, the entire group
      // lifts with it — no per-child Y touchups needed.
      const unitRadius = e.unit?.unitRadiusCollider.push ?? 0;
      m.group.position.set(e.transform.x, e.transform.z - unitRadius, e.transform.y);
      m.group.rotation.y = -e.transform.rotation;

      // Chassis body lives entirely in unit-radius-1 space (see
      // BodyShape3D). Uniformly scaling the chassis group by the unit's
      // render radius multiplies every child part's offset AND per-axis
      // scale by the same factor — so a sphere part at (x=0.3, y=0.55,
      // z=0) with scale (0.55, 0.55, 0.55) lands at the right place and
      // the right size automatically.
      const bodyEntry = getBodyGeom(m.rendererId);
      m.chassis.position.set(0, 0, 0);
      m.chassis.scale.setScalar(radius);
      // Turrets now mount on top of the per-unit body instead of a
      // shared CHASSIS_HEIGHT constant. Spheroid-bodied units like the
      // arachnid get a tall mount; squat polygons (scout, burst) get a
      // lower one.
      const bodyTopY = bodyEntry.topY * radius;

      // Selection ring (flat ring on ground under the unit). Material
      // is the renderer-owned shared instance; mesh is per-unit so its
      // scale tracks the unit's render radius.
      const selected = e.selectable?.selected === true;
      if (selected && !m.ring) {
        const ring = new THREE.Mesh(this.ringGeom, this.selectionRingMat);
        ring.rotation.x = -Math.PI / 2;
        // Group is at ground; ring sits just above ground to avoid z-fighting.
        ring.position.y = 1;
        m.group.add(ring);
        m.ring = ring;
      } else if (!selected && m.ring) {
        m.group.remove(m.ring);
        m.ring = undefined;
      }
      if (m.ring) {
        const ringR = radius * 1.35;
        m.ring.scale.set(ringR, ringR, 1);
      }

      // SCAL / SHOT / PUSH unit-radius indicator rings. The 2D renderer
      // draws these as stroked circles at the respective collider radii;
      // here we mirror the same toggle → ring visibility behaviour.
      this.updateRadiusRings(m, e);
      this.updateRangeRings(m, e);

      // Per-turret placement. Turret offset is chassis-local in sim coords
      // (x, y) which map to (x, z) in three. Root Y sits at the top of the
      // chassis; the head + barrels extend upward from there inside the root.
      // On mirror-host units (e.g. Loris) turret[0] IS the mirror — any
      // shooting turrets after it sit on top of the mirror stack, matching
      // getTurretMountHeight() on the sim side.
      const spinState = this.barrelSpins.get(e.id);
      const unitHasMirrorsHere = (e.unit?.mirrorPanels?.length ?? 0) > 0;
      const hostHeadRadiusForStack = unitHasMirrorsHere
        ? getTurretHeadRadius(radius, turrets[0]?.config)
        : 0;
      for (let i = 0; i < m.turrets.length && i < turrets.length; i++) {
        const tm = m.turrets[i];
        const t = turrets[i];
        // Non-mirror turrets on mirror-host units sit ON TOP of the
        // mirror panel stack: root Y = panel top in chassis-local
        // coords = bodyTopY + 2·hostHeadRadius + MIRROR_EXTRA_HEIGHT.
        const turretMountY = unitHasMirrorsHere && i > 0
          ? bodyTopY + 2 * hostHeadRadiusForStack + MIRROR_EXTRA_HEIGHT
          : bodyTopY;
        tm.root.position.set(t.offset.x, turretMountY, t.offset.y);
        // Turret's world firing direction = t.rotation. Parent group is already
        // rotated by -chassis.rotation, so we compensate: child local Y rot =
        // -(t.rotation - chassis.rotation), which makes local +X point in the
        // correct world firing direction after both rotations compose.
        tm.root.rotation.y = -(t.rotation - e.transform.rotation);
        // Pitch (vertical aim) tilts the pitch group around local Z so
        // positive pitch rotates +X (the barrel's firing direction)
        // toward +Y (up). Spin then rotates the nested spin group
        // around its OWN local +X — which, because spinGroup lives
        // under pitchGroup, is the pitched firing axis. So gatling
        // barrels roll around the real barrel direction at any
        // elevation, not around world-X.
        if (tm.pitchGroup) tm.pitchGroup.rotation.z = t.pitch;
        if (tm.spinGroup) {
          tm.spinGroup.rotation.x = this.lod.gfx.barrelSpin
            ? spinState?.angle ?? 0
            : 0;
        }
      }

      // Mirror panels: track the first turret's rotation. Pitch tilts
      // each panel around its edge axis so the rectangle the player
      // sees lines up with the rectangle the sim's beam tracer uses.
      //
      // SIGN of rotation.x: positive sim pitch means the panel's NORMAL
      // tilts upward — which, for a normal that starts pointing forward
      // (+sim X), requires the panel's TOP to lean BACKWARD. With Euler
      // YXZ the X rotation is applied around the panel's default-local
      // X axis (its width axis, before the Y flip). For our Y rotation
      // of -(angle + π/2) the right sign is +mirrorPitch — using -mirrorPitch
      // would tilt the visible panel forward while the sim treats it as
      // tilting backward, so the rendered chrome would lean opposite to
      // where the sim's reflection plane actually sits.
      if (m.mirrors) {
        const mirrorRot = turrets[0]?.rotation ?? e.transform.rotation;
        const mirrorPitch = turrets[0]?.pitch ?? 0;
        m.mirrors.root.rotation.y = -(mirrorRot - e.transform.rotation);
        for (const panel of m.mirrors.panels) {
          panel.rotation.x = mirrorPitch;
        }
      }

      // Locomotion: spin tread wheels per velocity; wheels/legs are static.
      if (m.locomotion) {
        updateLocomotion(m.locomotion, e, this._currentDtMs);
      }

      // Health bar handled by the shared HealthBarOverlay (SVG layer).
    }

    // Remove meshes for units no longer present.
    for (const [id, m] of this.unitMeshes) {
      if (!seen.has(id)) {
        destroyLocomotion(m.locomotion);
        this.world.remove(m.group);
        this.disposeWorldParentedOverlays(m);
        this.unitMeshes.delete(id);
      }
    }
  }

  private updateBuildings(): void {
    const buildings = this.clientViewState.getBuildings();
    const seen = this._seenBuildingIds;
    seen.clear();

    for (const e of buildings) {
      seen.add(e.id);
      // Scope gate — larger padding for buildings (bigger footprint).
      if (!this.scope.inScope(e.transform.x, e.transform.y, 200)) continue;
      const w = e.building?.width ?? 100;
      const d = e.building?.height ?? 100;
      const pid = e.ownership?.playerId;
      // Building type drives the per-type shape (factory, solar, …) —
      // fallback to 'unknown' for anything the art doesn't cover yet.
      const shapeType: BuildingShapeType =
        e.buildingType === 'factory' || e.buildingType === 'solar'
          ? e.buildingType
          : 'unknown';

      let m = this.buildingMeshes.get(e.id);
      if (!m) {
        const group = new THREE.Group();
        // Build the type-specific mesh set (primary slab + decorative
        // accents like chimney, solar cells). Primary material is the
        // team primary color; details carry their own shared materials
        // so they don't re-color across teams.
        const shape = buildBuildingShape(shapeType, w, d, this.getPrimaryMat(pid));
        shape.primary.userData.entityId = e.id;
        // Wrap the primary slab in an unscaled group so EntityMesh's
        // shared `chassis: Group` / `chassisMeshes: Mesh[]` shape works
        // for both buildings and units. The per-frame update below
        // positions and scales the primary slab directly.
        const chassis = new THREE.Group();
        chassis.add(shape.primary);
        group.add(chassis);
        for (const detail of shape.details) group.add(detail);
        this.world.add(group);
        m = {
          group,
          chassis,
          chassisMeshes: [shape.primary],
          // Buildings don't use a unit-renderer body shape (they have
          // their own BuildingShape3D path), so the field is unused
          // here — empty string is fine since the unit-update loop
          // never reaches a building.
          rendererId: '',
          turrets: [],
          lodKey: this.lod.key,
          // Store the accent meshes separately so the LOD-key rebuild
          // path (if we ever add one for buildings) knows what to
          // discard along with the primary.
          buildingDetails: shape.details,
          buildingHeight: shape.height,
        };
        this.buildingMeshes.set(e.id, m);
      } else {
        const primaryMat = this.getPrimaryMat(pid);
        for (const mesh of m.chassisMeshes) mesh.material = primaryMat;
      }

      // Group at ground; box elevated inside so it sits on the ground plane.
      m.group.position.set(e.transform.x, 0, e.transform.y);
      m.group.rotation.y = -e.transform.rotation;
      const h = m.buildingHeight ?? BUILDING_HEIGHT;

      // Build-progress visual — mirrors the 2D BuildingRenderer's
      // bottom-up fill. Primary slab scales vertically by buildProgress
      // (clamped to a small minimum so a 0% building still catches
      // light and is clickable); accent meshes (chimney, solar cells)
      // stay hidden until the building is complete so they don't pop
      // out of an incomplete silhouette.
      const buildable = e.buildable;
      const progress =
        buildable && !buildable.isComplete
          ? Math.max(0.05, Math.min(1, buildable.buildProgress))
          : 1;
      const renderH = h * progress;
      // Buildings own the single primary slab at chassisMeshes[0]; scale
      // it directly instead of the chassis wrapper group (which stays
      // at identity so the building-detail meshes added alongside it
      // aren't affected).
      const primary = m.chassisMeshes[0];
      primary.position.set(0, renderH / 2, 0);
      primary.scale.set(w, renderH, d);
      if (m.buildingDetails) {
        const detailsVisible = progress >= 1;
        for (const dMesh of m.buildingDetails) dMesh.visible = detailsVisible;
      }

      // Health + build-progress bars handled by the shared HealthBarOverlay.
    }

    for (const [id, m] of this.buildingMeshes) {
      if (!seen.has(id)) {
        this.world.remove(m.group);
        this.buildingMeshes.delete(id);
      }
    }
  }

  private updateProjectiles(): void {
    const projectiles = this.clientViewState.getProjectiles();
    const seen = this._seenProjectileIds;
    seen.clear();

    for (const e of projectiles) {
      // Skip beams/lasers — handled by BeamRenderer3D as line segments rather
      // than spheres. Without this, long-range beams would render as a single
      // sphere at the wrong position.
      const pt = e.projectile?.projectileType;
      if (pt === 'beam' || pt === 'laser') continue;

      seen.add(e.id);
      // Scope gate — tighter padding (projectiles are small and moving fast).
      if (!this.scope.inScope(e.transform.x, e.transform.y, 50)) continue;
      const shot = e.projectile?.config.shot;
      // Projectile shots have collision.radius
      let radius = 4;
      if (shot && shot.type === 'projectile') radius = shot.collision.radius;
      const isCylinder = shot && shot.type === 'projectile' && shot.shape === 'cylinder';

      let mesh = this.projectileMeshes.get(e.id);
      // Tear down + rebuild if the shape changed (rare — only happens
      // when a slot is reused for a different shot type, which should
      // not occur for a single live projectile but is safe regardless).
      if (mesh) {
        const wantsCyl = isCylinder ? this.projectileCylinderGeom : this.projectileGeom;
        if (mesh.geometry !== wantsCyl) {
          this.world.remove(mesh);
          this.projectileMeshes.delete(e.id);
          mesh = undefined;
        }
      }
      if (!mesh) {
        const geom = isCylinder ? this.projectileCylinderGeom : this.projectileGeom;
        mesh = new THREE.Mesh(geom, this.projectileMat);
        this.world.add(mesh);
        this.projectileMeshes.set(e.id, mesh);
      }

      // Projectile altitude is authoritative sim state (arcs through
      // real z from turret muzzle to ground / target). SHOT_HEIGHT is
      // no longer the truth — the sphere renders exactly where the
      // sim says it is.
      mesh.position.set(e.transform.x, e.transform.z, e.transform.y);

      if (isCylinder) {
        // Cylinder rocket body: stretch along its local +Y, then rotate
        // so +Y aligns with the projectile's velocity vector. World
        // length = radius · lengthMult, world diameter = radius ·
        // diameterMult — both pulled from the shot's `cylinderShape`
        // block so a designer can tune rocket aspect ratios per blueprint
        // (lightRocket vs heavyMissile vs torpedo etc.). The sim
        // collision footprint stays a sphere of collision.radius —
        // this is purely a render hint.
        const r = Math.max(radius, PROJECTILE_MIN_RADIUS);
        const cylSpec = (shot && shot.type === 'projectile') ? shot.cylinderShape : undefined;
        const lengthMult = cylSpec?.lengthMult ?? Render3DEntities._PROJ_CYL_LENGTH_MULT_DEFAULT;
        const diameterMult = cylSpec?.diameterMult ?? Render3DEntities._PROJ_CYL_DIAMETER_MULT_DEFAULT;
        const length = r * lengthMult;
        const diameter = r * diameterMult;
        mesh.scale.set(diameter, length, diameter);
        const proj = e.projectile;
        if (proj) {
          // sim(x, y, z) → three(x, z, y), so velocity components map
          // the same way. If velocity is near zero (just-spawned, paused)
          // fall through to identity rotation rather than NaN.
          const vx = proj.velocityX, vy = proj.velocityY, vz = proj.velocityZ;
          const len2 = vx * vx + vy * vy + vz * vz;
          if (len2 > 1e-6) {
            const inv = 1 / Math.sqrt(len2);
            this._projDir.set(vx * inv, vz * inv, vy * inv);
            this._projQuat.setFromUnitVectors(
              Render3DEntities._PROJ_CYL_AXIS,
              this._projDir,
            );
            mesh.quaternion.copy(this._projQuat);
          }
        }
      } else {
        // Match 2D: `fillCircle(x, y, radius)` — the sphere's world-space radius
        // equals the sim's shot.collision.radius. SphereGeometry has radius 1,
        // so setScalar(radius) is the correct scale.
        mesh.scale.setScalar(Math.max(radius, PROJECTILE_MIN_RADIUS));
      }

      this.updateProjRadiusMeshes(e);
    }

    for (const [id, mesh] of this.projectileMeshes) {
      if (!seen.has(id)) {
        this.world.remove(mesh);
        this.projectileMeshes.delete(id);
      }
    }
    // Drop SHOT RAD wireframes that went with despawned projectiles.
    for (const [id, radii] of this.projectileRadiusMeshes) {
      if (!seen.has(id)) {
        if (radii.collision) this.world.remove(radii.collision);
        if (radii.primary) this.world.remove(radii.primary);
        if (radii.secondary) this.world.remove(radii.secondary);
        this.projectileRadiusMeshes.delete(id);
      }
    }
  }

  /** Show/hide the per-projectile SHOT RAD wireframe spheres. COL is
   *  the actual collision capsule the swept-line 3D test uses; PRM/SEC
   *  are the splash-damage spheres for area damage on detonation.
   *
   *  Spheres (not rings) because every one of these sim checks is 3D:
   *  `lineSphereIntersectionT` for COL, `sqrt(dx²+dy²+dz²)` for PRM/SEC
   *  against units. Drawing flat rings would under-sell what the sim
   *  tests — a high-arc shell's primary blast genuinely catches airborne
   *  targets above it. */
  private updateProjRadiusMeshes(entity: Entity): void {
    const proj = entity.projectile;
    if (!proj) return;
    const shot = proj.config.shot;
    if (shot.type !== 'projectile') return;

    const wantCol = getProjRangeToggle('collision');
    const wantPrm = getProjRangeToggle('primary');
    const wantSec = getProjRangeToggle('secondary');
    if (!wantCol && !wantPrm && !wantSec) {
      // Fast path — nothing to show. Hide anything that was visible
      // last frame so flipping the toggle off doesn't leave a stale
      // sphere floating around.
      const existing = this.projectileRadiusMeshes.get(entity.id);
      if (existing) {
        if (existing.collision) existing.collision.visible = false;
        if (existing.primary) existing.primary.visible = false;
        if (existing.secondary) existing.secondary.visible = false;
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
      shot.collision.radius,
      this.projMatCollision,
    );
    this.setProjRadiusMesh(
      radii, 'primary', wantPrm && !proj.hasExploded,
      projX, projY, projZ,
      shot.explosion?.primary.radius ?? 0,
      this.projMatPrimary,
    );
    this.setProjRadiusMesh(
      radii, 'secondary', wantSec && !proj.hasExploded,
      projX, projY, projZ,
      shot.explosion?.secondary.radius ?? 0,
      this.projMatSecondary,
    );
  }

  /** Internal helper — create/show/hide one of the three SHOT RAD
   *  wireframe spheres on a projectile. */
  private setProjRadiusMesh(
    radii: { collision?: THREE.LineSegments; primary?: THREE.LineSegments; secondary?: THREE.LineSegments },
    key: 'collision' | 'primary' | 'secondary',
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
      mesh = new THREE.LineSegments(this.radiusSphereGeom, mat);
      this.world.add(mesh);
      radii[key] = mesh;
    }
    mesh.visible = true;
    // sim(x,y,z) → three(x,z,y). Sphere already lives at origin; scale
    // is the sim radius so its world size matches what the collision
    // code tests against.
    mesh.position.set(x, z, y);
    mesh.scale.setScalar(radius);
  }

  destroy(): void {
    // Per-unit overlays (TURR RAD rings, BLD ring, SCAL + PUSH rings)
    // are parented to the world group rather than the unit group so
    // they stay flat on the ground regardless of unit rotation /
    // altitude — destroy() has to release them explicitly.
    for (const m of this.unitMeshes.values()) {
      destroyLocomotion(m.locomotion);
      this.world.remove(m.group);
      this.disposeWorldParentedOverlays(m);
    }
    for (const m of this.buildingMeshes.values()) this.world.remove(m.group);
    for (const mesh of this.projectileMeshes.values()) this.world.remove(mesh);
    for (const radii of this.projectileRadiusMeshes.values()) {
      if (radii.collision) this.world.remove(radii.collision);
      if (radii.primary) this.world.remove(radii.primary);
      if (radii.secondary) this.world.remove(radii.secondary);
    }
    this.unitMeshes.clear();
    this.buildingMeshes.clear();
    this.projectileMeshes.clear();
    this.projectileRadiusMeshes.clear();
    disposeBodyGeoms();
    disposeBuildingGeoms();
    this.turretHeadGeom.dispose();
    this.barrelGeom.dispose();
    this.projectileGeom.dispose();
    this.projectileCylinderGeom.dispose();
    this.projectileMat.dispose();
    this.buildingGeom.dispose();
    this.ringGeom.dispose();
    this.radiusSphereGeom.dispose();
    this.radiusMatScale.dispose();
    this.radiusMatShot.dispose();
    this.radiusMatPush.dispose();
    this.ringMatTrackAcquire.dispose();
    this.ringMatTrackRelease.dispose();
    this.ringMatEngageAcquire.dispose();
    this.ringMatEngageRelease.dispose();
    this.ringMatBuild.dispose();
    this.selectionRingMat.dispose();
    this.projMatCollision.dispose();
    this.projMatPrimary.dispose();
    this.projMatSecondary.dispose();
    this.mirrorGeom.dispose();
    for (const m of this.mirrorShinyMats.values()) m.dispose();
    this.mirrorShinyMats.clear();
    this.mirrorShinyNeutralMat.dispose();
    this.barrelMat.dispose();
    for (const m of this.primaryMats.values()) m.dispose();
    this.neutralMat.dispose();
    if (this.unitInstanced) {
      this.world.remove(this.unitInstanced);
      // The InstancedMesh's geometry (unitSphereLowGeom) is also held
      // as a class field disposed below; the material is a private
      // MeshLambertMaterial only owned by this InstancedMesh, so
      // dispose it via the mesh.
      (this.unitInstanced.material as THREE.Material).dispose();
      this.unitInstanced.dispose();
      this.unitInstanced = null;
    }
    this.unitSphereLowGeom.dispose();
    this.unitInstancedSlot.clear();
    this.unitInstancedFreeSlots.length = 0;
  }
}
