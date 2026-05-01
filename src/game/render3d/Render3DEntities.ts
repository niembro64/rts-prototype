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
import type { UnitBodyShape } from '@/types/blueprints';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import type { SprayTarget } from '@/types/ui';
import { getPlayerColors } from '../sim/types';
import type { SpinConfig } from '../../config';
import {
  MIRROR_EXTRA_HEIGHT,
  WIND_TURBINE_DRIFT_EMA_HALF_LIFE_MULTIPLIERS,
  WIND_TURBINE_ROTOR_RAD_PER_SEC_PER_WIND_SPEED,
} from '../../config';
import { getGroundNormal } from '../sim/Terrain';
import type { ClientViewState } from '../network/ClientViewState';
import {
  buildLocomotion,
  updateLocomotion,
  destroyLocomotion,
  getChassisLift,
  type Locomotion3DMesh,
} from './Locomotion3D';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import {
  lodKey,
  snapshotLod,
  type Lod3DState,
} from './Lod3D';
import {
  isRichObjectLod,
  objectLodToGraphicsTier,
  type RenderObjectLodTier,
} from './RenderObjectLod';
import { RenderLodGrid } from './RenderLodGrid';
import { getBodyGeom, getBodyMountTopY, disposeBodyGeoms } from './BodyShape3D';
import {
  buildBuildingShape,
  buildConstructionEmitterRig,
  disposeBuildingGeoms,
  getConstructionHazardMaterial,
  type BuildingDetailMesh,
  type ConstructionEmitterRig,
  type ExtractorRig,
  type FactoryConstructionRig,
  type WindTurbineRig,
  type BuildingShapeType,
  type SolarPetalAnimation,
} from './BuildingShape3D';
import type { ViewportFootprint } from '../ViewportFootprint';
import { getUnitBlueprint } from '../sim/blueprints';
import { getFactoryBuildSpot, getFactoryConstructionRadius, type FactoryBuildSpot } from '../sim/factoryConstructionSite';
import { getDriftMode, getGraphicsConfigFor, getUnitRadiusToggle, getRangeToggle, getProjRangeToggle } from '@/clientBarConfig';
import { getDriftPreset, halfLifeBlend } from '../network/driftEma';
import { getWeaponWorldPosition, getTurretHeadRadius, lerp, lerpAngle } from '../math';
import { buildTurretMesh3D, type TurretMesh } from './TurretMesh3D';
import { buildMirrorMesh3D, type MirrorMesh } from './MirrorMesh3D';

// Turret head height is the one remaining shared vertical constant —
// chassis heights are now per-unit (see getBodyTopY in BodyDimensions.ts).
// The sim's projectile-spawn code (getUnitMuzzleHeight in
// combat/combatUtils.ts) derives muzzle altitude from the same body-top
// value so visual barrel tip and sim muzzle stay locked together.

const BUILDING_HEIGHT = 120;
const SOLAR_PETAL_ANIM_ALPHA = 0.16;
const EXTRACTOR_ROTOR_RAD_PER_SEC = 2.4;
const PROJECTILE_MIN_RADIUS = 1.5;   // floor so very-small shots stay visible
const BARREL_COLOR = 0xffffff;

const PROJECTILE_RADIUS_BY_TIER: Record<ConcreteGraphicsQuality, number> = {
  min: 0.7,
  low: 0.8,
  medium: 0.9,
  high: 1,
  max: 1,
};

// Module-level rotation axis reused by the LOW-tier instanced sphere
// path. Three.js' Quaternion.setFromAxisAngle reads the axis as an
// (input) Vector3, but never mutates it.
const _INST_UP = new THREE.Vector3(0, 1, 0);
const LOW_INSTANCED_COMPACT_MIN_FREE = 128;
const LOW_INSTANCED_COMPACT_INTERVAL_FRAMES = 30;
const LOW_INSTANCED_COMPACT_MAX_MOVES = 256;
const MASS_INSTANCE_MATRIX_STRIDE: Record<RenderObjectLodTier, number> = {
  hero: 1,
  rich: 1,
  simple: 1,
  mass: 2,
  impostor: 4,
  marker: 8,
};
const BUILDING_TIER_ORDER: Record<ConcreteGraphicsQuality, number> = {
  min: 0,
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
};

function buildingTierAtLeast(
  tier: ConcreteGraphicsQuality,
  minTier: ConcreteGraphicsQuality,
): boolean {
  return BUILDING_TIER_ORDER[tier] >= BUILDING_TIER_ORDER[minTier];
}

function buildingDetailVisible(
  detail: BuildingDetailMesh,
  tier: ConcreteGraphicsQuality,
): boolean {
  const level = BUILDING_TIER_ORDER[tier];
  return level >= BUILDING_TIER_ORDER[detail.minTier]
    && (detail.maxTier === undefined || level <= BUILDING_TIER_ORDER[detail.maxTier]);
}

function scaledWindTurbineHalfLife(baseHalfLife: number, multiplier: number): number {
  if (baseHalfLife <= 0 || multiplier <= 0) return 0;
  return baseHalfLife * multiplier;
}

// Scratch globals reused by the per-unit surface-tilt path so the
// per-frame loop allocates no quaternions/vectors. Tilt is applied
// to every unit, every frame — keep this fast.
const _threeUp = new THREE.Vector3(0, 1, 0);
const _tiltSurfaceN = new THREE.Vector3();
const _tiltQuat = new THREE.Quaternion();
// Inverse of the tilt quaternion — used to project a world barrel
// direction into the chassis-local (tiltGroup) frame so the turret's
// articulated yaw + pitch can compensate for the chassis tilt and
// the rendered barrel still points at the sim's world target.
const _invTiltQuat = new THREE.Quaternion();
// Scratch direction vector reused by every turret's compensation
// math each frame.
const _aimDir = new THREE.Vector3();

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
  /** Yaw subgroup. Hierarchy: `group` carries position + the surface
   *  TILT (world-frame), `yawGroup` carries the unit's facing yaw
   *  (around the chassis-local up axis = the slope's up). Locomotion
   *  (treads / wheels) lives directly inside `yawGroup` at ground
   *  level. The BODY (chassis, turrets, mirrors, force-field) lives
   *  inside `liftGroup` which is itself inside yawGroup but offset
   *  upward — so the locomotion stays on the ground while the body
   *  is held aloft, like a vehicle riding on its wheels.
   *  Undefined for buildings (no tilt / yaw plumbing). */
  yawGroup?: THREE.Group;
  /** Lift subgroup. Sits inside `yawGroup` with a positive Y offset
   *  (`Locomotion3D.getChassisLift(blueprint, unitRadius)`) — chassis,
   *  turret roots, mirror panels, and force-field meshes all parent
   *  here so they ride above the ground at the locomotion's natural
   *  height. Undefined for buildings; for units the offset is fixed
   *  at build time (locomotion config doesn't change) so no per-frame
   *  update is needed. */
  liftGroup?: THREE.Group;
  /** Cached lift amount (world units) computed at unit-add from
   *  `getChassisLift(blueprint, unitRadius)`. Used by the chassis
   *  InstancedMesh writers (smoothChassis + polyChassis) to apply the
   *  lift inside their manual matrix composition — those slots are
   *  parented to the world group, NOT the unit's liftGroup, so the
   *  scenegraph chain doesn't apply the lift for them. Cached on the
   *  EntityMesh to avoid re-looking-up the blueprint each frame. */
  chassisLift?: number;
  /** Parent for the chassis body parts. For units this is uniformly
   *  scaled by unitRadius so each BodyMeshPart's unit-radius-1 offset
   *  and per-axis scale both enlarge correctly. For buildings the group
   *  holds a single box mesh that's sized each frame to (w, renderH, d). */
  chassis: THREE.Group;
  /** All meshes inside `chassis` that carry the team primary material —
   *  updated whenever the owner changes (team reassignment, capture).
   *  Empty for smooth-body units that route their chassis through the
   *  shared `smoothChassis` InstancedMesh — see `smoothChassisSlots`. */
  chassisMeshes: THREE.Mesh[];
  /** Slot indices into the renderer's `smoothChassis` InstancedMesh,
   *  one per body part. Present on smooth-body units (arachnid, beam,
   *  snipe, commander, forceField, loris) at LOW+ tier; undefined for
   *  polygon / rect bodies (which use polyChassisSlot) and at MIN tier
   *  (where the LOW-tier `unitInstanced` path takes over entirely). */
  smoothChassisSlots?: number[];
  /** Single slot index into the per-renderer polygonal-chassis
   *  InstancedMesh (one InstancedMesh per polygon / rect renderer:
   *  scout, brawl, tank, burst, mortar, hippo). Present on polygon /
   *  rect units at LOW+ tier; undefined for smooth bodies (which use
   *  smoothChassisSlots) and at MIN tier. The pool that owns the slot
   *  is keyed by `rendererId`. */
  polyChassisSlot?: number;
  /** Cached renderer id (e.g. 'arachnid', 'tank') resolved once at
   *  mesh-build time. Unit-blueprint lookups in the per-frame update
   *  loop are wasted work — the unitType never changes for a live
   *  entity, so we stash the result here. */
  rendererId: string;
  bodyShape?: UnitBodyShape;
  turrets: TurretMesh[];
  mirrors?: MirrorMesh;
  locomotion?: Locomotion3DMesh;
  /** Selection ring mesh — material is the renderer-owned shared
   *  `selectionRingMat` (white for every selection), so we don't store
   *  a per-unit material reference. The mesh itself lives under
   *  `m.group` and is GC'd with the group on death. */
  ring?: THREE.Mesh;
  /** Outer camera-sphere marker for buildings. Units use the packed
   *  mass InstancedMesh for the same role; buildings need a tiny mesh
   *  because their normal render path is type-specific scenegraph art. */
  lodMarker?: THREE.Mesh;
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
   *  body. Empty / undefined for units. */
  buildingDetails?: BuildingDetailMesh[];
  constructionEmitter?: ConstructionEmitterRig;
  factoryRig?: FactoryConstructionRig;
  windRig?: WindTurbineRig;
  extractorRig?: ExtractorRig;
  /** Per-building render height (solar is shorter than the default). */
  buildingHeight?: number;
  /** True when the building primary mesh owns its material and should
   *  not be recolored to team primary on ownership updates. */
  buildingPrimaryMaterialLocked?: boolean;
  solarOpenAmount?: number;
  /** The LOD key this unit's geometry was built at. Render3DEntities rebuilds
   *  the mesh when the current frame's LOD key differs. */
  lodKey: string;
};

export class Render3DEntities {
  private world: THREE.Group;
  private clientViewState: ClientViewState;
  private camera: THREE.PerspectiveCamera;
  private getViewportHeight: () => number;
  /** Visibility scope (RENDER: WIN/PAD/ALL). Each per-entity update
   *  loop early-outs when the entity is outside this rect — skipping
   *  transform writes, locomotion IK, turret placement, etc.
   *  Three.js still handles GPU-side culling for the
   *  meshes themselves; this guards the CPU-side setup. */
  private scope: ViewportFootprint;
  /** Shared instanced cylinder pool for every leg in the scene.
   *  Flushed once per frame after every unit's locomotion has
   *  written into it; the GPU then draws all leg cylinders in 2
   *  draw calls (upper + lower). */
  private legRenderer!: LegInstancedRenderer;

  private unitMeshes = new Map<number, EntityMesh>();
  private buildingMeshes = new Map<number, EntityMesh>();
  private factorySprayTargets: SprayTarget[] = [];
  private factorySprayTargetPool: SprayTarget[] = [];
  private windFanYaw: number | null = null;
  private windVisualSpeed: number | null = null;
  private windRotorPhase = 0;
  private windAnimLastMs = 0;
  private extractorRotorPhase = 0;
  // Reusable "seen this frame" sets — the four per-frame update loops
  // (barrel-spin, unit, building, projectile) each need to track which
  // entity ids were visited so stale Map entries get pruned. Keeping
  // them as instance fields and calling `.clear()` at the top of each
  // loop avoids allocating a fresh Set on every render frame — four
  // Set allocations × 60 Hz = ~240 GC objects/sec otherwise.
  private _seenUnitIds = new Set<EntityId>();
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
    explosion?: THREE.LineSegments;
  }>();
  private projectileRadiusMeshPool: THREE.LineSegments[] = [];

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
  private commanderBoxGeom = new THREE.BoxGeometry(1, 1, 1);
  private commanderCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 18);
  private commanderDomeGeom = new THREE.SphereGeometry(1, 14, 10);
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
  private _projPos = new THREE.Vector3();
  private _projScale = new THREE.Vector3();
  private _projMatrix = new THREE.Matrix4();
  private _factorySprayTargetLocal = new THREE.Vector3();
  private _factorySpraySourceWorld = new THREE.Vector3();
  private _factorySprayTargetWorld = new THREE.Vector3();
  private _factoryBuildSpot: FactoryBuildSpot = {
    x: 0,
    y: 0,
    localX: 0,
    localY: 0,
    dirX: 0,
    dirY: 0,
    offset: 0,
  };
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
  private static readonly PROJECTILE_INSTANCED_CAP = 8192;
  private projectileSphereInstanced: THREE.InstancedMesh | null = null;
  private projectileCylinderInstanced: THREE.InstancedMesh | null = null;
  private buildingGeom = new THREE.BoxGeometry(1, 1, 1);
  private barrelMat = new THREE.MeshLambertMaterial({ color: BARREL_COLOR });
  // Mirror panel = flat unit square plane. Default orientation: face
  // in XY plane with normal +Z; we rotate it into the panel-local frame
  // (edge → +Z, normal → +X) per panel below. Plane has zero physical
  // thickness so the visible mesh and the sim collision rectangle live
  // on EXACTLY the same surface — no front/back offset where a beam
  // could appear to clip the visible chrome but miss the sim plane.
  private mirrorGeom = new THREE.PlaneGeometry(1, 1);
  // Selection-indicator halo. A low torus reads as a real 3D donut
  // around the unit instead of a flat 2D strip or billboarded band.
  // Geometry is unit-sized: major radius 1, tube radius 0.06. The
  // mesh is rotated into the XZ ground plane on creation and scaled
  // per unit below.
  private ringGeom = new THREE.TorusGeometry(1.0, 0.06, 8, 36);
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
  // instance covers every selectable entity. Was previously allocated
  // fresh on every (deselect → select) toggle, with a matching dispose
  // on deselect/death; that churned a MeshBasicMaterial per click.
  private selectionRingMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: 0x333333,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });

  // SHOT RAD wireframe spheres. These sim checks ARE 3D
  // (lineSphereIntersectionT for collision, 3D sqrt(dx²+dy²+dz²) for
  // area damage), so the viz is a 3D sphere — not a ring — to match
  // the real volume the sim tests. Separate materials per toggle so
  // overlapping spheres stay visually distinct.
  private projMatCollision = new THREE.LineBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.55, depthWrite: false });
  private projMatExplosion = new THREE.LineBasicMaterial({ color: 0xff8844, transparent: true, opacity: 0.35, depthWrite: false });

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
  private commanderArmorMat = new THREE.MeshLambertMaterial({ color: 0x232830 });
  private commanderTrimMat = new THREE.MeshLambertMaterial({ color: 0xc8d0da });
  private commanderLensMat = new THREE.MeshBasicMaterial({
    color: 0x73e9ff,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
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
  /** Reverse lookup so low-tier compaction can move tail slots into holes in O(1). */
  private unitInstancedEntityBySlot: (EntityId | undefined)[] = [];
  /** Maps entityId → last owner/lod color key written into its instance slot. */
  private unitInstancedColorKey = new Map<EntityId, string>();
  // In hybrid mode this is the set of units whose mass-body slot should
  // be hidden because a richer object mesh is responsible for drawing
  // the body. The outer marker tier still uses this packed sphere path.
  private massRichUnitIds = new Set<EntityId>();
  private massRichUnits: Entity[] = [];
  private ownedObjectLodGrid = new RenderLodGrid();
  private objectLodGrid = this.ownedObjectLodGrid;
  /** Reuse pool of vacated slots so a long game doesn't burn through cap. */
  private unitInstancedFreeSlots: number[] = [];
  /** High-water mark; everything ≥ this is unused. */
  private unitInstancedNextSlot = 0;
  private unitInstancedCompactFrame = 0;
  private unitInstancedFrame = 0;
  private unitInstancedHiddenIds = new Set<EntityId>();
  /** Hidden-slot transform: scale=0 collapses the geometry to a point. */
  private static readonly _ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
  /** Reusable scratch matrix to avoid allocations in the per-instance write hot loop. */
  private _instMatrix = new THREE.Matrix4();
  /** Reusable scratch quaternion + vector. */
  private _instQuat = new THREE.Quaternion();
  private _instPos = new THREE.Vector3();
  private _instScale = new THREE.Vector3();
  private _instColor = new THREE.Color();

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

  private markInstanceColorRange(
    mesh: THREE.InstancedMesh,
    minSlot: number,
    maxSlot: number,
  ): void {
    if (!mesh.instanceColor || maxSlot < minSlot) return;
    const attr = mesh.instanceColor;
    attr.clearUpdateRanges();
    attr.addUpdateRange(minSlot * 3, (maxSlot - minSlot + 1) * 3);
    attr.needsUpdate = true;
  }

  // ── LOW+ tier smooth-body chassis InstancedMesh ─────────────────
  // At MED+ LOD every smooth-body unit (arachnid, beam, snipe / tick,
  // commander, forceField, loris) used to stamp one Mesh per body
  // segment — composite arachnids/commanders ate 2 draw calls each
  // before any turret/leg work. This InstancedMesh collapses every
  // smooth body part across every smooth-body unit on the map into
  // ONE shared draw call.
  //
  // Per-instance attributes:
  //   - instanceMatrix encodes the part's full world transform:
  //       T(group_pos) · R(tilt · Ry(yaw)) · S(radius) · T(part.local) · S(part.scale)
  //     — exactly what the per-Mesh scenegraph chain
  //     (group → yawGroup → chassis → mesh) produced.
  //   - instanceColor carries the team primary, modulated against the
  //     shared material's white base color (same trick MIN-tier uses).
  //
  // Polygon / rect bodies (scout, brawl, tank, burst, mortar, hippo)
  // need ExtrudeGeometry per renderer and so still go through the
  // per-Mesh chassis path; bodyEntry.isSmooth flags the routing.
  //
  // The yawGroup hierarchy is still built for smooth-body units —
  // turrets, legs, and mirror panels still parent to it. Only the
  // chassis Mesh children are skipped; the chassis Group stays empty.
  private static readonly SMOOTH_CHASSIS_CAP = 16384;
  private smoothChassisGeom = new THREE.SphereGeometry(1, 24, 16);
  private smoothChassis: THREE.InstancedMesh | null = null;
  /** Maps entityId → list of slot indices, one per body part. Composite
   *  bodies (arachnid, commander, beam) get a slot per segment; single-
   *  part smooth bodies (snipe, loris, forceField) get exactly one. */
  private smoothChassisSlots = new Map<EntityId, number[]>();
  /** Maps entityId → last owner color key written into its smooth slots. */
  private smoothChassisColorKey = new Map<EntityId, number>();
  /** Reuse pool of vacated slots so a long game doesn't burn through cap. */
  private smoothChassisFreeSlots: number[] = [];
  /** High-water mark; everything ≥ this is unused. */
  private smoothChassisNextSlot = 0;
  /** Per-frame scratch: combined parent (group + yaw + radius-scale) matrix
   *  cached once per smooth-body unit, then multiplied with each part's
   *  local matrix to produce the per-slot world matrix. */
  private _smoothParentMat = new THREE.Matrix4();
  private _smoothPartMat = new THREE.Matrix4();
  private _smoothFinalMat = new THREE.Matrix4();
  /** Per-frame scratch: combined `tilt · Ry(yaw)` quaternion + scratch
   *  yaw-only quaternion + uniform-radius scale vector + part local
   *  position + part per-axis scale + identity quaternion. Module-local
   *  axis (`_INST_UP`) drives the yaw quaternion. */
  private _smoothParentQuat = new THREE.Quaternion();
  private _smoothYawQuat = new THREE.Quaternion();
  private _smoothParentScale = new THREE.Vector3();
  private _smoothPartLocalPos = new THREE.Vector3();
  private _smoothPartScale = new THREE.Vector3();
  /** Lift offset (0, chassisLift, 0) rotated by parentQuat, added to
   *  groupPos so parentMat reproduces the scenegraph chain
   *    group → yawGroup → liftGroup → chassis
   *  (which inserts T(0, lift, 0) after Ry(yaw) and before S(radius)).
   *  Without this, smooth-chassis + poly-chassis instances render at
   *  the OLD ground height while per-Mesh chassis (correctly parented
   *  through liftGroup) render lifted — visible mismatch on every
   *  chassis-instanced unit at LOW+ tier. */
  private _smoothLiftOffset = new THREE.Vector3();
  private _smoothLiftedPos = new THREE.Vector3();
  private static readonly _IDENTITY_QUAT = new THREE.Quaternion();

  /** Scratch state for the per-barrel instance write. The chain
   *  group → yawGroup → liftGroup → turretRoot → pitchGroup →
   *  spinGroup is composed progressively into `_barrelParentMat`
   *  per turret, then each barrel's `T·R·S` local matrix is
   *  multiplied in to produce the final world matrix. `_barrelOneVec`
   *  / `_barrelZeroVec` / `_barrelLiftVec` are immutable / overwritten-
   *  each-step scratch Vector3s so the inner loop allocates nothing. */
  private _barrelParentMat = new THREE.Matrix4();
  private _barrelStepMat = new THREE.Matrix4();
  private _barrelOneVec = new THREE.Vector3(1, 1, 1);
  private _barrelZeroVec = new THREE.Vector3(0, 0, 0);

  /** Per-unit cached prefix matrix `T(liftedPos) · R(parentQuat) · S(1)`
   *  — i.e. the scenegraph chain `group · yawGroup · liftGroup` evaluated
   *  once at the top of the per-unit body. Reused as the BARREL parent-
   *  chain seed so the per-turret loop's first three composes /
   *  multiplies (which used to rebuild this chain from m.group every
   *  turret) collapse to a single `Matrix4.copy()`. */
  private _unitChainMat = new THREE.Matrix4();

  // ── LOW+ tier polygonal/rect chassis InstancedMeshes ──────────────
  // One InstancedMesh per polygonal renderer (scout / brawl / tank /
  // burst / mortar — all ExtrudeGeometry from BodyShape3D's per-
  // renderer cache) plus one for the rect renderer (hippo). Lazily
  // created the first time a unit of that renderer enters the scene,
  // because the geometry isn't built until BodyShape3D's
  // `getBodyGeom(renderer)` is called. Each pool's mesh references the
  // SAME geometry object that BodyShape3D's CACHE owns — disposed by
  // BodyShape3D's `disposeBodyGeoms()` in destroy(), not by us, so we
  // tear down `polyChassis` pool meshes BEFORE that call.
  //
  // Polygonal bodies always have parts.length === 1 (single
  // ExtrudeGeometry per renderer), so each unit takes exactly one slot
  // in its renderer's pool. Composite-or-multi-part polygonal bodies
  // would need a slot list like smoothChassisSlots — for now the
  // BodyShape3D shapes guarantee single-part.
  private static readonly POLY_CHASSIS_CAP = 4096;
  private polyChassis = new Map<string, {
    mesh: THREE.InstancedMesh;
    slots: Map<EntityId, number>;
    colorKeys: Map<EntityId, number>;
    colorDirty: boolean;
    freeSlots: number[];
    nextSlot: number;
  }>();

  // ── LOW+ tier turret-head InstancedMesh ──────────────────────────
  // Every visible turret head across every unit on the map renders
  // through ONE shared InstancedMesh — same draw-call collapse the
  // chassis pools achieved, applied to the next-largest per-unit
  // visual after chassis (heads can be 1-7 per unit; widow has 6
  // beam turrets + 1 force-field, so up to 6 heads / unit at the
  // upper end).
  //
  // Heads are simple unit spheres: per-instance world position
  // (unit + tilt + yaw + lift + turret offset + headRadius lift),
  // uniform scale = headRadius, team color via instanceColor.
  // Position is NOT affected by turret yaw/pitch — the head sits
  // on the +Y axis of the turret root, which is the rotation axis
  // for both yaw and pitch, so the head's chassis-local position
  // is rotation-invariant.
  //
  // Slots are stable-allocated per turret (turretMesh.headSlot)
  // and rewritten every frame; slots persist across frames so
  // count tracks nextSlot like the chassis pools.
  //
  // Hidden heads (turretStyle=none / force-field / mirror-host)
  // don't get a slot — they have no visible head at all. Heads
  // that would be visible but hit the cap fall back to per-Mesh
  // (TurretMesh.head) — same fallback the chassis pools use.
  private static readonly TURRET_HEAD_CAP = 16384;
  private turretHeadInstanced: THREE.InstancedMesh | null = null;
  private turretHeadColorKey = new Map<number, number>();
  private turretHeadColorDirty = false;
  private turretHeadFreeSlots: number[] = [];
  private turretHeadNextSlot = 0;

  // ── LOW+ tier barrel InstancedMesh ──────────────────────────────
  // Every barrel cylinder across every turret across every unit
  // renders through ONE shared InstancedMesh draw call. Continuation
  // of the chassis + head instancing — barrels are the largest
  // remaining per-unit visual after those (unit can have 1-7
  // turrets × 1-7 barrels each; widow with multi-barrel beam emitters
  // can push 14+ barrels alone).
  //
  // Each barrel carries a static base transform (position +
  // quaternion + scale, set by TurretMesh3D's pushSegment) within
  // its turret's spinGroup-local frame. Per frame we compose
  // `parentMat = group · yawGroup · liftGroup · turretRoot ·
  // pitchGroup · spinGroup` once per turret and `worldMat = parentMat
  // · barrelLocalMat` per barrel. Per-instance team color isn't
  // needed (barrels are always white in the current visual contract,
  // matching this.barrelMat); we still expose instanceColor in case
  // future per-team / per-state tints are added — unused slots stay
  // at the default white init.
  //
  // Slot allocation is stable per turret-barrel, freed on unit
  // despawn. count = nextSlot per frame matches the chassis-pool
  // tightening from commit a165b65.
  private static readonly BARREL_CAP = 32768;
  private barrelInstanced: THREE.InstancedMesh | null = null;
  private barrelFreeSlots: number[] = [];
  private barrelNextSlot = 0;

  // ── LOW+ tier mirror-panel InstancedMesh ────────────────────────
  // Loris-only feature, but each Loris carries 4 panels and chrome-
  // PBR each — so a 100-Loris scene is 400 separate MeshStandardMaterial
  // draws today. Routing them through ONE shared InstancedMesh with
  // per-instance team color (instanceColor modulates against the
  // shared material.color = white) collapses that to 1 draw call.
  // metalness=1 + roughness=0 are material-level uniforms so they
  // stay shared across teams; only the BASE color tints per team.
  // The PMREM environment map for chrome reflection is set on the
  // scene, not the material, so it applies to all instances.
  private static readonly MIRROR_PANEL_CAP = 1024;
  private mirrorPanelInstanced: THREE.InstancedMesh | null = null;
  private mirrorPanelColorKey = new Map<number, number>();
  private mirrorPanelColorDirty = false;
  private mirrorPanelFreeSlots: number[] = [];
  private mirrorPanelNextSlot = 0;

  constructor(
    world: THREE.Group,
    clientViewState: ClientViewState,
    scope: ViewportFootprint,
    legRenderer: LegInstancedRenderer,
    camera: THREE.PerspectiveCamera,
    getViewportHeight: () => number,
  ) {
    this.world = world;
    this.clientViewState = clientViewState;
    this.scope = scope;
    this.legRenderer = legRenderer;
    this.camera = camera;
    this.getViewportHeight = getViewportHeight;
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
    // Start with count = 0 so an empty pool doesn't spin the GPU
    // through 16k empty vertex-shader invocations every frame. The
    // per-frame writer bumps count up to nextSlot (the high-water
    // mark of allocated slot indices) at the end of each update —
    // see updateUnitsInstanced. CAP is the buffer SIZE; count is the
    // DRAW BOUND.
    this.unitInstanced.count = 0;
    this.unitInstanced.instanceMatrix.needsUpdate = true;
    this.world.add(this.unitInstanced);

    // Smooth-body chassis InstancedMesh — one shared draw call covers
    // every smooth body part across every smooth-body unit on the map
    // at LOW+ tier. Material is white because per-instance colour comes
    // from setColorAt (same trick the MIN-tier instanced mesh uses).
    // 24×16 tessellation matches the per-Mesh smooth-body sphere from
    // BodyShape3D so the visual is byte-for-byte identical when the LOD
    // routing flips a unit between paths.
    const smoothMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.smoothChassis = new THREE.InstancedMesh(
      this.smoothChassisGeom,
      smoothMat,
      Render3DEntities.SMOOTH_CHASSIS_CAP,
    );
    this.smoothChassis.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Allocate the instanceColor buffer up front so setColorAt works
    // without a first-frame initialization branch.
    this.smoothChassis.setColorAt(0, this._instColor.set(0xffffff));
    this.smoothChassis.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    // Same culling caveat as unitInstanced: source geom's bounding
    // sphere is at origin radius 1; instances live anywhere on the map,
    // so disable frustum cull. Hidden slots use a scale-0 matrix and
    // contribute zero rasterized pixels.
    this.smoothChassis.frustumCulled = false;
    for (let i = 0; i < Render3DEntities.SMOOTH_CHASSIS_CAP; i++) {
      this.smoothChassis.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
    }
    // Same draw-bound logic as unitInstanced — start at 0, bump to
    // smoothChassisNextSlot per frame in updateUnits.
    this.smoothChassis.count = 0;
    this.smoothChassis.instanceMatrix.needsUpdate = true;
    this.world.add(this.smoothChassis);

    // Turret-head InstancedMesh — reuses the existing turretHeadGeom
    // (16×12 unit sphere). Per-instance team color via instanceColor
    // modulates against the white shared MeshLambertMaterial — same
    // pattern smoothChassis uses, so team-changes are picked up by
    // the per-frame setColorAt without touching any material.
    const headMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.turretHeadInstanced = new THREE.InstancedMesh(
      this.turretHeadGeom,
      headMat,
      Render3DEntities.TURRET_HEAD_CAP,
    );
    this.turretHeadInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.turretHeadInstanced.setColorAt(0, this._instColor.set(0xffffff));
    this.turretHeadInstanced.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    // Same culling caveat as the chassis pools — instances are
    // anywhere on the map, source-geom bounding sphere is at origin.
    this.turretHeadInstanced.frustumCulled = false;
    for (let i = 0; i < Render3DEntities.TURRET_HEAD_CAP; i++) {
      this.turretHeadInstanced.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
    }
    this.turretHeadInstanced.count = 0;
    this.turretHeadInstanced.instanceMatrix.needsUpdate = true;
    this.world.add(this.turretHeadInstanced);

    // Barrel InstancedMesh — reuses the existing barrelGeom
    // (10-segment cylinder, radius 1, height 1; the per-instance
    // scale shapes it to (cylRadius, length, cylRadius)). Material
    // is the same shared white barrelMat the per-Mesh path used —
    // not a new MeshLambertMaterial — so team-color updates AREN'T
    // applied (barrels stay white across teams, matching the
    // existing visual contract). We still allocate instanceColor so
    // a future per-instance tint hook can land without recreating
    // the mesh.
    this.barrelInstanced = new THREE.InstancedMesh(
      this.barrelGeom,
      this.barrelMat,
      Render3DEntities.BARREL_CAP,
    );
    this.barrelInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.barrelInstanced.setColorAt(0, this._instColor.set(0xffffff));
    this.barrelInstanced.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.barrelInstanced.frustumCulled = false;
    for (let i = 0; i < Render3DEntities.BARREL_CAP; i++) {
      this.barrelInstanced.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
    }
    this.barrelInstanced.count = 0;
    this.barrelInstanced.instanceMatrix.needsUpdate = true;
    this.world.add(this.barrelInstanced);

    // Mirror-panel InstancedMesh — one shared chrome-shiny material
    // (metalness=1, roughness=0, double-sided so the panel reads
    // from either side; PMREM environment is set on the scene), per-
    // instance team color via instanceColor.
    const mirrorMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 1.0,
      roughness: 0.0,
      side: THREE.DoubleSide,
    });
    this.mirrorPanelInstanced = new THREE.InstancedMesh(
      this.mirrorGeom,
      mirrorMat,
      Render3DEntities.MIRROR_PANEL_CAP,
    );
    this.mirrorPanelInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mirrorPanelInstanced.setColorAt(0, this._instColor.set(0xffffff));
    this.mirrorPanelInstanced.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mirrorPanelInstanced.frustumCulled = false;
    for (let i = 0; i < Render3DEntities.MIRROR_PANEL_CAP; i++) {
      this.mirrorPanelInstanced.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
    }
    this.mirrorPanelInstanced.count = 0;
    this.mirrorPanelInstanced.instanceMatrix.needsUpdate = true;
    this.world.add(this.mirrorPanelInstanced);

    this.projectileSphereInstanced = new THREE.InstancedMesh(
      this.projectileGeom,
      this.projectileMat,
      Render3DEntities.PROJECTILE_INSTANCED_CAP,
    );
    this.projectileSphereInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projectileSphereInstanced.frustumCulled = false;
    this.projectileSphereInstanced.count = 0;
    this.world.add(this.projectileSphereInstanced);

    this.projectileCylinderInstanced = new THREE.InstancedMesh(
      this.projectileCylinderGeom,
      this.projectileMat,
      Render3DEntities.PROJECTILE_INSTANCED_CAP,
    );
    this.projectileCylinderInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projectileCylinderInstanced.frustumCulled = false;
    this.projectileCylinderInstanced.count = 0;
    this.world.add(this.projectileCylinderInstanced);
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

  private buildCommanderVisualKit(tier: ConcreteGraphicsQuality): THREE.Group {
    const kit = new THREE.Group();
    const hazardMat = getConstructionHazardMaterial();
    const addBox = (
      material: THREE.Material,
      x: number, y: number, z: number,
      sx: number, sy: number, sz: number,
    ): void => {
      const mesh = new THREE.Mesh(this.commanderBoxGeom, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      kit.add(mesh);
    };
    const addCylinder = (
      material: THREE.Material,
      x: number, y: number, z: number,
      radiusX: number, height: number, radiusZ: number,
    ): void => {
      const mesh = new THREE.Mesh(this.commanderCylinderGeom, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(radiusX, height, radiusZ);
      kit.add(mesh);
    };

    addBox(this.commanderArmorMat, -0.08, 1.12, 0, 1.04, 0.14, 0.76);
    if (buildingTierAtLeast(tier, 'low')) {
      addBox(this.commanderTrimMat, 0.44, 1.22, 0, 0.28, 0.12, 0.58);
      addBox(this.commanderLensMat, 0.64, 1.27, 0, 0.08, 0.11, 0.46);
    }
    if (buildingTierAtLeast(tier, 'medium')) {
      addCylinder(hazardMat, -0.42, 1.34, 0, 0.34, 0.1, 0.34);
      addCylinder(this.commanderArmorMat, 0.34, 1.29, -0.42, 0.24, 0.16, 0.24);
      addCylinder(this.commanderArmorMat, 0.34, 1.29, 0.42, 0.24, 0.16, 0.24);
    }
    if (buildingTierAtLeast(tier, 'high')) {
      addBox(this.commanderTrimMat, 0.36, 1.42, -0.42, 0.4, 0.055, 0.17);
      addBox(this.commanderTrimMat, 0.36, 1.42, 0.42, 0.4, 0.055, 0.17);

      const sensor = new THREE.Mesh(this.commanderDomeGeom, this.commanderLensMat);
      sensor.position.set(0.18, 1.36, 0);
      sensor.scale.set(0.12, 0.12, 0.12);
      kit.add(sensor);
    }
    if (buildingTierAtLeast(tier, 'max')) {
      addBox(this.commanderArmorMat, -0.28, 1.24, -0.38, 0.36, 0.07, 0.08);
      addBox(this.commanderArmorMat, -0.28, 1.24, 0.38, 0.36, 0.07, 0.08);
      addBox(this.commanderTrimMat, -0.38, 1.31, 0, 0.09, 0.22, 0.12);
      addBox(this.commanderLensMat, -0.39, 1.43, 0, 0.06, 0.07, 0.08);
    }
    return kit;
  }

  private decorateCommanderTurret(
    tm: TurretMesh,
    turretId: string,
    tier: ConcreteGraphicsQuality,
  ): void {
    const headRadius = tm.headRadius ?? 6;
    const collar = new THREE.Mesh(this.commanderCylinderGeom, this.commanderArmorMat);
    collar.position.set(0, Math.max(1.2, headRadius * 0.16), 0);
    collar.scale.set(
      headRadius * 1.18,
      Math.max(1.6, headRadius * 0.15),
      headRadius * 1.18,
    );
    tm.root.add(collar);

    if (!buildingTierAtLeast(tier, 'medium')) return;

    const brow = new THREE.Mesh(this.commanderBoxGeom, this.commanderArmorMat);
    brow.position.set(headRadius * 0.55, headRadius * 1.24, 0);
    brow.scale.set(headRadius * 0.46, headRadius * 0.16, headRadius * 0.86);
    tm.root.add(brow);

    const optic = new THREE.Mesh(this.commanderBoxGeom, this.commanderLensMat);
    optic.position.set(headRadius * 1.02, headRadius * 1.25, 0);
    optic.scale.set(headRadius * 0.08, headRadius * 0.12, headRadius * 0.42);
    tm.root.add(optic);

    if (tm.pitchGroup && buildingTierAtLeast(tier, 'high')) {
      const isDgun = turretId === 'dgunTurret';
      const sleeve = new THREE.Mesh(this.commanderBoxGeom, isDgun ? this.commanderArmorMat : this.commanderTrimMat);
      sleeve.position.set(headRadius * (isDgun ? 0.72 : 0.55), 0, 0);
      sleeve.scale.set(
        headRadius * (isDgun ? 1.05 : 0.72),
        headRadius * (isDgun ? 0.34 : 0.22),
        headRadius * (isDgun ? 0.34 : 0.22),
      );
      tm.pitchGroup.add(sleeve);
    }
    if (buildingTierAtLeast(tier, 'max')) {
      const crest = new THREE.Mesh(this.commanderBoxGeom, this.commanderTrimMat);
      crest.position.set(-headRadius * 0.08, headRadius * 1.34, 0);
      crest.scale.set(headRadius * 0.1, headRadius * 0.18, headRadius * 0.18);
      tm.root.add(crest);
    }
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

  update(lodOverride?: Lod3DState, sharedLodGrid?: RenderLodGrid): void {
    // Refresh LOD snapshot once per frame. If the global LOD changed since
    // the last frame, tear down all unit meshes so updateUnits() rebuilds
    // them at the new level — the simplest way to keep every sub-mesh
    // (body, turrets, legs, locomotion, mirrors) consistent with the
    // current GraphicsConfig.
    const newLod = lodOverride ?? snapshotLod(this.camera, this.getViewportHeight());
    if (newLod.key !== this.lod.key) {
      this.rebuildAllUnitsOnLodChange();
    }
    this.lod = newLod;
    this.objectLodGrid = sharedLodGrid ?? this.ownedObjectLodGrid;
    if (!sharedLodGrid) this.objectLodGrid.beginFrame(this.lod.view, this.lod.gfx);

    // Time step for continuous-rotation effects (barrel spin, wheel roll).
    // Clamp in case the tab was backgrounded.
    const now = performance.now();
    const spinDt = Math.min((now - this._lastSpinMs) / 1000, 0.1);
    this._lastSpinMs = now;
    this._currentDtMs = spinDt * 1000;

    // Barrel-spin advancement is fused into updateUnits' per-entity
    // loop so the unit list is iterated once instead of twice. Cache
    // the dt on the instance so the per-unit body can read it.
    this._spinDt = spinDt;
    this.updateUnits();
    this.updateBuildings();
    this.updateProjectiles();
    // One flush per frame uploads the per-instance leg cylinder
    // buffers (start / end / thickness) to the GPU. Every leg in
    // every unit wrote into the same shared pool above; the GPU
    // now draws all leg cylinders in two draw calls (upper, lower).
    this.legRenderer.flush();
  }

  private _spinDt = 0;

  private _currentDtMs = 0;

  private trimFreeTail(freeSlots: number[], nextSlot: number): number {
    // Stable slot allocation can leave freed slots below the high-water
    // mark. When the freed slots are at the tail, lower nextSlot so the
    // InstancedMesh draw count stops paying vertex cost for them.
    while (nextSlot > 0) {
      const tail = nextSlot - 1;
      const i = freeSlots.indexOf(tail);
      if (i < 0) break;
      freeSlots.splice(i, 1);
      nextSlot = tail;
    }
    return nextSlot;
  }

  private compactUnitInstancedSlots(
    im: THREE.InstancedMesh,
  ): {
    matrixMinSlot: number;
    matrixMaxSlot: number;
    colorMinSlot: number;
    colorMaxSlot: number;
    colorDirty: boolean;
  } {
    const result = {
      matrixMinSlot: Number.POSITIVE_INFINITY,
      matrixMaxSlot: -1,
      colorMinSlot: Number.POSITIVE_INFINITY,
      colorMaxSlot: -1,
      colorDirty: false,
    };

    if (this.unitInstancedFreeSlots.length < LOW_INSTANCED_COMPACT_MIN_FREE) return result;
    if ((this.unitInstancedCompactFrame++ % LOW_INSTANCED_COMPACT_INTERVAL_FRAMES) !== 0) return result;

    this.unitInstancedFreeSlots.sort((a, b) => a - b);
    let moves = 0;
    let nextSlot = this.unitInstancedNextSlot;

    for (let freeIndex = 0; freeIndex < this.unitInstancedFreeSlots.length && moves < LOW_INSTANCED_COMPACT_MAX_MOVES;) {
      nextSlot = this.trimFreeTail(this.unitInstancedFreeSlots, nextSlot);
      const freeSlot = this.unitInstancedFreeSlots[freeIndex];
      if (freeSlot >= nextSlot) {
        this.unitInstancedFreeSlots.splice(freeIndex, 1);
        continue;
      }

      let tailSlot = nextSlot - 1;
      while (tailSlot > freeSlot && this.unitInstancedEntityBySlot[tailSlot] === undefined) {
        const tailFreeIdx = this.unitInstancedFreeSlots.indexOf(tailSlot);
        if (tailFreeIdx >= 0) this.unitInstancedFreeSlots.splice(tailFreeIdx, 1);
        nextSlot = tailSlot;
        tailSlot = nextSlot - 1;
      }
      if (tailSlot <= freeSlot) break;

      const tailEntityId = this.unitInstancedEntityBySlot[tailSlot];
      if (tailEntityId === undefined) break;

      im.getMatrixAt(tailSlot, this._instMatrix);
      im.setMatrixAt(freeSlot, this._instMatrix);
      im.setMatrixAt(tailSlot, Render3DEntities._ZERO_MATRIX);
      if (im.instanceColor) {
        im.getColorAt(tailSlot, this._instColor);
        im.setColorAt(freeSlot, this._instColor);
        result.colorDirty = true;
        result.colorMinSlot = Math.min(result.colorMinSlot, freeSlot, tailSlot);
        result.colorMaxSlot = Math.max(result.colorMaxSlot, freeSlot, tailSlot);
      }

      this.unitInstancedSlot.set(tailEntityId, freeSlot);
      this.unitInstancedEntityBySlot[freeSlot] = tailEntityId;
      this.unitInstancedEntityBySlot[tailSlot] = undefined;

      this.unitInstancedFreeSlots.splice(freeIndex, 1);
      this.unitInstancedFreeSlots.push(tailSlot);
      result.matrixMinSlot = Math.min(result.matrixMinSlot, freeSlot, tailSlot);
      result.matrixMaxSlot = Math.max(result.matrixMaxSlot, freeSlot, tailSlot);
      moves++;
    }

    this.unitInstancedNextSlot = this.trimFreeTail(this.unitInstancedFreeSlots, nextSlot);
    return result;
  }

  /** Wipe every cached unit mesh so the next updateUnits() rebuilds them at
   *  the current LOD. Explosions / projectiles / tile grid don't need a rebuild
   *  — their per-frame loops already read the LOD snapshot directly. */
  private rebuildAllUnitsOnLodChange(): void {
    for (const m of this.unitMeshes.values()) {
      destroyLocomotion(m.locomotion, this.legRenderer);
      this.world.remove(m.group);
      this.disposeWorldParentedOverlays(m);
    }
    this.unitMeshes.clear();
    this.barrelSpins.clear();
    // Smooth-chassis slot indices are tied to specific entityIds + the
    // current LOD's geometry path; on a tier flip we re-discover which
    // units route through smoothChassis and re-allocate fresh.
    this.releaseAllSmoothChassisSlots();
    this.releaseAllPolyChassisSlots();
    this.releaseAllTurretHeadSlots();
    this.releaseAllBarrelSlots();
    this.releaseAllMirrorPanelSlots();
  }

  private hideUnitInstancedSlot(
    im: THREE.InstancedMesh,
    entityId: EntityId,
    slot: number | undefined,
    dirty: { matrixMinSlot: number; matrixMaxSlot: number },
  ): void {
    if (slot === undefined || this.unitInstancedHiddenIds.has(entityId)) return;
    im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
    this.unitInstancedHiddenIds.add(entityId);
    if (slot < dirty.matrixMinSlot) dirty.matrixMinSlot = slot;
    if (slot > dirty.matrixMaxSlot) dirty.matrixMaxSlot = slot;
  }

  private shouldUpdateUnitInstancedMatrix(
    entity: Entity,
    tier: RenderObjectLodTier,
    slotWasNew: boolean,
    wasHidden: boolean,
  ): boolean {
    if (slotWasNew || wasHidden) return true;
    if (entity.selectable?.selected === true) return true;
    const stride = MASS_INSTANCE_MATRIX_STRIDE[tier] ?? 1;
    if (stride <= 1) return true;
    return (this.unitInstancedFrame + entity.id) % stride === 0;
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
  private updateUnitsInstanced(
    units = this.clientViewState.getUnits(),
    collectRichUnits = false,
  ): readonly Entity[] {
    const im = this.unitInstanced;
    if (!im) return this.massRichUnits;

    this.unitInstancedFrame = (this.unitInstancedFrame + 1) & 0x3fffffff;
    const seen = this._seenUnitIds;
    seen.clear();
    const richIds = this.massRichUnitIds;
    const richUnits = this.massRichUnits;
    if (collectRichUnits) {
      richIds.clear();
      richUnits.length = 0;
    }
    let colorDirty = false;
    let matrixMinSlot = Number.POSITIVE_INFINITY;
    let matrixMaxSlot = -1;
    let colorMinSlot = Number.POSITIVE_INFINITY;
    let colorMaxSlot = -1;
    const matrixDirty = { matrixMinSlot, matrixMaxSlot };

    for (const e of units) {
      seen.add(e.id);
      const objectTier = this.resolveEntityObjectLod(e);
      const inScope = this.scope.inScope(e.transform.x, e.transform.y, 100);
      if (collectRichUnits) {
        // Rich scenegraph units stay render-scope gated because they
        // drive terrain tilt, locomotion, turret/mirror matrices, and
        // selection overlays. Units outside that older 2D footprint
        // still flow through the cheap instanced body below, so the
        // 3D LOD grid never resolves to "invisible" for unit bodies.
        if (inScope && (isRichObjectLod(objectTier) || objectTier === 'simple' || objectTier === 'impostor')) {
          richIds.add(e.id);
          richUnits.push(e);
          this.hideUnitInstancedSlot(im, e.id, this.unitInstancedSlot.get(e.id), matrixDirty);
          continue;
        }
      }

      let slot = this.unitInstancedSlot.get(e.id);
      let slotWasNew = false;
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
        this.unitInstancedEntityBySlot[slot] = e.id;
        slotWasNew = true;
      }
      const wasHidden = this.unitInstancedHiddenIds.delete(e.id);

      const radius = e.unit?.unitRadiusCollider.scale
        ?? e.unit?.unitRadiusCollider.shot
        ?? 15;
      const pushR = e.unit?.unitRadiusCollider.push ?? 0;

      if (this.shouldUpdateUnitInstancedMatrix(e, objectTier, slotWasNew, wasHidden)) {
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
        if (slot < matrixDirty.matrixMinSlot) matrixDirty.matrixMinSlot = slot;
        if (slot > matrixDirty.matrixMaxSlot) matrixDirty.matrixMaxSlot = slot;
      }

      const pid = e.ownership?.playerId;
      const colorKey = `${pid ?? -1}`;
      if (this.unitInstancedColorKey.get(e.id) !== colorKey) {
        this._instColor
          .set(pid !== undefined ? getPlayerColors(pid).primary : 0x888888);
        im.setColorAt(slot, this._instColor);
        this.unitInstancedColorKey.set(e.id, colorKey);
        colorDirty = true;
        if (slot < colorMinSlot) colorMinSlot = slot;
        if (slot > colorMaxSlot) colorMaxSlot = slot;
      }
    }

    // Free slots for units that disappeared this frame.
    for (const [id, slot] of this.unitInstancedSlot) {
      if (!seen.has(id)) {
        im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
        if (slot < matrixDirty.matrixMinSlot) matrixDirty.matrixMinSlot = slot;
        if (slot > matrixDirty.matrixMaxSlot) matrixDirty.matrixMaxSlot = slot;
        this.unitInstancedFreeSlots.push(slot);
        this.unitInstancedEntityBySlot[slot] = undefined;
        this.unitInstancedSlot.delete(id);
        this.unitInstancedColorKey.delete(id);
        this.unitInstancedHiddenIds.delete(id);
      }
    }
    matrixMinSlot = matrixDirty.matrixMinSlot;
    matrixMaxSlot = matrixDirty.matrixMaxSlot;
    this.unitInstancedNextSlot = this.trimFreeTail(
      this.unitInstancedFreeSlots,
      this.unitInstancedNextSlot,
    );
    const compacted = this.compactUnitInstancedSlots(im);
    if (compacted.matrixMaxSlot >= compacted.matrixMinSlot) {
      matrixMinSlot = Math.min(matrixMinSlot, compacted.matrixMinSlot);
      matrixMaxSlot = Math.max(matrixMaxSlot, compacted.matrixMaxSlot);
    }
    if (compacted.colorDirty) {
      colorDirty = true;
      colorMinSlot = Math.min(colorMinSlot, compacted.colorMinSlot);
      colorMaxSlot = Math.max(colorMaxSlot, compacted.colorMaxSlot);
    }

    // Tighten draw bound to the high-water mark so the GPU doesn't
    // run the vertex shader on the (CAP - nextSlot) trailing slots
    // that have never been allocated. Freed slots within [0,
    // nextSlot) still incur VS cost (their matrix is scale-0 so no
    // fragments) but stable-slot allocation keeps churn-induced
    // waste bounded — peak active count is the steady-state ceiling.
    im.count = this.unitInstancedNextSlot;
    this.markInstanceMatrixRange(im, matrixMinSlot, matrixMaxSlot);
    if (colorDirty) this.markInstanceColorRange(im, colorMinSlot, colorMaxSlot);
    return richUnits;
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
    this.unitInstancedEntityBySlot.length = 0;
    this.unitInstancedColorKey.clear();
    this.unitInstancedHiddenIds.clear();
    this.massRichUnitIds.clear();
    this.massRichUnits.length = 0;
    this.unitInstancedFreeSlots.length = 0;
    this.unitInstancedNextSlot = 0;
    this.unitInstancedCompactFrame = 0;
    this.unitInstancedFrame = 0;
    im.count = 0;
    im.instanceMatrix.needsUpdate = true;
  }

  /** Reserve N consecutive logical slots in `smoothChassis` for one
   *  unit. Returns the allocated slot indices, or null if the cap is
   *  exhausted (caller falls back to per-Mesh chassis). Slots are
   *  drawn from the free list LIFO so a long game doesn't burn
   *  through the high-water mark. */
  private allocSmoothChassisSlots(count: number): number[] | null {
    if (count <= 0) return [];
    const out: number[] = [];
    for (let k = 0; k < count; k++) {
      let slot: number;
      if (this.smoothChassisFreeSlots.length > 0) {
        slot = this.smoothChassisFreeSlots.pop()!;
      } else if (this.smoothChassisNextSlot < Render3DEntities.SMOOTH_CHASSIS_CAP) {
        slot = this.smoothChassisNextSlot++;
      } else {
        // Cap exhausted — return what we got so far so the caller can
        // free them; the unit will fall back to whatever path the
        // caller chooses (currently: drop the chassis render).
        for (const s of out) this.smoothChassisFreeSlots.push(s);
        return null;
      }
      out.push(slot);
    }
    return out;
  }

  /** Hide every smooth-chassis slot the entity owns, free them back to
   *  the pool, and forget the entity. Called from the per-frame
   *  seen-pruning loop (unit despawned) and from the LOD-flip rebuild
   *  path. The InstancedMesh's instanceMatrix dirty flag is set by the
   *  per-frame writer; a freed-but-unwritten slot at scale 0 contributes
   *  zero pixels until the next write reuses it. */
  private freeSmoothChassisSlotsForEntity(eid: EntityId): void {
    const im = this.smoothChassis;
    if (!im) return;
    const slots = this.smoothChassisSlots.get(eid);
    if (!slots) return;
    for (const slot of slots) {
      im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
      this.smoothChassisFreeSlots.push(slot);
    }
    this.smoothChassisSlots.delete(eid);
    this.smoothChassisColorKey.delete(eid);
    im.instanceMatrix.needsUpdate = true;
  }

  /** Wipe every active smooth-chassis slot (LOD flip / teardown). Same
   *  shape as releaseAllInstancedSlots above. */
  private releaseAllSmoothChassisSlots(): void {
    const im = this.smoothChassis;
    if (!im) return;
    for (const slots of this.smoothChassisSlots.values()) {
      for (const slot of slots) im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
    }
    this.smoothChassisSlots.clear();
    this.smoothChassisColorKey.clear();
    this.smoothChassisFreeSlots.length = 0;
    this.smoothChassisNextSlot = 0;
    im.count = 0;
    im.instanceMatrix.needsUpdate = true;
  }

  /** Look up or lazily create the InstancedMesh pool for a polygonal /
   *  rect renderer. The geometry is BodyShape3D's per-renderer
   *  ExtrudeGeometry — already cached and shared, so we just take a
   *  reference. Material is a private MeshLambertMaterial owned by the
   *  pool; per-instance team color modulates against its white base. */
  private getOrCreatePolyPool(
    rendererId: string,
    geom: THREE.BufferGeometry,
  ): {
    mesh: THREE.InstancedMesh;
    slots: Map<EntityId, number>;
    colorKeys: Map<EntityId, number>;
    colorDirty: boolean;
    freeSlots: number[];
    nextSlot: number;
  } {
    let pool = this.polyChassis.get(rendererId);
    if (pool) return pool;
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(
      geom,
      mat,
      Render3DEntities.POLY_CHASSIS_CAP,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, this._instColor.set(0xffffff));
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    // Frustum culling: same caveat as smoothChassis / unitInstanced.
    // Source geometry's bounding sphere is at origin; instances live
    // anywhere on the map.
    mesh.frustumCulled = false;
    for (let i = 0; i < Render3DEntities.POLY_CHASSIS_CAP; i++) {
      mesh.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
    }
    // Same draw-bound logic — count tracks allocated slots, not the
    // buffer's static cap. Per-frame writer bumps count to
    // pool.nextSlot at end-of-update.
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
    this.world.add(mesh);
    pool = {
      mesh,
      slots: new Map(),
      colorKeys: new Map(),
      colorDirty: false,
      freeSlots: [],
      nextSlot: 0,
    };
    this.polyChassis.set(rendererId, pool);
    return pool;
  }

  /** Reserve one slot for entity `eid` in the per-renderer poly pool.
   *  Returns the slot index, or null when the cap is exhausted (caller
   *  falls back to per-Mesh chassis). */
  private allocPolyChassisSlot(
    eid: EntityId,
    rendererId: string,
    geom: THREE.BufferGeometry,
  ): number | null {
    const pool = this.getOrCreatePolyPool(rendererId, geom);
    let slot: number;
    if (pool.freeSlots.length > 0) {
      slot = pool.freeSlots.pop()!;
    } else if (pool.nextSlot < Render3DEntities.POLY_CHASSIS_CAP) {
      slot = pool.nextSlot++;
    } else {
      return null;
    }
    pool.slots.set(eid, slot);
    return slot;
  }

  /** Release entity `eid`'s slot in renderer `rendererId`'s pool back
   *  to the free list. Called from the per-frame seen-pruning loop on
   *  unit despawn. */
  private freePolyChassisSlotForEntity(
    rendererId: string,
    eid: EntityId,
  ): void {
    const pool = this.polyChassis.get(rendererId);
    if (!pool) return;
    const slot = pool.slots.get(eid);
    if (slot === undefined) return;
    pool.mesh.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
    pool.freeSlots.push(slot);
    pool.slots.delete(eid);
    pool.colorKeys.delete(eid);
    pool.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Reserve a slot for a turret head. Returns slot index, or null
   *  when the cap is exhausted (caller falls back to per-Mesh head
   *  via TurretMesh3D's normal head-creation path). */
  private allocTurretHeadSlot(): number | null {
    if (!this.turretHeadInstanced) return null;
    if (this.turretHeadFreeSlots.length > 0) {
      return this.turretHeadFreeSlots.pop()!;
    }
    if (this.turretHeadNextSlot < Render3DEntities.TURRET_HEAD_CAP) {
      return this.turretHeadNextSlot++;
    }
    return null;
  }

  /** Hide one turret-head slot and push it back on the free list.
   *  Called from the seen-pruning loop on unit despawn (each turret
   *  on the unit gets its head slot freed). */
  private freeTurretHeadSlot(slot: number): void {
    const im = this.turretHeadInstanced;
    if (!im || slot < 0) return;
    im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
    this.turretHeadFreeSlots.push(slot);
    this.turretHeadColorKey.delete(slot);
    im.instanceMatrix.needsUpdate = true;
  }

  /** Wipe every active turret-head slot (LOD flip). The mesh stays
   *  in the scene with count = 0 until allocations refill it. */
  private releaseAllTurretHeadSlots(): void {
    const im = this.turretHeadInstanced;
    if (!im) return;
    for (let i = 0; i < this.turretHeadNextSlot; i++) {
      im.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
    }
    this.turretHeadFreeSlots.length = 0;
    this.turretHeadColorKey.clear();
    this.turretHeadColorDirty = false;
    this.turretHeadNextSlot = 0;
    im.count = 0;
    im.instanceMatrix.needsUpdate = true;
  }

  /** Reserve a slot for a single barrel cylinder. Returns slot
   *  index, or null when the cap is exhausted (caller falls back to
   *  per-Mesh barrels for the whole turret — see TurretMesh3D's
   *  skipBarrels path). */
  private allocBarrelSlot(): number | null {
    if (!this.barrelInstanced) return null;
    if (this.barrelFreeSlots.length > 0) return this.barrelFreeSlots.pop()!;
    if (this.barrelNextSlot < Render3DEntities.BARREL_CAP) {
      return this.barrelNextSlot++;
    }
    return null;
  }

  /** Hide one barrel slot and push it back on the free list. Used by
   *  the seen-pruning loop on unit despawn (each barrel on each
   *  turret on the unit gets its slot freed). */
  private freeBarrelSlot(slot: number): void {
    const im = this.barrelInstanced;
    if (!im || slot < 0) return;
    im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
    this.barrelFreeSlots.push(slot);
    im.instanceMatrix.needsUpdate = true;
  }

  /** Wipe every active barrel slot (LOD flip / teardown). Same
   *  shape as the head + chassis releases. */
  private releaseAllBarrelSlots(): void {
    const im = this.barrelInstanced;
    if (!im) return;
    for (let i = 0; i < this.barrelNextSlot; i++) {
      im.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
    }
    this.barrelFreeSlots.length = 0;
    this.barrelNextSlot = 0;
    im.count = 0;
    im.instanceMatrix.needsUpdate = true;
  }

  /** Reserve a slot for one mirror panel. Returns slot index, or
   *  null when the cap is exhausted (caller falls back to per-Mesh
   *  panels for the whole unit — all-or-nothing same as barrels). */
  private allocMirrorPanelSlot(): number | null {
    if (!this.mirrorPanelInstanced) return null;
    if (this.mirrorPanelFreeSlots.length > 0) return this.mirrorPanelFreeSlots.pop()!;
    if (this.mirrorPanelNextSlot < Render3DEntities.MIRROR_PANEL_CAP) {
      return this.mirrorPanelNextSlot++;
    }
    return null;
  }

  private freeMirrorPanelSlot(slot: number): void {
    const im = this.mirrorPanelInstanced;
    if (!im || slot < 0) return;
    im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
    this.mirrorPanelFreeSlots.push(slot);
    this.mirrorPanelColorKey.delete(slot);
    im.instanceMatrix.needsUpdate = true;
  }

  private releaseAllMirrorPanelSlots(): void {
    const im = this.mirrorPanelInstanced;
    if (!im) return;
    for (let i = 0; i < this.mirrorPanelNextSlot; i++) {
      im.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
    }
    this.mirrorPanelFreeSlots.length = 0;
    this.mirrorPanelColorKey.clear();
    this.mirrorPanelColorDirty = false;
    this.mirrorPanelNextSlot = 0;
    im.count = 0;
    im.instanceMatrix.needsUpdate = true;
  }

  /** Wipe every active polygonal-chassis slot across every per-renderer
   *  pool (LOD flip). The pool meshes stay in the scene with count = 0
   *  (no GPU draw work) until the next allocation refills them. */
  private releaseAllPolyChassisSlots(): void {
    for (const pool of this.polyChassis.values()) {
      for (const slot of pool.slots.values()) {
        pool.mesh.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
      }
      pool.slots.clear();
      pool.colorKeys.clear();
      pool.colorDirty = false;
      pool.freeSlots.length = 0;
      pool.nextSlot = 0;
      pool.mesh.count = 0;
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
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

  private destroyUnitMesh(id: EntityId, m: EntityMesh): void {
    destroyLocomotion(m.locomotion, this.legRenderer);
    this.world.remove(m.group);
    this.disposeWorldParentedOverlays(m);
    if (m.smoothChassisSlots) this.freeSmoothChassisSlotsForEntity(id);
    if (m.polyChassisSlot !== undefined) this.freePolyChassisSlotForEntity(m.rendererId, id);
    for (const tm of m.turrets) {
      if (tm.headSlot !== undefined) this.freeTurretHeadSlot(tm.headSlot);
      if (tm.barrelSlots) {
        for (const slot of tm.barrelSlots) this.freeBarrelSlot(slot);
      }
    }
    if (m.mirrors?.panelSlots) {
      for (const slot of m.mirrors.panelSlots) this.freeMirrorPanelSlot(slot);
    }
    this.unitMeshes.delete(id);
  }


  /** Advance the barrel-spin state for one unit. Picks the first
   *  multi-barrel turret as the spin source, accelerates toward max
   *  while any turret is engaged, decelerates toward idle otherwise.
   *  Called inline from the per-entity loop in updateUnits — fuses
   *  what used to be a separate full sweep over getUnits(). */
  private advanceBarrelSpin(entity: Entity, dt: number): void {
    if (!entity.turrets) return;
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
    if (!spinConfig) return;

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

  private resolveEntityObjectLod(entity: Entity): RenderObjectLodTier {
    return this.objectLodGrid.resolve(
      entity.transform.x,
      entity.transform.z,
      entity.transform.y,
    );
  }

  private updateUnits(): void {
    const units = this.clientViewState.getUnits();
    const unitRenderMode = this.lod.gfx.unitRenderMode;

    if (unitRenderMode === 'mass') {
      this.massRichUnitIds.clear();
      this.massRichUnits.length = 0;
      if (this.unitMeshes.size > 0) {
        this.rebuildAllUnitsOnLodChange();
      }
      this.updateUnitsInstanced(units);
      return;
    }

    if (unitRenderMode === 'hybrid') {
      const richUnits = this.updateUnitsInstanced(units, true);
      this.updateUnitMeshes(richUnits);
      return;
    }

    if (this.unitInstancedSlot.size > 0) {
      this.releaseAllInstancedSlots();
    }
    this.updateUnitMeshes(units);
  }

  private updateUnitMeshes(units: readonly Entity[]): void {
    const seen = this._seenUnitIds;
    seen.clear();
    const spinDt = this._spinDt;
    let smoothColorDirty = false;
    this.turretHeadColorDirty = false;
    this.mirrorPanelColorDirty = false;

    for (const e of units) {
      seen.add(e.id);
      // RIGID-BODY POSE TRACKS THE SIM EVERY FRAME, scope or no scope.
      // The unit group carries the chassis AND its child turret /
      // mirror groups (both parented to yawGroup). Skipping the
      // group-level position/yaw update for off-scope units would
      // leave the whole rigid body — turrets included — frozen at
      // its last on-screen pose; if the camera then panned to it
      // before the next in-scope tick, the user would see a unit
      // floating somewhere it isn't. Cheap to set unconditionally.
      const inScope = this.scope.inScope(e.transform.x, e.transform.y, 100);
      const existing = this.unitMeshes.get(e.id);
      if (existing) {
        const r0 = e.unit?.unitRadiusCollider.push ?? 0;
        existing.group.position.set(e.transform.x, e.transform.z - r0, e.transform.y);
        if (existing.yawGroup) existing.yawGroup.rotation.set(0, -e.transform.rotation, 0);
      }
      // The expensive per-frame work below (terrain normal, slope tilt,
      // locomotion, mirror tracking, range rings, turret-aim math) IS
      // scope-gated. Off-scope units keep their last-known turret yaw /
      // pitch and last-known leg positions; three.js frustum-culls them
      // so the staleness isn't visible until they come back into scope,
      // at which point the next in-scope tick refreshes them.
      if (!inScope) continue;
      // Barrel spin is visual-only, so advance it only for units that
      // are in the active render scope. Off-scope units catch up to
      // their current firing/idle state on the first visible frame.
      this.advanceBarrelSpin(e, spinDt);
      // Use `scale` (visual) rather than `shot` (collider) for horizontal
      // footprint, matching the 2D renderer. Body height is per-unit
      // (see BodyShape3D / BodyDimensions); turrets mount on top of
      // whatever height the body resolves to.
      const radius = e.unit?.unitRadiusCollider.scale
        ?? e.unit?.unitRadiusCollider.shot
        ?? 15;
      const pid = e.ownership?.playerId;
      const colorKey = pid ?? -1;
      const turrets = e.turrets ?? [];
      const objectTier = this.resolveEntityObjectLod(e);
      const isCommanderUnit = e.commander !== undefined;
      const fullUnitDetail =
        isRichObjectLod(objectTier) || objectTier === 'simple' || objectTier === 'impostor';
      const unitGraphicsTier = objectTier === 'impostor'
        ? 'min'
        : objectLodToGraphicsTier(objectTier, this.lod.gfx.tier);
      const unitGfx = getGraphicsConfigFor(unitGraphicsTier);
      const unitLodKey = lodKey(unitGfx);

      let m = this.unitMeshes.get(e.id);
      if (m && m.lodKey !== unitLodKey) {
        this.destroyUnitMesh(e.id, m);
        m = undefined;
      }
      if (!m) {
        const group = new THREE.Group();
        // Pull the 2D renderer id from the unit blueprint and use the
        // matching 3D body (scout=diamond, tank=pentagon, arachnid=big
        // sphere + small sphere, etc.). Falls back to arachnid for
        // unknown renderers.
        let bp;
        try { bp = getUnitBlueprint(e.unit!.unitType); }
        catch { /* leave undefined; fallback handled below */ }
        const rendererId = bp?.renderer ?? 'arachnid';
        const bodyShape = bp?.bodyShape ?? {
          kind: 'composite',
          parts: [
            { kind: 'circle', offsetForward: -1.1, radiusFrac: 1.15, yFrac: 1.15 },
            { kind: 'circle', offsetForward: 0.3, radiusFrac: 0.55, yFrac: 0.55 },
          ],
        } satisfies UnitBodyShape;
        const bodyEntry = getBodyGeom(bodyShape);
        // The chassis is a group so composite bodies (arachnid, beam,
        // commander — multiple spheres/spheroids) and single-part bodies
        // (tank, loris, …) share one code path. Each BodyMeshPart's
        // center offset and per-axis scale are expressed in
        // unit-radius-1 space, so we uniformly scale the whole chassis
        // group by the unit's render radius below and every part ends
        // up at the right world size and position.
        // Yaw subgroup. The unit's facing rotation lives here so that
        // the parent `group` can carry the surface TILT in world frame
        // — i.e., yaw is INNER (around the chassis-local up = slope
        // up) and tilt is OUTER (around world up before yaw). That's
        // the realistic "vehicle yaws along the slope" hierarchy.
        const yawGroup = new THREE.Group();
        yawGroup.userData.entityId = e.id;
        group.add(yawGroup);

        // Lift subgroup. Treads / wheels / legs (locomotion) live
        // directly inside yawGroup and touch the ground; the BODY
        // (chassis, turret roots, mirrors, force-field) lives in
        // liftGroup and rides above the ground at the locomotion's
        // natural height. Vehicle on its wheels, spider on its legs.
        // `getChassisLift` reads the blueprint's locomotion config
        // once at build time — TREAD_HEIGHT for treads, full wheel
        // diameter for wheels, and a small per-radius lift for legs.
        const liftGroup = new THREE.Group();
        liftGroup.userData.entityId = e.id;
        liftGroup.position.y = bp ? getChassisLift(bp, radius) : 0;
        yawGroup.add(liftGroup);

        const chassis = new THREE.Group();
        chassis.userData.entityId = e.id;
        const chassisMeshes: THREE.Mesh[] = [];
        // Chassis routing — three paths in priority order:
        //   1. Smooth body  → `smoothChassis` InstancedMesh (one shared
        //      sphere geometry, multiple slots per composite).
        //   2. Polygon / rect → per-renderer `polyChassis` pool (one
        //      InstancedMesh per renderer ID, single slot per unit
        //      because polygonal bodies are single-part).
        //   3. Cap exhausted → fall back to per-Mesh chassis (one Mesh
        //      per part, shared team-primary material).
        // Per-instance matrix + color are written by the per-frame
        // transform pipeline below; the per-Mesh fallback is rendered
        // by the scenegraph chain like before.
        let smoothChassisSlots: number[] | undefined;
        let polyChassisSlot: number | undefined;
        if (bodyEntry.isSmooth && bodyEntry.parts.length > 0) {
          smoothChassisSlots = this.allocSmoothChassisSlots(bodyEntry.parts.length) ?? undefined;
        } else if (!bodyEntry.isSmooth && bodyEntry.parts.length > 0) {
          const allocated = this.allocPolyChassisSlot(
            e.id, rendererId, bodyEntry.parts[0].geometry,
          );
          if (allocated !== null) polyChassisSlot = allocated;
        }
        if (!smoothChassisSlots && polyChassisSlot === undefined) {
          for (const part of bodyEntry.parts) {
            const mesh = new THREE.Mesh(part.geometry, this.getPrimaryMat(pid));
            mesh.position.set(part.x, part.y, part.z);
            mesh.scale.set(part.scaleX, part.scaleY, part.scaleZ);
            mesh.userData.entityId = e.id;
            chassis.add(mesh);
            chassisMeshes.push(mesh);
          }
        }
        liftGroup.add(chassis);
        if (e.commander) {
          const commanderKit = this.buildCommanderVisualKit(unitGraphicsTier);
          commanderKit.userData.entityId = e.id;
          commanderKit.traverse((obj) => { obj.userData.entityId = e.id; });
          chassis.add(commanderKit);
        }

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
        const turretOff = unitGfx.turretStyle === 'none';
        for (let ti = 0; ti < turrets.length; ti++) {
          const t = turrets[ti];
          const isMirrorHost = unitHasMirrors && ti === 0;
          // Decide whether to route this turret's head through the
          // shared `turretHeadInstanced` InstancedMesh. The same
          // hideHead conditions buildTurretMesh3D uses (turret-off
          // / force-field / mirror-host) skip the slot entirely; for
          // visible heads, alloc a slot and pass `skipHead: true`
          // so buildTurretMesh3D doesn't ALSO build a per-Mesh head
          // (would double-render). Slot alloc returns null on cap
          // exhaustion → fall back to per-Mesh head.
          const isForceField = (t.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
          const hideHead = turretOff || isForceField || isMirrorHost;
          let headSlot: number | undefined;
          if (!hideHead && !isCommanderUnit) {
            const allocated = this.allocTurretHeadSlot();
            if (allocated !== null) headSlot = allocated;
          }
          // Decide whether to route this turret's barrels through the
          // shared `barrelInstanced` InstancedMesh. Force-field and
          // turretOff turrets have no barrels; mirror-host turrets
          // also skip (they're a panel host, not a shooter). For
          // shooting turrets, we don't yet know how many barrels
          // until buildTurretMesh3D runs (multiBarrel patterns vary
          // by config). Build first; if barrels are produced, walk
          // them and try to alloc slots. If ALL allocs succeed, skip
          // attaching to spinGroup (we re-parent them to nowhere
          // below). If ANY alloc fails, free the partials and let
          // the per-Mesh path render — keeps the fallback simple,
          // never a hybrid render where some barrels of a turret are
          // instanced and some aren't.
          //
          // To support this, we build with skipBarrels = false first,
          // then re-detach on the success path. Simpler than running
          // pushSegment twice or threading a "build silently then
          // attach later" flag through TurretMesh3D.
          // Turrets parent to `liftGroup` so they ride on top of the
          // chassis at the locomotion's lift height — wheels carry
          // both chassis AND turret, treads do the same. Articulated
          // yaw + pitch (per-frame, below) compensate for chassis
          // tilt so the world barrel direction still matches the
          // sim's weapon.rotation / weapon.pitch even though the
          // parent chain is tilted.
          const tm = buildTurretMesh3D(liftGroup, t, radius, isMirrorHost, unitGfx, {
            headGeom: this.turretHeadGeom,
            barrelGeom: this.barrelGeom,
            barrelMat: this.barrelMat,
            primaryMat: this.getPrimaryMat(pid),
            skipHead: headSlot !== undefined,
            skipBarrels: false, // try to attach for fallback safety
          });
          if (tm.head) tm.head.userData.entityId = e.id;
          if (isCommanderUnit && !hideHead) this.decorateCommanderTurret(tm, t.config.id, unitGraphicsTier);
          for (const b of tm.barrels) b.userData.entityId = e.id;
          tm.headSlot = headSlot;
          // Try to allocate one barrel slot per barrel. All-or-nothing:
          // partial allocations get freed and we leave the per-Mesh
          // barrels in the scene as the fallback.
          if (tm.barrels.length > 0 && this.barrelInstanced) {
            const barrelSlots: number[] = [];
            let allAlloc = true;
            for (let bi = 0; bi < tm.barrels.length; bi++) {
              const slot = this.allocBarrelSlot();
              if (slot === null) { allAlloc = false; break; }
              barrelSlots.push(slot);
            }
            if (allAlloc) {
              tm.barrelSlots = barrelSlots;
              // Detach the per-Mesh barrels from spinGroup so they
              // don't double-render — we still keep the Mesh
              // references in tm.barrels[] as the per-frame writer
              // reads .position / .quaternion / .scale off them.
              for (const b of tm.barrels) b.parent?.remove(b);
            } else {
              // Partial alloc → free what we got, fall back to per-Mesh.
              for (const slot of barrelSlots) this.freeBarrelSlot(slot);
            }
          }
          turretMeshes.push(tm);
        }

        const constructionEmitter = e.commander && e.builder
          ? buildConstructionEmitterRig(Math.max(5, radius * 0.34))
          : undefined;
        if (constructionEmitter) {
          constructionEmitter.group.userData.entityId = e.id;
          constructionEmitter.group.traverse((obj) => { obj.userData.entityId = e.id; });
          constructionEmitter.group.position.set(
            -radius * 0.42,
            bodyEntry.topY * radius + radius * 0.14,
            0,
          );
          liftGroup.add(constructionEmitter.group);
        }

        this.world.add(group);
        m = {
          group, yawGroup, liftGroup, chassis, chassisMeshes, rendererId, bodyShape,
          turrets: turretMeshes, lodKey: unitLodKey,
          constructionEmitter,
          smoothChassisSlots,
          polyChassisSlot,
          // Cache the lift so the chassis instance writers can
          // reproduce the liftGroup translation in their manual
          // matrix composition (their slots are parented to the
          // world group, not liftGroup, so the scenegraph chain
          // doesn't apply lift for them).
          chassisLift: liftGroup.position.y,
        };
        if (smoothChassisSlots) {
          this.smoothChassisSlots.set(e.id, smoothChassisSlots);
        }
        // (polyChassisSlot is already registered in the pool's slots
        // map by allocPolyChassisSlot above — no extra bookkeeping
        // needed here.)

        // Locomotion (tank treads / vehicle wheels / arachnid legs).
        // Treads + wheels parent to `yawGroup` so they yaw + tilt
        // with the chassis. LEGS are world-space again — they parent
        // to `this.world` so each foot can be planted at a real
        // terrain XYZ that doesn't move when the body moves or yaws.
        // The map dims feed the leg builder + per-frame logic so
        // snap targets can sample terrain elevation directly.
        m.locomotion = buildLocomotion(
          yawGroup, this.world, e, radius, pid, unitGfx,
          this.clientViewState.getMapWidth(),
          this.clientViewState.getMapHeight(),
          this.legRenderer,
        );


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
          // Mirror panels parent to liftGroup like turrets — they're
          // physically attached to the chassis. Try to alloc one
          // slot per panel through the shared mirrorPanelInstanced
          // (all-or-nothing: partial alloc gets freed and per-Mesh
          // panels stay attached as the fallback). On success, the
          // per-Mesh panels are kept in m.mirrors.panels[] purely
          // as data carriers (their .position / .quaternion / .scale
          // are read each frame to compose the world matrix written
          // to the slot).
          const panelCount = mirrorPanels.length;
          const allocedPanelSlots: number[] = [];
          let allMirrorAlloc = panelCount > 0 && this.mirrorPanelInstanced !== null;
          if (allMirrorAlloc) {
            for (let pi = 0; pi < panelCount; pi++) {
              const slot = this.allocMirrorPanelSlot();
              if (slot === null) { allMirrorAlloc = false; break; }
              allocedPanelSlots.push(slot);
            }
            if (!allMirrorAlloc) {
              for (const slot of allocedPanelSlots) this.freeMirrorPanelSlot(slot);
              allocedPanelSlots.length = 0;
            }
          }
          m.mirrors = buildMirrorMesh3D(
            liftGroup, mirrorPanels, panelTopY,
            this.mirrorGeom, this.getMirrorShinyMat(pid),
            allMirrorAlloc, // skipPerMesh when instancing is on
          );
          if (allMirrorAlloc) m.mirrors.panelSlots = allocedPanelSlots;
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
      m.chassis.visible = fullUnitDetail;

      // Position group at the unit's footprint. sim.x → Three.x, sim.y
      // → Three.z (the existing horizontal convention). Vertical =
      // sim.z - radius: for a ground-resting unit sim.z == radius, so
      // the group sits at y=0 and the chassis/turret meshes inside it
      // still stack from the ground up. If the unit is pushed airborne
      // by an explosion or falling from an overhang, the entire group
      // lifts with it — no per-child Y touchups needed.
      const unitRadius = e.unit?.unitRadiusCollider.push ?? 0;
      m.group.position.set(e.transform.x, e.transform.z - unitRadius, e.transform.y);

      // unitGroup (m.group) carries POSITION + the world-frame TILT.
      // m.yawGroup (the inner group) carries the chassis YAW around
      // the slope's local up. The hierarchy is:
      //
      //   world  =  T(unit_base) · tilt · Ry(yaw) · local_point
      //
      // — tilt OUTER (world frame), yaw INNER (slope tangent plane).
      // This matches a vehicle yawing along its slope: the unit's
      // tilt direction is property of the ground (not the unit's
      // facing), and the yaw rotates the unit's "facing" within the
      // slope tangent plane. Outside the ripple disc the surface
      // gradient is exactly zero and `m.group.quaternion` collapses
      // to identity — same fast path as before.
      const yaw = -e.transform.rotation;
      let chassisTilted = false;
      const n = getGroundNormal(
        e.transform.x, e.transform.y,
        this.clientViewState.getMapWidth(), this.clientViewState.getMapHeight(),
      );
      if (n.nx === 0 && n.ny === 0) {
        m.group.quaternion.identity();
      } else {
        // sim normal (nx, ny, nz=up) → three.js (nx, nz, ny).
        _tiltSurfaceN.set(n.nx, n.nz, n.ny);
        _tiltQuat.setFromUnitVectors(_threeUp, _tiltSurfaceN);
        m.group.quaternion.copy(_tiltQuat);
        // Cache inverse for the per-turret aim compensation below.
        _invTiltQuat.copy(_tiltQuat).invert();
        chassisTilted = true;
      }
      if (m.yawGroup) m.yawGroup.rotation.set(0, yaw, 0);

      // Chassis body lives entirely in unit-radius-1 space (see
      // BodyShape3D). Uniformly scaling the chassis group by the unit's
      // render radius multiplies every child part's offset AND per-axis
      // scale by the same factor — so a sphere part at (x=0.3, y=0.55,
      // z=0) with scale (0.55, 0.55, 0.55) lands at the right place and
      // the right size automatically.
      const bodyEntry = getBodyGeom(m.bodyShape!);
      m.chassis.position.set(0, 0, 0);
      m.chassis.scale.setScalar(radius);

      // ── Per-unit chain cache ───────────────────────────────────────
      // The scenegraph chain `group · yawGroup · liftGroup` is used by
      // THREE downstream passes per unit: chassis (1×), turret-head
      // (K×), barrel (K×). Recomputing the parent quaternion + lifted
      // position 2K + 1 times — and rebuilding the barrel-chain prefix
      // matrix from m.group up via three Matrix4.compose / .multiply
      // pairs every turret — is wasted work that scales with turret
      // count. Precompute once here, then every consumer pulls from
      // the cached scratch vars (`_smoothParentQuat`, `_smoothLiftedPos`)
      // and the cached prefix matrix `_unitChainMat`.
      this._smoothYawQuat.setFromAxisAngle(_INST_UP, yaw);
      this._smoothParentQuat
        .copy(m.group.quaternion)
        .multiply(this._smoothYawQuat);
      {
        const lift = m.chassisLift ?? 0;
        this._smoothLiftOffset.set(0, lift, 0).applyQuaternion(this._smoothParentQuat);
        this._smoothLiftedPos.copy(m.group.position).add(this._smoothLiftOffset);
      }
      // Unscaled prefix matrix `T(liftedPos) · R(parentQuat) · S(1)`.
      // Barrel chain seeds from this; chassis paths still apply their
      // own radius scale on top of the cached parentQuat / liftedPos.
      this._unitChainMat.compose(
        this._smoothLiftedPos,
        this._smoothParentQuat,
        this._barrelOneVec,
      );

      // Smooth-body chassis: write each part's per-instance world
      // matrix + team color into the shared `smoothChassis`
      // InstancedMesh. The composition mirrors the per-Mesh
      // scenegraph chain (group → yawGroup → chassis → mesh):
      //
      //   parentMat = T(group.position)
      //             · R(group.quaternion · Ry(yaw))
      //             · S(radius, radius, radius)
      //   partMat   = T(part.x, part.y, part.z) · S(part.scale*)
      //   slotMat   = parentMat · partMat
      //
      // Doing it per-part means an arachnid's two segments take two
      // slots, a snipe / loris / forceField takes one. All slots feed
      // the same shared draw call.
      if (!fullUnitDetail) {
        if (m.smoothChassisSlots && this.smoothChassis) {
          for (const slot of m.smoothChassisSlots) {
            this.smoothChassis.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
          }
        } else if (m.polyChassisSlot !== undefined) {
          const pool = this.polyChassis.get(m.rendererId);
          if (pool) pool.mesh.setMatrixAt(m.polyChassisSlot, Render3DEntities._ZERO_MATRIX);
        }
      } else if (m.smoothChassisSlots && this.smoothChassis) {
        // Reuse cached parentQuat / liftedPos from the per-unit prefix
        // block above. Chassis adds its own radius scale on top of the
        // shared chain. parentMat = T(liftedPos) · R(parentQuat) · S(radius).
        this._smoothParentScale.set(radius, radius, radius);
        this._smoothParentMat.compose(
          this._smoothLiftedPos,
          this._smoothParentQuat,
          this._smoothParentScale,
        );
        const writeColor = this.smoothChassisColorKey.get(e.id) !== colorKey;
        if (writeColor) {
          this._instColor.set(
            pid !== undefined ? getPlayerColors(pid).primary : 0x888888,
          );
          this.smoothChassisColorKey.set(e.id, colorKey);
          smoothColorDirty = true;
        }
        const slotCount = Math.min(bodyEntry.parts.length, m.smoothChassisSlots.length);
        for (let pi = 0; pi < slotCount; pi++) {
          const part = bodyEntry.parts[pi];
          const slot = m.smoothChassisSlots[pi];
          this._smoothPartLocalPos.set(part.x, part.y, part.z);
          this._smoothPartScale.set(part.scaleX, part.scaleY, part.scaleZ);
          this._smoothPartMat.compose(
            this._smoothPartLocalPos,
            Render3DEntities._IDENTITY_QUAT,
            this._smoothPartScale,
          );
          this._smoothFinalMat.multiplyMatrices(
            this._smoothParentMat,
            this._smoothPartMat,
          );
          this.smoothChassis.setMatrixAt(slot, this._smoothFinalMat);
          if (writeColor) this.smoothChassis.setColorAt(slot, this._instColor);
        }
      } else if (m.polyChassisSlot !== undefined) {
        // Polygonal/rect chassis: same parentMat × partMat composition
        // as the smooth path, including the lift translation.
        const pool = this.polyChassis.get(m.rendererId);
        if (pool) {
          // Same per-unit chain as smooth chassis — reuse cached
          // parentQuat / liftedPos.
          this._smoothParentScale.set(radius, radius, radius);
          this._smoothParentMat.compose(
            this._smoothLiftedPos,
            this._smoothParentQuat,
            this._smoothParentScale,
          );
          const writeColor = pool.colorKeys.get(e.id) !== colorKey;
          if (writeColor) {
            this._instColor.set(
              pid !== undefined ? getPlayerColors(pid).primary : 0x888888,
            );
            pool.colorKeys.set(e.id, colorKey);
            pool.colorDirty = true;
          }
          const part = bodyEntry.parts[0];
          this._smoothPartLocalPos.set(part.x, part.y, part.z);
          this._smoothPartScale.set(part.scaleX, part.scaleY, part.scaleZ);
          this._smoothPartMat.compose(
            this._smoothPartLocalPos,
            Render3DEntities._IDENTITY_QUAT,
            this._smoothPartScale,
          );
          this._smoothFinalMat.multiplyMatrices(
            this._smoothParentMat,
            this._smoothPartMat,
          );
          pool.mesh.setMatrixAt(m.polyChassisSlot, this._smoothFinalMat);
          if (writeColor) pool.mesh.setColorAt(m.polyChassisSlot, this._instColor);
        }
      }

      // Turrets now mount on top of the per-unit body instead of a
      // shared CHASSIS_HEIGHT constant. Spheroid-bodied units like the
      // arachnid get a tall mount; squat polygons (scout, burst) get a
      // lower one.
      const bodyTopY = bodyEntry.topY * radius;

      // Selection halo — low torus wrapping the unit's base. Material
      // is the renderer-owned shared instance; the mesh is per-unit
      // so its scale tracks the unit's render radius.
      const selected = e.selectable?.selected === true;
      if (selected && !m.ring) {
        const ring = new THREE.Mesh(this.ringGeom, this.selectionRingMat);
        // TorusGeometry lies in XY by default; rotate it into XZ so
        // the donut rests on the local ground plane.
        ring.rotation.x = Math.PI / 2;
        m.group.add(ring);
        m.ring = ring;
      } else if (!selected && m.ring) {
        m.group.remove(m.ring);
        m.ring = undefined;
      }
      if (m.ring) {
        const ringR = radius * 1.35;
        m.ring.scale.setScalar(ringR);
        // Keep the torus slightly above the ground. The geometry's
        // tube radius is 0.06, so this places the lower curve just
        // above local y=0 after scaling.
        m.ring.position.y = ringR * 0.06 + 0.8;
      }

      // SCAL / SHOT / PUSH unit-radius indicator rings. The 2D renderer
      // draws these as stroked circles at the respective collider radii;
      // here we mirror the same toggle → ring visibility behaviour.
      this.updateRadiusRings(m, e);
      this.updateRangeRings(m, e);
      if (m.constructionEmitter) {
        m.constructionEmitter.group.visible = buildingTierAtLeast(unitGraphicsTier, 'low');
        m.constructionEmitter.group.rotation.y = this._lastSpinMs / 900;
      }

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
      const hostBodyTopYForStack = unitHasMirrorsHere
        ? getBodyMountTopY(
            m.bodyShape!,
            radius,
            turrets[0]?.offset.x ?? 0,
            turrets[0]?.offset.y ?? 0,
          )
        : bodyTopY;
      for (let i = 0; i < m.turrets.length && i < turrets.length; i++) {
        const tm = m.turrets[i];
        const t = turrets[i];
        const bodyMountTopY = getBodyMountTopY(
          m.bodyShape!,
          radius,
          t.offset.x,
          t.offset.y,
        );
        // Non-mirror turrets on mirror-host units sit ON TOP of the
        // mirror panel stack: root Y = panel top in chassis-local
        // coords = hostBodyTopY + 2·hostHeadRadius + MIRROR_EXTRA_HEIGHT.
        const turretMountY = unitHasMirrorsHere && i > 0
          ? hostBodyTopYForStack + 2 * hostHeadRadiusForStack + MIRROR_EXTRA_HEIGHT
          : bodyMountTopY;
        tm.root.position.set(t.offset.x, turretMountY, t.offset.y);

        // Head InstancedMesh write — the head sphere's chassis-local
        // position is (offset.x, mountY + headRadius, offset.y) inside
        // liftGroup, which world-transforms via:
        //   worldPos = groupPos + R(tilt·yaw)·(localX, lift + localY, localZ)
        //   matrix   = T(worldPos) · S(headRadius)
        // Head is rotation-invariant (sphere on the +Y rotation axis
        // of the turret root, where turret yaw rotates around — pitch
        // lives on a sub-group below the head). headRadius is cached
        // on the TurretMesh so we don't re-call getTurretHeadRadius.
        if (
          tm.headSlot !== undefined
          && this.turretHeadInstanced
          && tm.headRadius !== undefined
        ) {
          const lift = m.chassisLift ?? 0;
          // parentQuat is already cached for this unit. Compute the
          // turret-head position by rotating its chassis-local offset
          // through parentQuat and adding to group.position. Note the
          // cached liftedPos already includes the lift offset, but the
          // head's own y-component supplies (lift + mountY + headRadius)
          // explicitly here so we go from raw m.group.position, not
          // from liftedPos, to avoid double-counting lift.
          this._smoothPartLocalPos.set(
            t.offset.x,
            lift + turretMountY + tm.headRadius,
            t.offset.y,
          );
          this._smoothPartLocalPos.applyQuaternion(this._smoothParentQuat);
          this._smoothLiftedPos
            .copy(m.group.position)
            .add(this._smoothPartLocalPos);
          this._smoothPartScale.set(tm.headRadius, tm.headRadius, tm.headRadius);
          this._smoothPartMat.compose(
            this._smoothLiftedPos,
            Render3DEntities._IDENTITY_QUAT,
            this._smoothPartScale,
          );
          this.turretHeadInstanced.setMatrixAt(tm.headSlot, this._smoothPartMat);
          if (this.turretHeadColorKey.get(tm.headSlot) !== colorKey) {
            this._instColor.set(
              pid !== undefined ? getPlayerColors(pid).primary : 0x888888,
            );
            this.turretHeadInstanced.setColorAt(tm.headSlot, this._instColor);
            this.turretHeadColorKey.set(tm.headSlot, colorKey);
            this.turretHeadColorDirty = true;
          }
        }

        // Barrel InstancedMesh write — compose the FULL chain
        // (group · yawGroup · liftGroup · turretRoot · pitchGroup ·
        // spinGroup) once per turret, then for each barrel multiply
        // by its base local matrix (T(base.pos) · R(base.quat) ·
        // S(base.scale) — read off the per-Mesh barrel which holds
        // those values from pushSegment at build time even though
        // the Mesh is no longer attached to the scene). Each per-
        // turret matrix step uses Matrix4.compose on the relevant
        // group's stored position / rotation / scale so we don't
        // depend on THREE's lazy matrixWorld update timing.
        if (
          tm.barrelSlots
          && this.barrelInstanced
          && tm.barrels.length > 0
          && tm.barrelSlots.length === tm.barrels.length
        ) {
          // _barrelParentMat = group · yawGroup · liftGroup · turretRoot · pitchGroup · spinGroup
          // The first three groups (group · yawGroup · liftGroup) are
          // identical across every turret + every chassis pass on this
          // unit, so they're precomposed into `_unitChainMat` at the
          // top of the per-unit body. Seed _barrelParentMat from that
          // cached prefix matrix — saves three Matrix4.compose +
          // two Matrix4.multiply calls per turret per frame, plus the
          // setFromAxisAngle that built the yaw quaternion.
          this._barrelParentMat.copy(this._unitChainMat);
          // turretRoot: T(turret root pos) · R(turret root quat) · S(1).
          // Read directly off the (still-extant, in-scene) tm.root
          // so the per-frame yaw rotation set above is reflected.
          this._barrelStepMat.compose(
            tm.root.position, tm.root.quaternion, this._barrelOneVec,
          );
          this._barrelParentMat.multiply(this._barrelStepMat);
          // pitchGroup: T(pitch pos) · R(pitch quat) · S(1)
          if (tm.pitchGroup) {
            this._barrelStepMat.compose(
              tm.pitchGroup.position, tm.pitchGroup.quaternion, this._barrelOneVec,
            );
            this._barrelParentMat.multiply(this._barrelStepMat);
          }
          // spinGroup: T(0) · R(spin quat) · S(1)
          if (tm.spinGroup) {
            this._barrelStepMat.compose(
              tm.spinGroup.position, tm.spinGroup.quaternion, this._barrelOneVec,
            );
            this._barrelParentMat.multiply(this._barrelStepMat);
          }
          // Per-barrel: barrelLocalMat = T(barrel.pos) · R(barrel.quat) · S(barrel.scale)
          // worldMat = parentMat · barrelLocalMat
          for (let bi = 0; bi < tm.barrels.length; bi++) {
            const barrel = tm.barrels[bi];
            const slot = tm.barrelSlots[bi];
            this._barrelStepMat.compose(
              barrel.position, barrel.quaternion, barrel.scale,
            );
            this._smoothFinalMat.multiplyMatrices(
              this._barrelParentMat, this._barrelStepMat,
            );
            this.barrelInstanced.setMatrixAt(slot, this._smoothFinalMat);
          }
        }

        // Turret aim through the new hierarchy:
        //
        //   world barrel = tilt · Ry(yawGroup) · Ry(localYaw) · Rz(localPitch) · +X
        //
        // and we want the world barrel to equal the sim's intended
        // world direction (so the projectile spawn velocity, range
        // gates, and rendered barrel all agree). Solving:
        //
        //   1. Build the WORLD barrel direction in three.js coords
        //      from sim's t.rotation + t.pitch.
        //   2. Inverse-rotate by the chassis tilt to undo the parent
        //      tilt — this is the direction we need expressed in the
        //      tilted unit-yaw frame.
        //   3. Decompose into Ry(combinedYaw) · Rz(localPitch) · +X
        //      where combinedYaw = yawGroup.rotation.y + tm.root.rotation.y.
        //   4. tm.root.rotation.y = combinedYaw - yawGroup.rotation.y
        //                        = combinedYaw + e.transform.rotation.
        //
        // On flat ground (chassisTilted == false) the inverse-tilt is
        // identity and step 4 collapses to the original Euler formula
        // `e.transform.rotation - t.rotation`, so the fast path
        // matches existing visuals byte-for-byte.
        const cosTRot = Math.cos(t.rotation);
        const sinTRot = Math.sin(t.rotation);
        const cosPitch = Math.cos(t.pitch);
        const sinPitch = Math.sin(t.pitch);
        // World direction in three.js coords:
        //   sim (cos(r) cos(p), sin(r) cos(p), sin(p)) → three (cos(r) cos(p), sin(p), sin(r) cos(p)).
        _aimDir.set(cosTRot * cosPitch, sinPitch, sinTRot * cosPitch);
        if (chassisTilted) _aimDir.applyQuaternion(_invTiltQuat);
        // Decompose into Ry(combinedYaw) · Rz(localPitch) · +X.
        // Note three.js Ry(θ) rotates +X to (cos θ, 0, -sin θ), so
        // recovering θ from (x, ?, z) needs atan2(-z, x).
        const combinedYaw = Math.atan2(-_aimDir.z, _aimDir.x);
        const localYaw = combinedYaw + e.transform.rotation;
        const ny = _aimDir.y;
        const localPitch = Math.asin(ny < -1 ? -1 : ny > 1 ? 1 : ny);
        tm.root.rotation.y = localYaw;
        if (tm.pitchGroup) tm.pitchGroup.rotation.z = localPitch;
        // Spin: gatling roll around the LOCAL +X of the pitch group,
        // which is the actual barrel axis after the tilt-aware yaw
        // and pitch compose into the parent chain.
        if (tm.spinGroup) {
          tm.spinGroup.rotation.x = unitGfx.barrelSpin
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
        // Mirror root is a child of yawGroup (rigid hull) — same
        // tilt-compensated yaw the turret-aim path above uses. The
        // panel-pitch (rotation.x per panel) operates in the
        // tilt-corrected parent frame, so it still reads as a world-
        // horizontal-axis tilt of the panel surface.
        _aimDir.set(Math.cos(mirrorRot), 0, Math.sin(mirrorRot));
        if (chassisTilted) _aimDir.applyQuaternion(_invTiltQuat);
        const mCombinedYaw = Math.atan2(-_aimDir.z, _aimDir.x);
        m.mirrors.root.rotation.y = mCombinedYaw + e.transform.rotation;
        for (const panel of m.mirrors.panels) {
          panel.rotation.x = mirrorPitch;
        }

        // Mirror-panel InstancedMesh write — same chain-compose
        // pattern as barrels (group · yawGroup · liftGroup · mirrors.root),
        // multiplied by each panel's local T·R·S. Even when
        // skipPerMesh detached the per-Mesh panels from `mirrors.root`,
        // each panel's .position / .rotation / .scale are still set
        // (rotation.x just got the per-frame pitch update above), so
        // the InstancedMesh writer reads them as data.
        if (m.mirrors.panelSlots && this.mirrorPanelInstanced) {
          // parentMat = group · yawGroup · liftGroup · mirrors.root —
          // first three groups are the cached unit chain.
          this._barrelParentMat.copy(this._unitChainMat);
          // Mirror root rotation around Y in the lift-space frame.
          this._smoothYawQuat.setFromAxisAngle(_INST_UP, m.mirrors.root.rotation.y);
          this._barrelStepMat.compose(
            this._barrelZeroVec, this._smoothYawQuat, this._barrelOneVec,
          );
          this._barrelParentMat.multiply(this._barrelStepMat);

          const writeColor = this.mirrorPanelColorKey.get(m.mirrors.panelSlots[0]) !== colorKey;
          if (writeColor) {
            this._instColor.set(
              pid !== undefined ? getPlayerColors(pid).primary : 0x888888,
            );
            this.mirrorPanelColorDirty = true;
          }
          const slotCount = Math.min(
            m.mirrors.panels.length,
            m.mirrors.panelSlots.length,
          );
          for (let pi = 0; pi < slotCount; pi++) {
            const panel = m.mirrors.panels[pi];
            const slot = m.mirrors.panelSlots[pi];
            // panel.quaternion auto-syncs with panel.rotation
            // (Euler XYZ for the rotation-order detection — note
            // mirror panels use 'YXZ' order for the panel→world
            // sandwich; THREE syncs whichever order is set on
            // .rotation.order).
            this._barrelStepMat.compose(
              panel.position, panel.quaternion, panel.scale,
            );
            this._smoothFinalMat.multiplyMatrices(
              this._barrelParentMat, this._barrelStepMat,
            );
            this.mirrorPanelInstanced.setMatrixAt(slot, this._smoothFinalMat);
            if (writeColor) {
              this.mirrorPanelInstanced.setColorAt(slot, this._instColor);
              this.mirrorPanelColorKey.set(slot, colorKey);
            }
          }
        }
      }

      // Locomotion: spin tread wheels per velocity; legs write per-
      // instance buffers in the shared cylinder pool.
      if (m.locomotion) {
        updateLocomotion(
          m.locomotion, e, this._currentDtMs,
          this.clientViewState.getMapWidth(),
          this.clientViewState.getMapHeight(),
          this.legRenderer,
        );
      }

      // Health bar handled by HealthBar3D (billboarded sprite in the
      // world group, depth-occluded by terrain).
    }

    // Remove meshes for units no longer present.
    for (const [id, m] of this.unitMeshes) {
      if (!seen.has(id)) {
        destroyLocomotion(m.locomotion, this.legRenderer);
        this.world.remove(m.group);
        this.disposeWorldParentedOverlays(m);
        // Smooth-chassis slots are owned by this entity; release them
        // back to the pool so future smooth-body units can recycle the
        // slot indices.
        if (m.smoothChassisSlots) this.freeSmoothChassisSlotsForEntity(id);
        // Polygonal-chassis slot lives in the per-renderer pool keyed
        // by m.rendererId — release it back so a future unit of the
        // same renderer can take the slot.
        if (m.polyChassisSlot !== undefined) {
          this.freePolyChassisSlotForEntity(m.rendererId, id);
        }
        // Turret-head slots — one per turret on the unit that had a
        // visible head routed through the InstancedMesh path.
        for (const tm of m.turrets) {
          if (tm.headSlot !== undefined) this.freeTurretHeadSlot(tm.headSlot);
          // Barrel slots — one per barrel on each turret routed
          // through the barrel InstancedMesh path.
          if (tm.barrelSlots) {
            for (const slot of tm.barrelSlots) this.freeBarrelSlot(slot);
          }
        }
        // Mirror-panel slots (Loris-only).
        if (m.mirrors?.panelSlots) {
          for (const slot of m.mirrors.panelSlots) this.freeMirrorPanelSlot(slot);
        }
        this.unitMeshes.delete(id);
      }
    }
    // Drop barrel-spin state for units that no longer exist. Reuses
    // the same `seen` set populated by the unit loop above — no
    // separate sweep needed.
    for (const id of this.barrelSpins.keys()) {
      if (!seen.has(id)) this.barrelSpins.delete(id);
    }
    this.smoothChassisNextSlot = this.trimFreeTail(
      this.smoothChassisFreeSlots,
      this.smoothChassisNextSlot,
    );
    for (const pool of this.polyChassis.values()) {
      pool.nextSlot = this.trimFreeTail(pool.freeSlots, pool.nextSlot);
    }
    this.turretHeadNextSlot = this.trimFreeTail(
      this.turretHeadFreeSlots,
      this.turretHeadNextSlot,
    );
    this.barrelNextSlot = this.trimFreeTail(
      this.barrelFreeSlots,
      this.barrelNextSlot,
    );
    this.mirrorPanelNextSlot = this.trimFreeTail(
      this.mirrorPanelFreeSlots,
      this.mirrorPanelNextSlot,
    );
    // Flush smooth-chassis instance buffers + tighten draw bound
    // to the high-water mark so the GPU stops running the vertex
    // shader on the (CAP - nextSlot) trailing slots that have never
    // been allocated. count = nextSlot scales the VS load with peak
    // population instead of with the buffer's static cap (16384).
    if (this.smoothChassis) {
      this.smoothChassis.count = this.smoothChassisNextSlot;
      if (this.smoothChassisSlots.size > 0) {
        this.smoothChassis.instanceMatrix.needsUpdate = true;
        if (smoothColorDirty && this.smoothChassis.instanceColor) {
          this.smoothChassis.instanceColor.needsUpdate = true;
        }
      }
    }
    // Same for every per-renderer polygonal pool. count rides on
    // each pool's nextSlot independently so a pool serving 50 units
    // doesn't get stuck running 4096 VS invocations per frame just
    // because it shares the architecture with a busier renderer.
    for (const pool of this.polyChassis.values()) {
      pool.mesh.count = pool.nextSlot;
      if (pool.slots.size === 0) continue;
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (pool.colorDirty && pool.mesh.instanceColor) {
        pool.mesh.instanceColor.needsUpdate = true;
        pool.colorDirty = false;
      }
    }
    // Same for the turret-head InstancedMesh — one shared draw call
    // for every visible turret head across every unit on the map.
    if (this.turretHeadInstanced) {
      this.turretHeadInstanced.count = this.turretHeadNextSlot;
      if (this.turretHeadNextSlot > 0) {
        this.turretHeadInstanced.instanceMatrix.needsUpdate = true;
        if (this.turretHeadColorDirty && this.turretHeadInstanced.instanceColor) {
          this.turretHeadInstanced.instanceColor.needsUpdate = true;
        }
      }
    }
    // Barrels — one shared draw call for every barrel across every
    // turret on every unit. Color isn't written per frame (barrels
    // stay white in the current visual contract); the instanceColor
    // buffer was zeroed at construction so unused slots are white-on-
    // empty-matrix and nothing extra needs flushing.
    if (this.barrelInstanced) {
      this.barrelInstanced.count = this.barrelNextSlot;
      if (this.barrelNextSlot > 0) {
        this.barrelInstanced.instanceMatrix.needsUpdate = true;
      }
    }
    // Mirror panels — one shared chrome PBR draw call.
    if (this.mirrorPanelInstanced) {
      this.mirrorPanelInstanced.count = this.mirrorPanelNextSlot;
      if (this.mirrorPanelNextSlot > 0) {
        this.mirrorPanelInstanced.instanceMatrix.needsUpdate = true;
        if (this.mirrorPanelColorDirty && this.mirrorPanelInstanced.instanceColor) {
          this.mirrorPanelInstanced.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  private updateBuildings(): void {
    const buildings = this.clientViewState.getBuildings();
    const seen = this._seenBuildingIds;
    seen.clear();
    this.releaseFactorySprayTargets();

    // LOD-driven detail visibility for buildings. Each accent mesh now
    // declares its own tier range, and the per-object resolver can lower
    // distant buildings below the global tier without using footprint size.
    this.updateWindAnimationGlobals();
    this.extractorRotorPhase =
      (this.extractorRotorPhase + this._spinDt * EXTRACTOR_ROTOR_RAD_PER_SEC) % (Math.PI * 2);

    for (const e of buildings) {
      seen.add(e.id);
      // Buildings are sparse and strategically important. Do not apply
      // the 2D render-scope early-out here: it can disagree with the
      // perspective/frustum view at steep camera angles and make a
      // building vanish even though its 3D LOD cell should render a
      // full shape or marker. Let Three frustum-cull the final meshes.
      const objectTier = this.resolveEntityObjectLod(e);
      const markerOnly = objectTier === 'marker';
      const tier = markerOnly ? 'min' : objectLodToGraphicsTier(objectTier, this.lod.gfx.tier);
      const pid = e.ownership?.playerId;
      // Building type drives the per-type shape (factory, solar, …) —
      // fallback to 'unknown' for anything the art doesn't cover yet.
      const shapeType: BuildingShapeType =
        e.buildingType === 'factory' || e.buildingType === 'solar' || e.buildingType === 'wind' || e.buildingType === 'extractor'
          ? e.buildingType
          : 'unknown';
      const w = e.building?.width ?? 100;
      const d = e.building?.height ?? 100;

      let m = this.buildingMeshes.get(e.id);
      if (!m) {
        const group = new THREE.Group();
        group.userData.entityId = e.id;
        // Build the type-specific mesh set. Primary material is the
        // team primary color; details carry their own shared materials
        // so they don't re-color across teams.
        const shape = buildBuildingShape(shapeType, w, d, this.getPrimaryMat(pid));
        shape.primary.userData.entityId = e.id;
        // Wrap the primary body in an unscaled group so EntityMesh's
        // shared `chassis: Group` / `chassisMeshes: Mesh[]` shape works
        // for both buildings and units. The per-frame update below
        // positions and scales the primary body directly.
        const chassis = new THREE.Group();
        chassis.userData.entityId = e.id;
        chassis.add(shape.primary);
        group.add(chassis);
        for (const detail of shape.details) {
          detail.mesh.userData.entityId = e.id;
          group.add(detail.mesh);
        }
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
          factoryRig: shape.factoryRig,
          windRig: shape.windRig,
          extractorRig: shape.extractorRig,
          buildingHeight: shape.height,
          buildingPrimaryMaterialLocked: shape.primaryMaterialLocked === true,
          solarOpenAmount: e.building?.solar?.open === false ? 0 : 1,
        };
        this.buildingMeshes.set(e.id, m);
      } else if (!m.buildingPrimaryMaterialLocked) {
        m.group.visible = true;
        const primaryMat = this.getPrimaryMat(pid);
        for (const mesh of m.chassisMeshes) mesh.material = primaryMat;
      }
      if (m) m.group.visible = true;
      if (m.buildingDetails) {
        const primaryMat = this.getPrimaryMat(pid);
        for (const detail of m.buildingDetails) {
          if (detail.role === 'solarTeamAccent') detail.mesh.material = primaryMat;
        }
      }

      // Transform.z is the building's vertical center in sim space.
      // Render from the footprint base so buildings sit on the same
      // terrain height the server used when creating their collider.
      const buildingBaseY = e.building ? e.transform.z - e.building.depth / 2 : 0;
      m.group.position.set(e.transform.x, buildingBaseY, e.transform.y);
      m.group.rotation.y = -e.transform.rotation;
      const h = m.buildingHeight ?? BUILDING_HEIGHT;

      // Build-progress visual — mirrors the 2D BuildingRenderer's
      // bottom-up fill. Primary body scales vertically by buildProgress
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
      // Buildings own the single primary body at chassisMeshes[0]; scale
      // it directly instead of the chassis wrapper group (which stays
      // at identity so the building-detail meshes added alongside it
      // aren't affected).
      const primary = m.chassisMeshes[0];
      primary.position.set(0, renderH / 2, 0);
      primary.scale.set(w, renderH, d);
      primary.visible = !markerOnly;
      if (!m.lodMarker) {
        const marker = new THREE.Mesh(this.unitSphereLowGeom, this.getPrimaryMat(pid));
        marker.userData.entityId = e.id;
        m.group.add(marker);
        m.lodMarker = marker;
      } else {
        m.lodMarker.material = this.getPrimaryMat(pid);
      }
      const markerRadius = Math.max(
        e.buildingType === 'extractor' ? 18 : 12,
        Math.min(48, Math.hypot(w, d) * 0.16),
      );
      m.lodMarker.visible = markerOnly;
      m.lodMarker.position.set(0, markerRadius, 0);
      m.lodMarker.scale.setScalar(markerRadius);
      if (m.buildingDetails) {
        const detailsReady = !markerOnly && progress >= 1;
        for (const detail of m.buildingDetails) {
          const visible = detailsReady && buildingDetailVisible(detail, tier);
          detail.mesh.visible = visible;
        }
        this.updateSolarCollectorAnimation(m, e, detailsReady);
        this.updateWindTurbineRig(m, detailsReady);
        this.updateExtractorRig(m, e, detailsReady);
      }
      this.updateFactoryConstructionRig(m.factoryRig, e, tier, !markerOnly && progress >= 1, w, d, m.group);

      // Building selection halo. Uses the same torus material/geometry as
      // units so clicking a factory/solar/wind reads like selecting any
      // other owned entity. Scale by footprint diagonal so rectangular
      // buildings sit fully inside the donut.
      const selected = e.selectable?.selected === true;
      if (selected && !m.ring) {
        const ring = new THREE.Mesh(this.ringGeom, this.selectionRingMat);
        ring.rotation.x = Math.PI / 2;
        m.group.add(ring);
        m.ring = ring;
      } else if (!selected && m.ring) {
        m.group.remove(m.ring);
        m.ring = undefined;
      }
      if (m.ring) {
        const ringR = Math.hypot(w, d) * 0.55;
        m.ring.scale.setScalar(ringR);
        m.ring.position.set(0, ringR * 0.06 + 0.8, 0);
      }

      // Health + build-progress bars handled by HealthBar3D
      // (billboarded sprite in the world group).
    }

    for (const [id, m] of this.buildingMeshes) {
      if (!seen.has(id)) {
        this.world.remove(m.group);
        this.buildingMeshes.delete(id);
      }
    }
  }

  private releaseFactorySprayTargets(): void {
    for (let i = 0; i < this.factorySprayTargets.length; i++) {
      this.factorySprayTargetPool.push(this.factorySprayTargets[i]);
    }
    this.factorySprayTargets.length = 0;
  }

  private acquireFactorySprayTarget(): SprayTarget {
    let target = this.factorySprayTargetPool.pop();
    if (!target) {
      target = {
        source: { id: 0, pos: { x: 0, y: 0 }, z: 0, playerId: 1 as PlayerId },
        target: { id: 0, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
        type: 'build',
        intensity: 0,
      };
    }
    this.factorySprayTargets.push(target);
    return target;
  }

  private updateSolarCollectorAnimation(
    m: EntityMesh,
    e: Entity,
    detailsReady: boolean,
  ): void {
    if (e.buildingType !== 'solar' || !m.buildingDetails || !detailsReady) return;
    const target = e.building?.solar?.open === false ? 0 : 1;
    const current = m.solarOpenAmount ?? target;
    const next = Math.abs(target - current) < 0.002
      ? target
      : current + (target - current) * SOLAR_PETAL_ANIM_ALPHA;
    m.solarOpenAmount = next;

    const t = next * next * (3 - 2 * next);
    for (const detail of m.buildingDetails) {
      if (
        detail.role !== 'solarLeaf' &&
        detail.role !== 'solarPanel' &&
        detail.role !== 'solarTeamAccent'
      ) continue;
      const anim = detail.mesh.userData.solarPetal as SolarPetalAnimation | undefined;
      if (!anim) continue;
      const open = anim.openMatrix.elements;
      const closed = anim.closedMatrix.elements;
      const out = detail.mesh.matrix.elements;
      for (let i = 0; i < 16; i++) {
        out[i] = closed[i] + (open[i] - closed[i]) * t;
      }
      detail.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  private updateWindAnimationGlobals(): void {
    const wind = this.clientViewState.getServerMeta()?.wind;
    const now = performance.now();
    const dtSec = this.windAnimLastMs > 0 ? (now - this.windAnimLastMs) / 1000 : 0;
    this.windAnimLastMs = now;
    if (!wind) return;

    const targetYaw = Math.atan2(wind.x, wind.y);
    const targetSpeed = wind.speed;
    if (this.windFanYaw === null || this.windVisualSpeed === null || dtSec <= 0) {
      this.windFanYaw = targetYaw;
      this.windVisualSpeed = targetSpeed;
    } else {
      const preset = getDriftPreset(getDriftMode());
      this.windFanYaw = lerpAngle(
        this.windFanYaw,
        targetYaw,
        halfLifeBlend(
          dtSec,
          scaledWindTurbineHalfLife(
            preset.rotation.pos,
            WIND_TURBINE_DRIFT_EMA_HALF_LIFE_MULTIPLIERS.fanYaw,
          ),
        ),
      );
      this.windVisualSpeed = lerp(
        this.windVisualSpeed,
        targetSpeed,
        halfLifeBlend(
          dtSec,
          scaledWindTurbineHalfLife(
            preset.rotation.vel,
            WIND_TURBINE_DRIFT_EMA_HALF_LIFE_MULTIPLIERS.bladeSpeed,
          ),
        ),
      );
    }
    this.windRotorPhase += dtSec * this.windVisualSpeed * WIND_TURBINE_ROTOR_RAD_PER_SEC_PER_WIND_SPEED;
  }

  private updateWindTurbineRig(m: EntityMesh, detailsReady: boolean): void {
    if (!m.windRig || !detailsReady || !m.windRig.root.visible || this.windFanYaw === null) return;
    m.windRig.root.rotation.y = this.windFanYaw - m.group.rotation.y;
    m.windRig.rotor.rotation.z = this.windRotorPhase;
  }

  private updateExtractorRig(m: EntityMesh, e: Entity, detailsReady: boolean): void {
    if (!m.extractorRig || e.buildingType !== 'extractor' || !detailsReady) return;
    const phase = this.extractorRotorPhase + e.id * 0.173;
    if (m.extractorRig.rotor.visible) {
      m.extractorRig.rotor.rotation.y = -phase;
    }
  }

  private updateFactoryConstructionRig(
    rig: FactoryConstructionRig | undefined,
    e: Entity,
    tier: ConcreteGraphicsQuality,
    detailsReady: boolean,
    footprintW: number,
    footprintD: number,
    group: THREE.Group,
  ): void {
    if (!rig) return;

    const factory = e.factory;
    const queuedUnitType = factory?.buildQueue[0];
    const progress = Math.max(0, Math.min(1, factory?.currentBuildProgress ?? 0));
    const active = detailsReady
      && !!factory
      && !!queuedUnitType
      && (factory.isProducing || progress > 0);

    if (!active) {
      rig.unitGhost.visible = false;
      rig.unitCore.visible = false;
      for (const buildPulse of rig.buildPulses) buildPulse.visible = false;
      for (const spark of rig.sparks) spark.visible = false;
      return;
    }

    let blueprintRadius = Math.min(footprintW, footprintD) * 0.13;
    let buildSpotRadius = blueprintRadius;
    if (queuedUnitType) {
      try {
        const bp = getUnitBlueprint(queuedUnitType);
        blueprintRadius = bp.unitRadiusCollider.scale;
        buildSpotRadius = bp.unitRadiusCollider.push;
      } catch {
        // Unknown queue ids should not break rendering; keep the generic bay ghost.
      }
    }

    const maxBayRadius = Math.max(
      12,
      Math.min(getFactoryConstructionRadius() * 0.34, blueprintRadius * 1.35),
    );
    const baseRadius = Math.max(8, Math.min(maxBayRadius, blueprintRadius * 1.15));
    const easedProgress = progress * progress * (3 - 2 * progress);
    const radius = baseRadius * (0.28 + easedProgress * 0.72);
    const timeSec = this._lastSpinMs / 1000;
    const phase = timeSec * 4.7 + e.id * 0.19;
    const pulse = 1 + Math.sin(phase * 1.7) * 0.035;
    const centerY = rig.bayBaseY + Math.max(5, radius * 0.68);
    const buildSpot = getFactoryBuildSpot(e, buildSpotRadius, {
      mapWidth: this.clientViewState.getMapWidth(),
      mapHeight: this.clientViewState.getMapHeight(),
    }, this._factoryBuildSpot);
    const spotDx = buildSpot.x - e.transform.x;
    const spotDz = buildSpot.y - e.transform.y;
    const cos = Math.cos(e.transform.rotation);
    const sin = Math.sin(e.transform.rotation);
    const localSpotX = cos * spotDx + sin * spotDz;
    const localSpotZ = -sin * spotDx + cos * spotDz;

    rig.unitGhost.visible = buildingTierAtLeast(tier, 'medium');
    rig.unitGhost.position.set(localSpotX, centerY, localSpotZ);
    rig.unitGhost.scale.set(radius * 1.22 * pulse, Math.max(5, radius * 0.64), radius * pulse);

    rig.unitCore.visible = buildingTierAtLeast(tier, 'high');
    rig.unitCore.position.set(localSpotX, centerY + radius * 0.08, localSpotZ);
    rig.unitCore.scale.setScalar(Math.max(3, radius * 0.18));

    const showBuildPulses = tier === 'medium';
    const sourceX = rig.nozzleLocal.x;
    const sourceY = rig.nozzleLocal.y;
    const sourceZ = rig.nozzleLocal.z;
    const targetY = centerY + radius * 0.06;
    const pulseTravel = (timeSec * 0.92 + e.id * 0.071) % 1;
    for (let i = 0; i < rig.buildPulses.length; i++) {
      const buildPulse = rig.buildPulses[i];
      buildPulse.visible = showBuildPulses;
      if (!showBuildPulses) continue;

      const t = (i + 0.5 + pulseTravel) / rig.buildPulses.length;
      const wrappedT = t > 1 ? t - 1 : t;
      const arc = Math.sin(wrappedT * Math.PI);
      const wobble = Math.sin((wrappedT * 2.0 + phase * 0.19 + i * 0.31) * Math.PI * 2);
      buildPulse.position.set(
        sourceX + (localSpotX - sourceX) * wrappedT + wobble * radius * 0.035,
        sourceY + (targetY - sourceY) * wrappedT + arc * Math.max(8, radius * 0.38),
        sourceZ + (localSpotZ - sourceZ) * wrappedT - wobble * radius * 0.035,
      );
      buildPulse.scale.setScalar(Math.max(2.3, radius * (0.08 + arc * 0.035)));
    }

    if (buildingTierAtLeast(tier, 'high') && e.ownership) {
      group.updateWorldMatrix(true, false);
      this._factorySprayTargetLocal.set(localSpotX, 0, localSpotZ);
      this._factorySprayTargetLocal.y = centerY + radius * 0.06;
      this._factorySpraySourceWorld.copy(rig.nozzleLocal).applyMatrix4(group.matrixWorld);
      this._factorySprayTargetWorld.copy(this._factorySprayTargetLocal).applyMatrix4(group.matrixWorld);
      const spray = this.acquireFactorySprayTarget();
      spray.source.id = e.id;
      spray.source.pos.x = this._factorySpraySourceWorld.x;
      spray.source.pos.y = this._factorySpraySourceWorld.z;
      spray.source.z = this._factorySpraySourceWorld.y;
      spray.source.playerId = e.ownership.playerId;
      spray.target.id = e.id;
      spray.target.pos.x = this._factorySprayTargetWorld.x;
      spray.target.pos.y = this._factorySprayTargetWorld.z;
      spray.target.z = this._factorySprayTargetWorld.y;
      spray.target.dim = undefined;
      spray.target.radius = radius;
      spray.type = 'build';
      spray.intensity = Math.max(0.45, Math.min(1, 0.65 + easedProgress * 0.35));
    }

    const showSparks = buildingTierAtLeast(tier, 'max');
    for (let i = 0; i < rig.sparks.length; i++) {
      const spark = rig.sparks[i];
      spark.visible = showSparks;
      if (!showSparks) continue;

      const sparkPhase = phase * 1.8 + i * 1.37;
      const sparkRadius = radius * (0.2 + (i % 3) * 0.1);
      spark.position.set(
        localSpotX + Math.cos(sparkPhase) * sparkRadius,
        centerY + Math.sin(sparkPhase * 1.23) * radius * 0.38,
        localSpotZ + Math.sin(sparkPhase) * sparkRadius,
      );
      spark.scale.setScalar(Math.max(2.2, radius * (0.055 + (i % 2) * 0.015)));
    }
  }

  private updateProjectiles(): void {
    const projectiles = this.clientViewState.getProjectiles();
    const seen = this._seenProjectileIds;
    seen.clear();
    const sphereMesh = this.projectileSphereInstanced;
    const cylinderMesh = this.projectileCylinderInstanced;
    let sphereCount = 0;
    let cylinderCount = 0;

    for (const e of projectiles) {
      // Skip beams/lasers — handled by BeamRenderer3D as line segments rather
      // than spheres. Without this, long-range beams would render as a single
      // sphere at the wrong position.
      const pt = e.projectile?.projectileType;
      if (pt === 'beam' || pt === 'laser') continue;

      seen.add(e.id);
      // Scope gate — tighter padding (projectiles are small and moving fast).
      if (!this.scope.inScope(e.transform.x, e.transform.y, 50)) {
        this.hideProjRadiusMeshes(e.id);
        continue;
      }

      const objectTier = this.resolveEntityObjectLod(e);
      if (objectTier === 'marker') {
        this.hideProjRadiusMeshes(e.id);
        continue;
      }
      const projectileGraphicsTier = objectLodToGraphicsTier(objectTier, this.lod.gfx.tier);
      const richProjectile = objectTier === 'rich' || objectTier === 'hero' || objectTier === 'simple';
      const shot = e.projectile?.config.shot;
      // Projectile shots have collision.radius
      let radius = 4;
      if (shot && shot.type === 'projectile') radius = shot.collision.radius;
      const radiusScale = PROJECTILE_RADIUS_BY_TIER[projectileGraphicsTier];
      const visualRadius = radius * radiusScale;
      const isCylinder = richProjectile
        && shot
        && shot.type === 'projectile'
        && shot.shape === 'cylinder';

      // Projectile altitude is authoritative sim state (arcs through
      // real z from turret muzzle to ground / target). SHOT_HEIGHT is
      // no longer the truth — the sphere renders exactly where the
      // sim says it is.
      this._projPos.set(e.transform.x, e.transform.z, e.transform.y);

      if (isCylinder) {
        if (!cylinderMesh || cylinderCount >= Render3DEntities.PROJECTILE_INSTANCED_CAP) {
          this.hideProjRadiusMeshes(e.id);
          continue;
        }
        // Cylinder rocket body: stretch along its local +Y, then rotate
        // so +Y aligns with the projectile's velocity vector. World
        // length = radius · lengthMult, world diameter = radius ·
        // diameterMult — both pulled from the shot's `cylinderShape`
        // block so a designer can tune rocket aspect ratios per blueprint
        // (lightRocket vs heavyMissile vs torpedo etc.). The sim
        // collision footprint stays a sphere of collision.radius —
        // this is purely a render hint.
        const r = Math.max(visualRadius, PROJECTILE_MIN_RADIUS);
        const cylSpec = (shot && shot.type === 'projectile') ? shot.cylinderShape : undefined;
        const lengthMult = cylSpec?.lengthMult ?? Render3DEntities._PROJ_CYL_LENGTH_MULT_DEFAULT;
        const diameterMult = cylSpec?.diameterMult ?? Render3DEntities._PROJ_CYL_DIAMETER_MULT_DEFAULT;
        const length = r * lengthMult;
        const diameter = r * diameterMult;
        this._projScale.set(diameter, length, diameter);
        this._projQuat.identity();
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
          }
        }
        this._projMatrix.compose(this._projPos, this._projQuat, this._projScale);
        cylinderMesh.setMatrixAt(cylinderCount++, this._projMatrix);
      } else {
        if (!sphereMesh || sphereCount >= Render3DEntities.PROJECTILE_INSTANCED_CAP) {
          this.hideProjRadiusMeshes(e.id);
          continue;
        }
        // Match 2D: `fillCircle(x, y, radius)` — the sphere's world-space radius
        // equals the sim's shot.collision.radius. SphereGeometry has radius 1,
        // so setScalar(radius) is the correct scale.
        const r = Math.max(visualRadius, PROJECTILE_MIN_RADIUS);
        this._projScale.set(r, r, r);
        this._projMatrix.compose(
          this._projPos,
          Render3DEntities._IDENTITY_QUAT,
          this._projScale,
        );
        sphereMesh.setMatrixAt(sphereCount++, this._projMatrix);
      }

      if (richProjectile) {
        this.updateProjRadiusMeshes(e);
      } else {
        this.hideProjRadiusMeshes(e.id);
      }
    }

    if (sphereMesh) {
      sphereMesh.count = sphereCount;
      if (sphereCount > 0) this.markInstanceMatrixRange(sphereMesh, 0, sphereCount - 1);
    }
    if (cylinderMesh) {
      cylinderMesh.count = cylinderCount;
      if (cylinderCount > 0) this.markInstanceMatrixRange(cylinderMesh, 0, cylinderCount - 1);
    }

    // Drop SHOT RAD wireframes that went with despawned projectiles.
    for (const [id, radii] of this.projectileRadiusMeshes) {
      if (!seen.has(id)) {
        this.releaseProjRadiusMesh(radii.collision);
        this.releaseProjRadiusMesh(radii.explosion);
        this.projectileRadiusMeshes.delete(id);
      }
    }
  }

  /** Show/hide the per-projectile SHOT RAD wireframe spheres. COL is
   *  the actual collision capsule the swept-line 3D test uses; EXP is
   *  the boolean splash-damage sphere applied at detonation.
   *
   *  Spheres (not rings) because every one of these sim checks is 3D:
   *  `lineSphereIntersectionT` for COL, sphere-vs-sphere intersection
   *  for EXP. Drawing flat rings would under-sell what the sim tests —
   *  a high-arc shell's blast genuinely catches airborne targets above
   *  it. */
  private updateProjRadiusMeshes(entity: Entity): void {
    const proj = entity.projectile;
    if (!proj) return;
    const shot = proj.config.shot;
    if (shot.type !== 'projectile') return;

    const wantCol = getProjRangeToggle('collision');
    const wantExp = getProjRangeToggle('explosion');
    if (!wantCol && !wantExp) {
      // Fast path — nothing to show. Hide anything that was visible
      // last frame so flipping the toggle off doesn't leave a stale
      // sphere floating around.
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
      shot.collision.radius,
      this.projMatCollision,
    );
    this.setProjRadiusMesh(
      radii, 'explosion', wantExp && !proj.hasExploded,
      projX, projY, projZ,
      shot.explosion?.radius ?? 0,
      this.projMatExplosion,
    );
  }

  private hideProjRadiusMeshes(entityId: EntityId): void {
    const radii = this.projectileRadiusMeshes.get(entityId);
    if (!radii) return;
    if (radii.collision) radii.collision.visible = false;
    if (radii.explosion) radii.explosion.visible = false;
  }

  /** Internal helper — create/show/hide one of the SHOT RAD
   *  wireframe spheres on a projectile. */
  private setProjRadiusMesh(
    radii: { collision?: THREE.LineSegments; explosion?: THREE.LineSegments },
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
      mesh = this.projectileRadiusMeshPool.pop() ?? new THREE.LineSegments(this.radiusSphereGeom, mat);
      mesh.material = mat;
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

  private releaseProjRadiusMesh(mesh?: THREE.LineSegments): void {
    if (!mesh) return;
    mesh.visible = false;
    this.world.remove(mesh);
    this.projectileRadiusMeshPool.push(mesh);
  }

  /** Look up the lift subgroup for a unit's mesh. The lift group
   *  carries the body's vertical lift (so it sits on top of the
   *  locomotion instead of embedded in it) AND is parented through
   *  yawGroup → group, so it inherits position + tilt + yaw + lift.
   *  Renderers that attach extra meshes to a unit's BODY (not its
   *  locomotion) — e.g. the force-field bubble — parent to this
   *  group at chassis-local positions; the scenegraph chain places
   *  them in world. Returns undefined for units whose mesh hasn't
   *  been built yet (off-scope at scene start) or has been torn
   *  down (despawn / LOD-flip mid-frame). Buildings have no
   *  liftGroup so this is unit-only. */
  getUnitYawGroup(eid: EntityId): THREE.Group | undefined {
    return this.unitMeshes.get(eid)?.liftGroup;
  }

  getFactorySprayTargets(): readonly SprayTarget[] {
    return this.factorySprayTargets;
  }

  destroy(): void {
    // Per-unit overlays (TURR RAD rings, BLD ring, SCAL + PUSH rings)
    // are parented to the world group rather than the unit group so
    // they stay flat on the ground regardless of unit rotation /
    // altitude — destroy() has to release them explicitly.
    for (const m of this.unitMeshes.values()) {
      destroyLocomotion(m.locomotion, this.legRenderer);
      this.world.remove(m.group);
      this.disposeWorldParentedOverlays(m);
    }
    for (const m of this.buildingMeshes.values()) this.world.remove(m.group);
    if (this.projectileSphereInstanced) {
      this.world.remove(this.projectileSphereInstanced);
      this.projectileSphereInstanced.dispose();
      this.projectileSphereInstanced = null;
    }
    if (this.projectileCylinderInstanced) {
      this.world.remove(this.projectileCylinderInstanced);
      this.projectileCylinderInstanced.dispose();
      this.projectileCylinderInstanced = null;
    }
    for (const radii of this.projectileRadiusMeshes.values()) {
      if (radii.collision) this.world.remove(radii.collision);
      if (radii.explosion) this.world.remove(radii.explosion);
    }
    for (const mesh of this.projectileRadiusMeshPool) {
      this.world.remove(mesh);
    }
    this.unitMeshes.clear();
    this.buildingMeshes.clear();
    this.projectileRadiusMeshes.clear();
    this.projectileRadiusMeshPool.length = 0;
    this.factorySprayTargets.length = 0;
    this.factorySprayTargetPool.length = 0;
    // Polygonal-chassis pools must tear down BEFORE disposeBodyGeoms()
    // — their InstancedMeshes reference the BodyShape3D-owned per-
    // renderer ExtrudeGeometry objects that disposeBodyGeoms() releases.
    // Don't dispose the geometry here; that's BodyShape3D's
    // responsibility (called immediately below).
    for (const pool of this.polyChassis.values()) {
      this.world.remove(pool.mesh);
      (pool.mesh.material as THREE.Material).dispose();
      pool.mesh.dispose();
    }
    this.polyChassis.clear();
    disposeBodyGeoms();
    disposeBuildingGeoms();
    this.turretHeadGeom.dispose();
    this.commanderBoxGeom.dispose();
    this.commanderCylinderGeom.dispose();
    this.commanderDomeGeom.dispose();
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
    this.projMatExplosion.dispose();
    this.mirrorGeom.dispose();
    for (const m of this.mirrorShinyMats.values()) m.dispose();
    this.mirrorShinyMats.clear();
    this.mirrorShinyNeutralMat.dispose();
    this.commanderArmorMat.dispose();
    this.commanderTrimMat.dispose();
    this.commanderLensMat.dispose();
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
    this.unitInstancedColorKey.clear();
    this.unitInstancedHiddenIds.clear();
    this.massRichUnitIds.clear();
    this.massRichUnits.length = 0;
    this.unitInstancedEntityBySlot.length = 0;
    this.unitInstancedFreeSlots.length = 0;
    this.unitInstancedCompactFrame = 0;
    this.unitInstancedFrame = 0;
    if (this.smoothChassis) {
      this.world.remove(this.smoothChassis);
      // Material is a private MeshLambertMaterial only owned by this
      // InstancedMesh — dispose via the mesh. Geometry is the class
      // field below.
      (this.smoothChassis.material as THREE.Material).dispose();
      this.smoothChassis.dispose();
      this.smoothChassis = null;
    }
    this.smoothChassisGeom.dispose();
    this.smoothChassisSlots.clear();
    this.smoothChassisFreeSlots.length = 0;
    if (this.turretHeadInstanced) {
      this.world.remove(this.turretHeadInstanced);
      // Same pattern as smoothChassis — material is a private
      // MeshLambertMaterial owned by the InstancedMesh; dispose via
      // the mesh. Geometry is `turretHeadGeom` (still owned by this
      // class as a per-Mesh head fallback for cap-exhaust units, so
      // don't dispose here).
      (this.turretHeadInstanced.material as THREE.Material).dispose();
      this.turretHeadInstanced.dispose();
      this.turretHeadInstanced = null;
    }
    this.turretHeadFreeSlots.length = 0;
    if (this.barrelInstanced) {
      this.world.remove(this.barrelInstanced);
      // Material is the SHARED `this.barrelMat` — already disposed
      // above by the existing `this.barrelMat.dispose()` call. We
      // disposed it at the unitMeshes-clear point upstream so the
      // InstancedMesh just dispose()s its own internal buffers
      // (instanceMatrix / instanceColor) without touching the
      // shared material. Geometry `barrelGeom` is also a class
      // field disposed below by `this.barrelGeom.dispose()`.
      this.barrelInstanced.dispose();
      this.barrelInstanced = null;
    }
    this.barrelFreeSlots.length = 0;
    if (this.mirrorPanelInstanced) {
      this.world.remove(this.mirrorPanelInstanced);
      // Material is a private MeshStandardMaterial owned by this
      // InstancedMesh — dispose via the mesh. Geometry is
      // `this.mirrorGeom`, disposed earlier in destroy().
      (this.mirrorPanelInstanced.material as THREE.Material).dispose();
      this.mirrorPanelInstanced.dispose();
      this.mirrorPanelInstanced = null;
    }
    this.mirrorPanelFreeSlots.length = 0;
  }
}
