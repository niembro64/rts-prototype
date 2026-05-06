// Render3DEntities — extrudes the 2D sim primitives into 3D shapes.
//
// - Units:        cylinder (radius from unit.radius.body, height ∝ radius)
// - Turrets:      one per entry in entity.turrets, positioned at the
//                 blueprint-authored chassis-local 3D mount, rotated to
//                 the turret's firing angle, with white barrel cylinders.
// - Buildings:    box (width/height from building component, y-depth ∝ scale)
// - Projectiles:  small sphere (radius from projectile collision)
//
// Coordinate mapping: sim (x, y) → three (x, z). Y is up. Ground at y=0.

import * as THREE from 'three';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { isProjectileShot } from '../sim/types';
import type { UnitBodyShape } from '@/types/blueprints';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import type { SprayTarget } from '@/types/ui';
import { getPlayerColors } from '../sim/types';
import { getBuildFraction } from '../sim/buildableHelpers';
import { applyShellOverride } from './ShellMaterial';
import {
  copyInstanceAlphaSlot,
  makeInstanceAlphaCapable,
  setInstanceAlphaSlot,
} from './instanceAlpha';
import {
  SHELL_OPACITY,
  NORMAL_OPACITY,
  BUILD_BUBBLE_RADIUS_PUSH_MULT,
  SHELL_BAR_COLORS,
  BUILD_RATE_EMA_HALF_LIFE_SEC,
  BUILD_RATE_EMA_MODE,
} from '@/shellConfig';
import type { SpinConfig } from '../../config';
import {
  LAND_CELL_SIZE,
  WIND_TURBINE_DRIFT_EMA_HALF_LIFE_MULTIPLIERS,
  WIND_TURBINE_ROTOR_RAD_PER_SEC_PER_WIND_SPEED,
} from '../../config';
import { CONSTRUCTION_TOWER_SPIN_CONFIG } from '@/constructionVisualConfig';
import { getSurfaceNormal } from '../sim/Terrain';
import { FALLBACK_UNIT_BODY_SHAPE } from '../sim/blueprints';
import type { ClientViewState } from '../network/ClientViewState';
import {
  buildLocomotion,
  updateLocomotion,
  destroyLocomotion,
  getChassisLift,
  captureLegState,
  applyLegState,
  type Locomotion3DMesh,
  type LegStateSnapshot,
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
import { getBodyGeom, disposeBodyGeoms } from './BodyShape3D';
import { getUnitBodyShapeKey } from '../math/BodyDimensions';
import {
  buildBuildingShape,
  disposeBuildingGeoms,
  getConstructionHazardMaterial,
  writeSolarPetalMatrix,
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
import { getBuildingConfig } from '../sim/buildConfigs';
import { getUnitBodyCenterHeight, getUnitGroundZ } from '../sim/unitGeometry';
import { getFactoryBuildSpot, getFactoryConstructionRadius, type FactoryBuildSpot } from '../sim/factoryConstructionSite';
import { getDriftMode, getGraphicsConfigFor, getUnitRadiusToggle, getRangeToggle, getProjRangeToggle } from '@/clientBarConfig';
import { getDriftPreset, halfLifeBlend } from '../network/driftEma';
import { getTurretHeadRadius, lerp, lerpAngle } from '../math';
import { getTurretWorldMount } from '../math/MountGeometry';
import { getTurretMountHeight, isCommander } from '../sim/combat/combatUtils';
import { normalizeLodCellSize } from '../lodGridMath';
import { landCellIndexForSize } from '../landGrid';
import { buildTurretMesh3D, type TurretMesh } from './TurretMesh3D';
import { buildMirrorMesh3D, type MirrorMesh } from './MirrorMesh3D';
import { MIRROR_CHROME_MATERIAL } from './BuildingVisualPalette';
import { hexStringToRgb } from './colorUtils';

// Turret head height is the one remaining shared vertical constant —
// chassis heights are now per-unit (see getBodyTopY in BodyDimensions.ts).
// The sim's projectile-spawn point is derived by getBarrelTip
// (src/game/math/BarrelGeometry.ts) pivoted at the world mount returned
// by resolveWeaponWorldMount (sim/combat/combatUtils.ts), so visual
// barrel tip and sim muzzle stay locked together.

const BUILDING_HEIGHT = 120;

type ConstructionTowerSpinRig = Pick<
  FactoryConstructionRig,
  'towerOrbitParts' | 'towerSpinAmount' | 'towerSpinPhase' | 'pylonTopsLocal' | 'pylonTopBaseLocals'
>;

// Per-resource spray colors for the factory + commander build emitters.
// Same palette as SHELL_BAR_COLORS so the colored spray reads as the
// same resource the HP-side bar shows. Pre-baked into 0..1 RGB floats
// once at module load.
const RESOURCE_SPRAY_COLORS = [
  hexStringToRgb(SHELL_BAR_COLORS.energy),
  hexStringToRgb(SHELL_BAR_COLORS.mana),
  hexStringToRgb(SHELL_BAR_COLORS.metal),
] as const;
const SOLAR_PETAL_ANIM_ALPHA = 0.16;
const EXTRACTOR_ROTOR_RAD_PER_SEC = 2.4;
const _solarPetalDirection = new THREE.Vector3();
/** Reciprocal of the extractor's configured ceiling rate, computed
 *  once at module load. The per-frame rotor loop multiplies by this
 *  instead of dividing each entity's `metalExtractionRate` by the
 *  base rate every frame. */
const INV_EXTRACTOR_BASE_PRODUCTION = (() => {
  const base = getBuildingConfig('extractor').metalProduction ?? 0;
  return base > 0 ? 1 / base : 0;
})();
const PROJECTILE_MIN_RADIUS = 1.5;   // floor so very-small shots stay visible
const BARREL_COLOR = 0xffffff;
const MIRROR_PANEL_COLOR = MIRROR_CHROME_MATERIAL.color;
const MIRROR_PANEL_METALNESS = MIRROR_CHROME_MATERIAL.metalness;
const MIRROR_PANEL_ROUGHNESS = MIRROR_CHROME_MATERIAL.roughness;
const MIRROR_PANEL_ENV_INTENSITY = MIRROR_CHROME_MATERIAL.envMapIntensity;
// Detailed unit parts use shared instanced pools by default. The
// per-mesh path remains only as an allocation fallback, not as the
// normal rendering route.
const USE_DETAILED_UNIT_INSTANCING = true;

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
// Safety sweep for rare missed dirty events. Normal movement/selection
// reaches the mass renderer through active/dirty lists; camera-cell,
// LOD, and entity-set changes still force immediate full passes. Keep
// this slow so 10k-unit scenes do not get periodic all-unit spikes.
const UNIT_INSTANCED_FULL_REFRESH_INTERVAL_FRAMES = 120;
const RICH_UNIT_PROMOTION_BUDGET_PER_FRAME = 64;
const MASS_INSTANCE_MATRIX_STRIDE: Record<RenderObjectLodTier, number> = {
  hero: 1,
  rich: 1,
  simple: 1,
  mass: 2,
  impostor: 4,
  marker: 8,
};
const RICH_UNIT_DETAIL_STRIDE: Record<RenderObjectLodTier, number> = {
  hero: 1,
  rich: 1,
  simple: 2,
  mass: 3,
  impostor: 4,
  marker: 8,
};
const UNIT_DETAIL_TRANSFORM_EPSILON = 0.05;
const UNIT_DETAIL_ROTATION_EPSILON = 0.001;
const UNIT_DETAIL_VELOCITY_EPSILON_SQ = 0.25;
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

// Mirror panels (reflective mirror-unit armor plates) are square slabs
// mounted at the rigid mirror-arm's far end. The cache in
// mirrorPanelCache.ts computes baseY/topY/halfWidth from the turret's
// mount.z + radius.body scaled by MIRROR_PANEL_SIZE_MULT; both the
// renderer and the sim's beam-reflection tracer read those cached
// fields so the visible mesh and the collision rectangle stay in sync.

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
  /** Single slot index into the body-shape keyed polygonal-chassis
   *  InstancedMesh pool. Present on polygon / rect units at LOW+ tier;
   *  undefined for smooth bodies (which use smoothChassisSlots) and at
   *  MIN tier. */
  polyChassisSlot?: number;
  /** Cached body-shape key resolved once at mesh-build time. The unit's
   *  bodyShape is the authored source; this key only identifies the
   *  matching instanced geometry pool. */
  bodyShapeKey: string;
  bodyShape?: UnitBodyShape;
  hideChassis?: boolean;
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
   *    - body  → unit.radius.body, the visible body footprint and
   *      ground-click selection fallback radius.
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
  radiusRingsVisible?: boolean;
  /** Builder-unit BLD wireframe sphere — 3D now that the build-range
   *  check includes altitude. Parented to the WORLD group and
   *  positioned at the unit's sim sphere center each frame. */
  buildRing?: THREE.LineSegments;
  rangeRingsVisible?: boolean;
  /** Per-building accent meshes (chimney, solar cells, etc.). Tracked
   *  so rebuilds / destroy() know what to clean up alongside the primary
   *  body. Empty / undefined for units. */
  buildingDetails?: BuildingDetailMesh[];
  factoryRig?: FactoryConstructionRig;
  windRig?: WindTurbineRig;
  extractorRig?: ExtractorRig;
  /** Per-building render height (solar is shorter than the default). */
  buildingHeight?: number;
  /** True when the building primary mesh owns its material and should
   *  not be recolored to team primary on ownership updates. */
  buildingPrimaryMaterialLocked?: boolean;
  solarOpenAmount?: number;
  buildingCachedTier?: RenderObjectLodTier;
  buildingCachedGraphicsTier?: ConcreteGraphicsQuality;
  buildingCachedOwnerId?: PlayerId;
  buildingCachedProgress?: number;
  buildingCachedSelected?: boolean;
  buildingCachedWidth?: number;
  buildingCachedDepth?: number;
  buildingCachedX?: number;
  buildingCachedY?: number;
  buildingCachedZ?: number;
  buildingCachedRotation?: number;
  buildingCachedDetailsReady?: boolean;
  unitDetailCachedX?: number;
  unitDetailCachedY?: number;
  unitDetailCachedZ?: number;
  unitDetailCachedRotation?: number;
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
  private solarBuildingIds: EntityId[] = [];
  private solarBuildingIdSet = new Set<EntityId>();
  private windBuildingIds: EntityId[] = [];
  private windBuildingIdSet = new Set<EntityId>();
  private extractorBuildingIds: EntityId[] = [];
  private extractorBuildingIdSet = new Set<EntityId>();
  private factoryBuildingIds: EntityId[] = [];
  private factoryBuildingIdSet = new Set<EntityId>();
  private factorySprayTargets: SprayTarget[] = [];
  private factorySprayTargetPool: SprayTarget[] = [];
  private windFanYaw: number | null = null;
  private windVisualSpeed: number | null = null;
  private windRotorPhase = 0;
  private windAnimLastMs = 0;
  /** Per-entity rotor phase. Each extractor advances its own counter
   *  by `dt × EXTRACTOR_ROTOR_RAD_PER_SEC × coverageFraction`, so an
   *  extractor sitting on bare ground (0 covered tiles) stays
   *  stationary while one fully covering a deposit spins at full
   *  speed. Indexed by entity id; entries get pruned when the
   *  extractor despawns. */
  private extractorRotorPhases = new Map<EntityId, number>();
  // Reusable "seen this frame" sets — the four per-frame update loops
  // (barrel-spin, unit, building, projectile) each need to track which
  // entity ids were visited so stale Map entries get pruned. Keeping
  // them as instance fields and calling `.clear()` at the top of each
  // loop avoids allocating a fresh Set on every render frame — four
  // Set allocations × 60 Hz = ~240 GC objects/sec otherwise.
  private _seenUnitIds = new Set<EntityId>();
  private _seenBuildingIds = new Set<number>();
  private _seenProjectileIds = new Set<number>();
  private _projectileRenderScratch: Entity[] = [];
  private lastUnitInstancedEntitySetVersion = -1;
  private lastBuildingEntitySetVersion = -1;
  private lastProjectileEntitySetVersion = -1;
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

  // Per-entity leg-state snapshots stashed right before an LOD-driven
  // mesh teardown and consumed immediately after rebuild, so feet keep
  // their world-space planted positions instead of snapping to rest.
  private legStateCache = new Map<EntityId, LegStateSnapshot>();

  // LOD state — read once per frame in update(), then every builder/drawer
  // consults these values instead of calling getGraphicsConfig() ad-hoc.
  // When `lod.key` changes, any pre-built unit mesh is rebuilt.
  private lod: Lod3DState = snapshotLod();

  // Shared geometries & per-team materials (avoid per-entity allocation).
  // Unit chassis geometries are body-shape keyed and handled by BodyShape3D.
  // Sphere (not cylinder) so the barrels can pivot freely in any
  // direction — the head reads as a turret ball the barrels swing
  // around, letting pitch aim up toward AA targets without the
  // barrels clipping through a flat cylinder top.
  private turretHeadGeom = new THREE.SphereGeometry(1, 16, 12);
  /** Instanced-only clone. `makeInstanceAlphaCapable()` adds an
   *  InstancedBufferAttribute to the geometry; keep that mutation away
   *  from regular per-Mesh fallback turret heads for cross-driver
   *  stability. */
  private turretHeadInstancedGeom = this.turretHeadGeom.clone();
  private commanderBoxGeom = new THREE.BoxGeometry(1, 1, 1);
  private commanderCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 18);
  private commanderDomeGeom = new THREE.SphereGeometry(1, 14, 10);
  // Plain sphere used at MIN / LOW LOD as the entire unit body — mirrors
  // the 2D "circles" representation. Coarser tessellation than the
  // turret-head sphere because at low tiers we trade detail for draw
  // speed and the unit count is what hurts.
  private unitSphereLowGeom = new THREE.SphereGeometry(1, 10, 8);
  /** Unit box used as the BUILDING marker mesh at the lowest LOD tier.
   *  Scaled per-frame to the building's logical sim cuboid
   *  (width × depth × height) so the building still reads as a building
   *  on the ground at marker tier — same volume the host sim uses for
   *  its static collider, same volume the high-LOD primary occupies. */
  private buildingMarkerBoxGeom = new THREE.BoxGeometry(1, 1, 1);
  private barrelGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  private barrelInstancedGeom = this.barrelGeom.clone();
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
  /** Instanced barrels need a patched material. Regular fallback
   *  barrels keep using `barrelMat` so the instance-alpha shader patch
   *  stays private to the instanced pool. */
  private barrelInstancedMat = this.barrelMat.clone();
  // Mirror panel = flat unit square plane. Default orientation: face
  // in XY plane with normal +Z; we rotate it into the panel-local frame
  // (edge → +Z, normal → +X) per panel below. Plane has zero physical
  // thickness so the visible mesh and the sim collision rectangle live
  // on EXACTLY the same surface — no front/back offset where a beam
  // could appear to clip the visible mirror but miss the sim plane.
  private mirrorGeom = new THREE.PlaneGeometry(1, 1);
  /** Instanced-only clone for the same reason as turret heads/barrels:
   *  the instance-alpha attribute is renderer-private state. */
  private mirrorInstancedGeom = this.mirrorGeom.clone();
  private mirrorArmGeom = new THREE.BoxGeometry(1, 1, 1);
  private mirrorSupportGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
  // Selection-indicator halo. A low torus reads as a real 3D donut
  // around the unit instead of a flat 2D strip or billboarded band.
  // Geometry is unit-sized: major radius 1, tube radius 0.06. The
  // mesh is rotated into the XZ ground plane on creation and scaled
  // per unit below.
  private ringGeom = new THREE.TorusGeometry(1.0, 0.06, 8, 36);
  // Unit-radius indicator wireframe spheres (BODY/SHOT/PUSH). Unit
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
  // Min-fire dead-zone rings (mortars + similar). Orange = "I can
  // start firing once I'm at least this far out from the target";
  // purple = the closer hysteresis line ("stop firing inside this").
  private ringMatEngageMinAcquire = new THREE.LineBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.30, depthWrite: false });
  private ringMatEngageMinRelease = new THREE.LineBasicMaterial({ color: 0xaa44ff, transparent: true, opacity: 0.25, depthWrite: false });
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
  // Chrome variant of the extractor-blade shiny gray base color.
  private mirrorShinyNeutralMat = new THREE.MeshStandardMaterial({
    color: MIRROR_PANEL_COLOR,
    metalness: MIRROR_PANEL_METALNESS,
    roughness: MIRROR_PANEL_ROUGHNESS,
    envMapIntensity: MIRROR_PANEL_ENV_INTENSITY,
    side: THREE.DoubleSide,
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
  private unitInstancedColorKey = new Map<EntityId, number>();
  // In hybrid mode this is the set of units whose mass-body slot should
  // be hidden because a richer object mesh is responsible for drawing
  // the body. The outer marker tier still uses this packed sphere path.
  private massRichUnitIds = new Set<EntityId>();
  private massRichUnits: Entity[] = [];
  private massRichUnitIndex = new Map<EntityId, number>();
  private massRichObjectTiers = new Map<EntityId, RenderObjectLodTier>();
  private ownedObjectLodGrid = new RenderLodGrid();
  private objectLodGrid = this.ownedObjectLodGrid;
  /** Reuse pool of vacated slots so a long game doesn't burn through cap. */
  private unitInstancedFreeSlots: number[] = [];
  /** High-water mark; everything ≥ this is unused. */
  private unitInstancedNextSlot = 0;
  private unitInstancedCompactFrame = 0;
  private unitInstancedFrame = 0;
  private unitInstancedLastFullPassFrame = -1;
  private unitInstancedLastFullPassEntitySetVersion = -1;
  private unitInstancedLastFullPassLodKey = '';
  private unitInstancedLastFullPassCellSize = 0;
  private unitInstancedLastFullPassCameraCellX = 0;
  private unitInstancedLastFullPassCameraCellY = 0;
  private unitInstancedActiveUnits: Entity[] = [];
  private unitInstancedHiddenIds = new Set<EntityId>();
  private richUnitDetailFrame = 0;
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
   *  is immutable scratch so the inner loop allocates nothing. */
  private _barrelParentMat = new THREE.Matrix4();
  private _barrelStepMat = new THREE.Matrix4();
  private _barrelOneVec = new THREE.Vector3(1, 1, 1);

  /** Per-unit cached prefix matrix `T(liftedPos) · R(parentQuat) · S(1)`
   *  — i.e. the scenegraph chain `group · yawGroup · liftGroup` evaluated
   *  once at the top of the per-unit body. Reused as the BARREL parent-
   *  chain seed so the per-turret loop's first three composes /
   *  multiplies (which used to rebuild this chain from m.group every
   *  turret) collapse to a single `Matrix4.copy()`. */
  private _unitChainMat = new THREE.Matrix4();

  // ── LOW+ tier polygonal/rect chassis InstancedMeshes ──────────────
  // One InstancedMesh per polygon / rect body shape. Lazily created
  // the first time a unit with that bodyShape enters the scene because
  // the geometry isn't built until BodyShape3D's `getBodyGeom(shape)`
  // is called. Each pool's mesh references the SAME geometry object
  // that BodyShape3D's CACHE owns — disposed by BodyShape3D's
  // `disposeBodyGeoms()` in destroy(), not by us, so we tear down
  // `polyChassis` pool meshes BEFORE that call.
  //
  // Polygonal bodies always have parts.length === 1 (single
  // Extruded polygonal bodies are single-part today, so each unit takes
  // exactly one slot in its body-shape pool. Composite-or-multi-part
  // polygonal bodies would need a slot list like smoothChassisSlots.
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
  // Hidden heads (turretStyle=none / force-field)
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
  // Loris-only feature, but each Loris carries 4 panels and chrome
  // PBR each — so a 100-Loris scene is 400 separate MeshStandardMaterial
  // draws today. Routing them through ONE shared InstancedMesh with
  // one shared per-instance color collapses that to 1 draw call.
  // metalness + roughness are material-level uniforms so they
  // stay shared across panels; mirror arms still carry team color.
  // The PMREM environment map for metal reflection is set on the
  // scene, not the material, so it applies to all instances.
  private static readonly MIRROR_PANEL_CAP = 1024;
  private mirrorPanelInstanced: THREE.InstancedMesh | null = null;
  private mirrorPanelColorKey = new Map<number, number>();
  private mirrorPanelColorDirty = false;
  private mirrorPanelFreeSlots: number[] = [];
  private mirrorPanelNextSlot = 0;
  private mirrorsEnabled = true;

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
    // getPrimaryMat / getSecondaryMat). The
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
    // Per-instance alpha: shell entities get SHELL_OPACITY in their
    // slot; everything else stays at NORMAL_OPACITY. Patches the
    // shader to multiply gl_FragColor.a by the slot's instanceAlpha.
    makeInstanceAlphaCapable(this.unitInstanced, Render3DEntities.LOW_INSTANCED_CAP);
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
    makeInstanceAlphaCapable(this.smoothChassis, Render3DEntities.SMOOTH_CHASSIS_CAP);
    this.world.add(this.smoothChassis);

    // Turret-head InstancedMesh — uses an instanced-only clone of the
    // 16×12 unit sphere. Per-instance team color via instanceColor
    // modulates against the white shared MeshLambertMaterial — same
    // pattern smoothChassis uses, so team-changes are picked up by
    // the per-frame setColorAt without touching any material.
    const headMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.turretHeadInstanced = new THREE.InstancedMesh(
      this.turretHeadInstancedGeom,
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
    makeInstanceAlphaCapable(this.turretHeadInstanced, Render3DEntities.TURRET_HEAD_CAP);
    this.world.add(this.turretHeadInstanced);

    // Barrel InstancedMesh — uses instanced-only geometry/material
    // (10-segment cylinder, radius 1, height 1; the per-instance
    // scale shapes it to (cylRadius, length, cylRadius)). Barrels stay
    // white across teams, matching the existing visual contract.
    this.barrelInstanced = new THREE.InstancedMesh(
      this.barrelInstancedGeom,
      this.barrelInstancedMat,
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
    makeInstanceAlphaCapable(this.barrelInstanced, Render3DEntities.BARREL_CAP);
    this.world.add(this.barrelInstanced);

    // Mirror-panel InstancedMesh — one shared chrome material,
    // double-sided so the panel reads from either side, with a fixed
    // owner-agnostic panel color.
    const mirrorMat = new THREE.MeshStandardMaterial({
      color: MIRROR_PANEL_COLOR,
      metalness: MIRROR_PANEL_METALNESS,
      roughness: MIRROR_PANEL_ROUGHNESS,
      envMapIntensity: MIRROR_PANEL_ENV_INTENSITY,
      side: THREE.DoubleSide,
    });
    this.mirrorPanelInstanced = new THREE.InstancedMesh(
      this.mirrorInstancedGeom,
      mirrorMat,
      Render3DEntities.MIRROR_PANEL_CAP,
    );
    this.mirrorPanelInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mirrorPanelInstanced.setColorAt(0, this._instColor.set(MIRROR_PANEL_COLOR));
    this.mirrorPanelInstanced.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mirrorPanelInstanced.frustumCulled = false;
    for (let i = 0; i < Render3DEntities.MIRROR_PANEL_CAP; i++) {
      this.mirrorPanelInstanced.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
    }
    this.mirrorPanelInstanced.count = 0;
    this.mirrorPanelInstanced.instanceMatrix.needsUpdate = true;
    makeInstanceAlphaCapable(this.mirrorPanelInstanced, Render3DEntities.MIRROR_PANEL_CAP);
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

  private getMirrorShinyMat(): THREE.MeshStandardMaterial {
    return this.mirrorShinyNeutralMat;
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
    isDgunTurret: boolean,
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
      const sleeve = new THREE.Mesh(this.commanderBoxGeom, isDgunTurret ? this.commanderArmorMat : this.commanderTrimMat);
      sleeve.position.set(headRadius * (isDgunTurret ? 0.72 : 0.55), 0, 0);
      sleeve.scale.set(
        headRadius * (isDgunTurret ? 1.05 : 0.72),
        headRadius * (isDgunTurret ? 0.34 : 0.22),
        headRadius * (isDgunTurret ? 0.34 : 0.22),
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
   * Show/hide the per-unit BODY / SHOT / PUSH radius rings, matching the 2D
   * renderUnitRadiusCircles toggles. Rings are lazily created on first show
   * and simply hidden (not destroyed) when toggled off, so flipping toggles
   * repeatedly doesn't churn geometry.
   *
   * Wireframe SPHERE centered at the authored unit body center above
   * the group's ground origin. Scale is the radius value for the
   * selected channel. SHOT/PUSH are sim volumes; BODY is the visible
   * chassis/body authoring radius.
   */
  private updateRadiusRings(m: EntityMesh, entity: Entity): void {
    const showScale = getUnitRadiusToggle('visual');
    const showShot = getUnitRadiusToggle('shot');
    const showPush = getUnitRadiusToggle('push');
    if (!showScale && !showShot && !showPush) {
      if (m.radiusRingsVisible && m.radiusRings) {
        if (m.radiusRings.scale) m.radiusRings.scale.visible = false;
        if (m.radiusRings.shot) m.radiusRings.shot.visible = false;
        if (m.radiusRings.push) m.radiusRings.push.visible = false;
      }
      m.radiusRingsVisible = false;
      return;
    }

    const collider = entity.unit?.radius;
    if (!entity.unit || !collider) return;

    const rings = m.radiusRings ?? (m.radiusRings = {});

    // All three UNIT RAD spheres sit at the authored unit center.
    // Because the unit group is positioned at (x, groundZ, y) in
    // three-space and the center height is authored per blueprint,
    // a local-Y of `bodyCenterHeight` keeps debug spheres aligned with
    // the visible/sim center. The sphere follows altitude changes for free.
    const centerY = getUnitBodyCenterHeight(entity.unit);

    this.setUnitRadiusSphere(
      rings, 'scale', showScale, m.group,
      centerY, entity.unit.radius.body, this.radiusMatScale,
    );
    this.setUnitRadiusSphere(
      rings, 'shot', showShot, m.group,
      centerY, collider.shot, this.radiusMatShot,
    );
    this.setUnitRadiusSphere(
      rings, 'push', showPush, m.group,
      centerY, collider.push, this.radiusMatPush,
    );
    m.radiusRingsVisible = true;
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
    const showEngageMinAcquire = getRangeToggle('engageMinAcquire');
    const showEngageMinRelease = getRangeToggle('engageMinRelease');
    const showBuild = getRangeToggle('build');
    const showAnyTurretRange =
      showTrackAcquire || showTrackRelease
      || showEngageAcquire || showEngageRelease
      || showEngageMinAcquire || showEngageMinRelease;
    if (!showAnyTurretRange && !showBuild) {
      if (m.rangeRingsVisible) this.hideRangeRings(m);
      m.rangeRingsVisible = false;
      return;
    }

    const ux = entity.transform.x;
    const uy = entity.transform.y;
    const uz = entity.transform.z;

    // Per-turret spheres — same center the sim's targeting code uses,
    // so what you see is exactly the volume the sim tests against.
    if (showAnyTurretRange && entity.turrets) {
      const cos = Math.cos(entity.transform.rotation);
      const sin = Math.sin(entity.transform.rotation);
      for (let i = 0; i < entity.turrets.length; i++) {
        const weapon = entity.turrets[i];
        if (weapon.config.visualOnly) continue;
        const tm = m.turrets[i];
        if (!tm) continue;
        const cachedMount = weapon.worldPos;
        const fallbackMount = cachedMount
          ? undefined
          : getTurretWorldMount(
              ux, uy, getUnitGroundZ(entity),
              cos, sin,
              weapon.mount.x, weapon.mount.y, getTurretMountHeight(entity, i),
              // Pull from the unit's smoothed normal (set by sim's
              // updateUnitTilt and shipped in the snapshot) instead of
              // re-querying raw terrain — keeps this fallback in sync
              // with the chassis tilt above.
              entity.unit?.surfaceNormal ?? getSurfaceNormal(
                ux, uy,
                this.clientViewState.getMapWidth(),
                this.clientViewState.getMapHeight(),
                LAND_CELL_SIZE,
              ),
            );
        const mountX = cachedMount?.x ?? fallbackMount!.x;
        const mountY = cachedMount?.y ?? fallbackMount!.y;
        // Use the same full 3D mount cache that the sim targeting path
        // writes. This keeps debug range spheres centered on rearranged
        // rear/side turrets instead of mixing old flat XY math with a
        // newer mount Z.
        const mountZ = cachedMount?.z ?? fallbackMount!.z;

        // Tracking shell only renders when this turret actually has
        // one — most weapons don't (engage = acquire on contact).
        this.setRangeSphere(
          tm, 'trackAcquire', showTrackAcquire, mountX, mountY, mountZ,
          weapon.ranges.tracking?.acquire ?? null, this.ringMatTrackAcquire,
        );
        this.setRangeSphere(
          tm, 'trackRelease', showTrackRelease, mountX, mountY, mountZ,
          weapon.ranges.tracking?.release ?? null, this.ringMatTrackRelease,
        );
        this.setRangeSphere(
          tm, 'engageAcquire', showEngageAcquire, mountX, mountY, mountZ,
          weapon.ranges.fire.max.acquire, this.ringMatEngageAcquire,
        );
        this.setRangeSphere(
          tm, 'engageRelease', showEngageRelease, mountX, mountY, mountZ,
          weapon.ranges.fire.max.release, this.ringMatEngageRelease,
        );
        // Min-fire dead-zone rings — only emitted for turrets with a
        // configured fire.min (mortars, gatling-mortar, etc.). Null
        // hides the ring without erroring, so direct-fire weapons
        // simply skip these channels.
        this.setRangeSphere(
          tm, 'engageMinAcquire', showEngageMinAcquire, mountX, mountY, mountZ,
          weapon.ranges.fire.min?.acquire ?? null, this.ringMatEngageMinAcquire,
        );
        this.setRangeSphere(
          tm, 'engageMinRelease', showEngageMinRelease, mountX, mountY, mountZ,
          weapon.ranges.fire.min?.release ?? null, this.ringMatEngageMinRelease,
        );
      }
    } else if (m.rangeRingsVisible) {
      this.hideTurretRangeRings(m);
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
    m.rangeRingsVisible = showAnyTurretRange || (showBuild && builder !== undefined);
  }

  private hideRangeRings(m: EntityMesh): void {
    this.hideTurretRangeRings(m);
    if (m.buildRing) m.buildRing.visible = false;
  }

  private hideTurretRangeRings(m: EntityMesh): void {
    for (const tm of m.turrets) {
      const rings = tm.rangeRings;
      if (!rings) continue;
      if (rings.trackAcquire)     rings.trackAcquire.visible = false;
      if (rings.trackRelease)     rings.trackRelease.visible = false;
      if (rings.engageAcquire)    rings.engageAcquire.visible = false;
      if (rings.engageRelease)    rings.engageRelease.visible = false;
      if (rings.engageMinAcquire) rings.engageMinAcquire.visible = false;
      if (rings.engageMinRelease) rings.engageMinRelease.visible = false;
    }
  }

  /** Internal helper: create-if-missing / update-if-visible / hide for
   *  a single per-turret TURR RAD sphere. Keeps the four toggle
   *  branches in updateRangeRings from duplicating the lazy-create
   *  dance. */
  private setRangeSphere(
    tm: TurretMesh,
    key:
      | 'trackAcquire'
      | 'trackRelease'
      | 'engageAcquire'
      | 'engageRelease'
      | 'engageMinAcquire'
      | 'engageMinRelease',
    want: boolean,
    cx: number, cy: number, cz: number,
    /** Radius in world units, or `null` when this turret has no shell
     *  for this channel (e.g. tracking radius on a turret without a
     *  tracking range). Null hides any existing ring without erroring. */
    radius: number | null,
    mat: THREE.LineBasicMaterial,
  ): void {
    const rings = tm.rangeRings ?? (tm.rangeRings = {});
    let ring = rings[key];
    if (want && radius !== null) {
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

  update(
    lodOverride?: Lod3DState,
    sharedLodGrid?: RenderLodGrid,
    featureFlags?: { mirrorsEnabled?: boolean },
  ): void {
    // Refresh LOD snapshot once per frame. Unit meshes compare their
    // own effective object-tier key inside updateUnitMeshes(), so global
    // LOD changes no longer tear down every unit at once. That avoids a
    // large hitch when the user changes PLAYER CLIENT LOD or the camera
    // sphere config while thousands of units are alive.
    const newLod = lodOverride ?? snapshotLod(this.camera, this.getViewportHeight());
    this.lod = newLod;
    this.objectLodGrid = sharedLodGrid ?? this.ownedObjectLodGrid;
    if (!sharedLodGrid) this.objectLodGrid.beginFrame(this.lod.view, this.lod.gfx);
    this.mirrorsEnabled = featureFlags?.mirrorsEnabled ?? true;

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
      copyInstanceAlphaSlot(im, tailSlot, freeSlot);
      setInstanceAlphaSlot(im, tailSlot, NORMAL_OPACITY);
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
    for (const [id, m] of this.unitMeshes) {
      // Stash leg state across the rebuild so feet keep their world
      // positions / gait phase / lerp progress instead of snapping to
      // rest. captureLegState returns undefined for non-legged units,
      // so the cache only grows for spider/tick/etc. — cheap.
      const legSnap = captureLegState(m.locomotion);
      if (legSnap) this.legStateCache.set(id, legSnap);
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
    setInstanceAlphaSlot(im, slot, NORMAL_OPACITY);
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

  private shouldUpdateRichUnitDetails(
    entity: Entity,
    mesh: EntityMesh,
    tier: RenderObjectLodTier,
    meshWasBuilt: boolean,
  ): boolean {
    if (meshWasBuilt) return true;
    if (isRichObjectLod(tier)) return true;
    if (entity.selectable?.selected === true || mesh.ring !== undefined) return true;
    if (mesh.radiusRingsVisible || mesh.rangeRingsVisible || mesh.buildRing !== undefined) return true;
    const unit = entity.unit;
    if (unit) {
      const vx = unit.velocityX ?? 0;
      const vy = unit.velocityY ?? 0;
      const vz = unit.velocityZ ?? 0;
      if (vx * vx + vy * vy + vz * vz > UNIT_DETAIL_VELOCITY_EPSILON_SQ) return true;
    }
    const turrets = entity.turrets;
    if (turrets?.some((t) => !t.config.visualOnly && (t.state === 'tracking' || t.state === 'engaged' || t.target !== null))) {
      return true;
    }
    const cachedX = mesh.unitDetailCachedX;
    if (
      cachedX === undefined ||
      Math.abs(entity.transform.x - cachedX) > UNIT_DETAIL_TRANSFORM_EPSILON ||
      Math.abs(entity.transform.y - (mesh.unitDetailCachedY ?? entity.transform.y)) > UNIT_DETAIL_TRANSFORM_EPSILON ||
      Math.abs(entity.transform.z - (mesh.unitDetailCachedZ ?? entity.transform.z)) > UNIT_DETAIL_TRANSFORM_EPSILON ||
      Math.abs(entity.transform.rotation - (mesh.unitDetailCachedRotation ?? entity.transform.rotation)) >
        UNIT_DETAIL_ROTATION_EPSILON
    ) {
      return true;
    }
    const stride = RICH_UNIT_DETAIL_STRIDE[tier] ?? 1;
    return stride <= 1 || ((this.richUnitDetailFrame + entity.id) % stride) === 0;
  }

  private markRichUnitDetailsUpdated(entity: Entity, mesh: EntityMesh): void {
    mesh.unitDetailCachedX = entity.transform.x;
    mesh.unitDetailCachedY = entity.transform.y;
    mesh.unitDetailCachedZ = entity.transform.z;
    mesh.unitDetailCachedRotation = entity.transform.rotation;
  }

  private shouldRunUnitInstancedFullPass(
    entitySetVersion: number,
    collectRichUnits: boolean,
  ): boolean {
    const size = normalizeLodCellSize(this.lod.gfx.objectLodCellSize);
    const view = this.lod.view;
    const cameraCellX = landCellIndexForSize(view.cameraX, size);
    const cameraCellY = landCellIndexForSize(view.cameraZ, size);
    if (
      entitySetVersion !== this.unitInstancedLastFullPassEntitySetVersion ||
      this.lod.key !== this.unitInstancedLastFullPassLodKey ||
      size !== this.unitInstancedLastFullPassCellSize ||
      cameraCellX !== this.unitInstancedLastFullPassCameraCellX ||
      cameraCellY !== this.unitInstancedLastFullPassCameraCellY
    ) {
      this.unitInstancedLastFullPassEntitySetVersion = entitySetVersion;
      this.unitInstancedLastFullPassLodKey = this.lod.key;
      this.unitInstancedLastFullPassCellSize = size;
      this.unitInstancedLastFullPassCameraCellX = cameraCellX;
      this.unitInstancedLastFullPassCameraCellY = cameraCellY;
      return true;
    }
    if (!collectRichUnits) return false;
    return (
      this.unitInstancedLastFullPassFrame < 0 ||
      this.unitInstancedFrame - this.unitInstancedLastFullPassFrame >=
        UNIT_INSTANCED_FULL_REFRESH_INTERVAL_FRAMES
    );
  }

  private removeMassRichUnit(id: EntityId): void {
    if (!this.massRichUnitIds.delete(id)) return;
    this.massRichObjectTiers.delete(id);
    const idx = this.massRichUnitIndex.get(id);
    this.massRichUnitIndex.delete(id);
    if (idx === undefined) return;
    const lastIdx = this.massRichUnits.length - 1;
    const last = this.massRichUnits[lastIdx];
    if (idx !== lastIdx && last) {
      this.massRichUnits[idx] = last;
      this.massRichUnitIndex.set(last.id, idx);
    }
    this.massRichUnits.pop();
  }

  private clearMassRichUnits(): void {
    this.massRichUnitIds.clear();
    this.massRichUnits.length = 0;
    this.massRichUnitIndex.clear();
    this.massRichObjectTiers.clear();
  }

  private addMassRichUnit(entity: Entity, objectTier: RenderObjectLodTier): void {
    if (!this.massRichUnitIds.has(entity.id)) {
      this.massRichUnitIds.add(entity.id);
      this.massRichUnitIndex.set(entity.id, this.massRichUnits.length);
      this.massRichUnits.push(entity);
    }
    this.massRichObjectTiers.set(entity.id, objectTier);
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
    units?: readonly Entity[],
    collectRichUnits = false,
  ): readonly Entity[] {
    const im = this.unitInstanced;
    if (!im) return this.massRichUnits;

    this.unitInstancedFrame = (this.unitInstancedFrame + 1) & 0x3fffffff;
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const fullPass = this.shouldRunUnitInstancedFullPass(entitySetVersion, collectRichUnits);
    const unitsToProcess = fullPass
      ? (units ?? this.clientViewState.getUnits())
      : this.clientViewState.collectActiveUnitRenderEntities(this.unitInstancedActiveUnits);
    if (fullPass) this.unitInstancedLastFullPassFrame = this.unitInstancedFrame;

    const seen = this._seenUnitIds;
    seen.clear();
    const richIds = this.massRichUnitIds;
    if (collectRichUnits && fullPass) {
      this.clearMassRichUnits();
    }
    let colorDirty = false;
    let matrixMinSlot = Number.POSITIVE_INFINITY;
    let matrixMaxSlot = -1;
    let colorMinSlot = Number.POSITIVE_INFINITY;
    let colorMaxSlot = -1;
    const matrixDirty = { matrixMinSlot, matrixMaxSlot };
    let richPromotionsThisFrame = 0;

    for (const e of unitsToProcess) {
      seen.add(e.id);
      const objectTier = this.resolveEntityObjectLod(e);
      const inScope = this.scope.inScope(e.transform.x, e.transform.y, 100);
      if (collectRichUnits) {
        // Rich scenegraph units stay render-scope gated because they
        // drive terrain tilt, locomotion, turret/mirror matrices, and
        // selection overlays. Units outside that older 2D footprint
        // still flow through the cheap instanced body below, so the
        // 2D LOD grid never resolves to "invisible" for unit bodies.
        if (inScope && (isRichObjectLod(objectTier) || objectTier === 'simple')) {
          const alreadyRich = richIds.has(e.id);
          const hasSceneMesh = this.unitMeshes.has(e.id);
          const canPromote =
            alreadyRich ||
            hasSceneMesh ||
            richPromotionsThisFrame < RICH_UNIT_PROMOTION_BUDGET_PER_FRAME;
          if (canPromote) {
            if (!alreadyRich && !hasSceneMesh) richPromotionsThisFrame++;
            this.addMassRichUnit(e, objectTier);
            this.hideUnitInstancedSlot(im, e.id, this.unitInstancedSlot.get(e.id), matrixDirty);
            continue;
          }
        }
        this.removeMassRichUnit(e.id);
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
      setInstanceAlphaSlot(
        im,
        slot,
        e.buildable && !e.buildable.isComplete && !e.buildable.isGhost
          ? SHELL_OPACITY
          : NORMAL_OPACITY,
      );

      const radius = e.unit?.radius.body
        ?? e.unit?.radius.shot
        ?? 15;
      if (this.shouldUpdateUnitInstancedMatrix(e, objectTier, slotWasNew, wasHidden)) {
        // Low-detail imposter sphere is centered on the same authored
        // unit body center as simulation targeting and the rich body
        // renderer. Do not infer this from radius; tall/low rigs can
        // have body centers that intentionally differ from body radius.
        this._instPos.set(
          e.transform.x,
          e.transform.z,
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
      const colorKey = pid ?? -1;
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

    // Free slots for units that disappeared. This is an O(active units)
    // map walk, so run it only when the client entity set actually
    // changed rather than on every render frame.
    if (entitySetVersion !== this.lastUnitInstancedEntitySetVersion) {
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
      this.lastUnitInstancedEntitySetVersion = entitySetVersion;
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
    return this.massRichUnits;
  }

  /** Tier flipped from LOW to MED+: hide every active instanced slot
   *  and drop the slot map so the next LOW pass starts fresh (and
   *  colors get re-applied to whatever pid currently owns each slot). */
  private releaseAllInstancedSlots(): void {
    const im = this.unitInstanced;
    if (!im) return;
    for (const slot of this.unitInstancedSlot.values()) {
      im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
      setInstanceAlphaSlot(im, slot, NORMAL_OPACITY);
    }
    this.unitInstancedSlot.clear();
    this.unitInstancedEntityBySlot.length = 0;
    this.unitInstancedColorKey.clear();
    this.unitInstancedHiddenIds.clear();
    this.clearMassRichUnits();
    this.unitInstancedFreeSlots.length = 0;
    this.unitInstancedNextSlot = 0;
    this.unitInstancedCompactFrame = 0;
    this.unitInstancedFrame = 0;
    this.unitInstancedLastFullPassFrame = -1;
    this.unitInstancedLastFullPassEntitySetVersion = -1;
    this.unitInstancedLastFullPassLodKey = '';
    this.unitInstancedLastFullPassCellSize = 0;
    this.unitInstancedLastFullPassCameraCellX = 0;
    this.unitInstancedLastFullPassCameraCellY = 0;
    this.unitInstancedActiveUnits.length = 0;
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
      setInstanceAlphaSlot(im, slot, NORMAL_OPACITY);
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
      for (const slot of slots) {
        im.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
        setInstanceAlphaSlot(im, slot, NORMAL_OPACITY);
      }
    }
    this.smoothChassisSlots.clear();
    this.smoothChassisColorKey.clear();
    this.smoothChassisFreeSlots.length = 0;
    this.smoothChassisNextSlot = 0;
    im.count = 0;
    im.instanceMatrix.needsUpdate = true;
  }

  /** Look up or lazily create the InstancedMesh pool for a polygonal /
   *  rect body shape. The source geometry comes from BodyShape3D's
   *  cache, but the instanced pool owns a clone because
   *  makeInstanceAlphaCapable() attaches instanced-only attributes.
   *  Regular fallback meshes must never share that mutated geometry.
   *  Material stays Lambert like the rest of the main unit/building
   *  surfaces so units keep the intended scene lighting. */
  private getOrCreatePolyPool(
    bodyShapeKey: string,
    geom: THREE.BufferGeometry,
  ): {
    mesh: THREE.InstancedMesh;
    slots: Map<EntityId, number>;
    colorKeys: Map<EntityId, number>;
    colorDirty: boolean;
    freeSlots: number[];
    nextSlot: number;
  } {
    let pool = this.polyChassis.get(bodyShapeKey);
    if (pool) return pool;
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const instancedGeom = geom.clone();
    const mesh = new THREE.InstancedMesh(
      instancedGeom,
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
    makeInstanceAlphaCapable(mesh, Render3DEntities.POLY_CHASSIS_CAP);
    this.world.add(mesh);
    pool = {
      mesh,
      slots: new Map(),
      colorKeys: new Map(),
      colorDirty: false,
      freeSlots: [],
      nextSlot: 0,
    };
    this.polyChassis.set(bodyShapeKey, pool);
    return pool;
  }

  /** Reserve one slot for entity `eid` in the body-shape poly pool.
   *  Returns the slot index, or null when the cap is exhausted (caller
   *  falls back to per-Mesh chassis). */
  private allocPolyChassisSlot(
    eid: EntityId,
    bodyShapeKey: string,
    geom: THREE.BufferGeometry,
  ): number | null {
    const pool = this.getOrCreatePolyPool(bodyShapeKey, geom);
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

  /** Release entity `eid`'s slot in the body-shape pool back
   *  to the free list. Called from the per-frame seen-pruning loop on
   *  unit despawn. */
  private freePolyChassisSlotForEntity(
    bodyShapeKey: string,
    eid: EntityId,
  ): void {
    const pool = this.polyChassis.get(bodyShapeKey);
    if (!pool) return;
    const slot = pool.slots.get(eid);
    if (slot === undefined) return;
    pool.mesh.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
    setInstanceAlphaSlot(pool.mesh, slot, NORMAL_OPACITY);
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
    setInstanceAlphaSlot(im, slot, NORMAL_OPACITY);
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
      setInstanceAlphaSlot(im, i, NORMAL_OPACITY);
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
    setInstanceAlphaSlot(im, slot, NORMAL_OPACITY);
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
      setInstanceAlphaSlot(im, i, NORMAL_OPACITY);
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
    setInstanceAlphaSlot(im, slot, NORMAL_OPACITY);
    this.mirrorPanelFreeSlots.push(slot);
    this.mirrorPanelColorKey.delete(slot);
    im.instanceMatrix.needsUpdate = true;
  }

  private releaseAllMirrorPanelSlots(): void {
    const im = this.mirrorPanelInstanced;
    if (!im) return;
    for (let i = 0; i < this.mirrorPanelNextSlot; i++) {
      im.setMatrixAt(i, Render3DEntities._ZERO_MATRIX);
      setInstanceAlphaSlot(im, i, NORMAL_OPACITY);
    }
    this.mirrorPanelFreeSlots.length = 0;
    this.mirrorPanelColorKey.clear();
    this.mirrorPanelColorDirty = false;
    this.mirrorPanelNextSlot = 0;
    im.count = 0;
    im.instanceMatrix.needsUpdate = true;
  }

  /** Wipe every active polygonal-chassis slot across every body-shape
   *  pool (LOD flip). The pool meshes stay in the scene with count = 0
   *  (no GPU draw work) until the next allocation refills them. */
  private releaseAllPolyChassisSlots(): void {
    for (const pool of this.polyChassis.values()) {
      for (const slot of pool.slots.values()) {
        pool.mesh.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
        setInstanceAlphaSlot(pool.mesh, slot, NORMAL_OPACITY);
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
   *  spheres (BODY/SHOT/PUSH) ride the unit group and leave alongside
   *  m.group. */
  private disposeWorldParentedOverlays(m: EntityMesh): void {
    if (m.buildRing) this.world.remove(m.buildRing);
    for (const tm of m.turrets) {
      if (tm.rangeRings) {
        if (tm.rangeRings.trackAcquire)     this.world.remove(tm.rangeRings.trackAcquire);
        if (tm.rangeRings.trackRelease)     this.world.remove(tm.rangeRings.trackRelease);
        if (tm.rangeRings.engageAcquire)    this.world.remove(tm.rangeRings.engageAcquire);
        if (tm.rangeRings.engageRelease)    this.world.remove(tm.rangeRings.engageRelease);
        if (tm.rangeRings.engageMinAcquire) this.world.remove(tm.rangeRings.engageMinAcquire);
        if (tm.rangeRings.engageMinRelease) this.world.remove(tm.rangeRings.engageMinRelease);
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
    if (m.polyChassisSlot !== undefined) this.freePolyChassisSlotForEntity(m.bodyShapeKey, id);
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
      if (w.config.visualOnly) continue;
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

    const firing = entity.turrets.some((w) => !w.config.visualOnly && w.state === 'engaged');
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

  /** Per-frame: flip the shell flag (per-instance `instanceAlpha`
   *  attribute) for every InstancedMesh slot the entity occupies. The
   *  shader (see instanceAlpha.ts) treats <1.0 as "paint flat unlit
   *  pale" and 1.0 as "render normally" — material stays opaque and
   *  team color routing is untouched, so completed instances render
   *  exactly as they would without shell support.
   *
   *  Touches:
   *    - unitInstanced (MIN-tier mass sphere)
   *    - smoothChassis / polyChassis (unit body)
   *    - turretHeadInstanced + barrelInstanced (turret heads & barrels)
   *    - mirrorPanelInstanced (mirror panels)
   *  Treads & per-Mesh chassis fallbacks are handled separately by the
   *  per-Mesh material override (applyShellOverride). */
  private updateShellAlphas(e: Entity, m: EntityMesh): void {
    const isShell = !!(e.buildable && !e.buildable.isComplete && !e.buildable.isGhost);
    const flag = isShell ? SHELL_OPACITY : NORMAL_OPACITY;

    const massSlot = this.unitInstancedSlot.get(e.id);
    if (this.unitInstanced && massSlot !== undefined) {
      setInstanceAlphaSlot(this.unitInstanced, massSlot, flag);
    }

    if (this.smoothChassis && m.smoothChassisSlots) {
      for (const slot of m.smoothChassisSlots) {
        setInstanceAlphaSlot(this.smoothChassis, slot, flag);
      }
    }

    if (m.polyChassisSlot !== undefined && m.bodyShapeKey) {
      const pool = this.polyChassis.get(m.bodyShapeKey);
      if (pool) {
        setInstanceAlphaSlot(pool.mesh, m.polyChassisSlot, flag);
      }
    }

    if (m.turrets) {
      for (const tm of m.turrets) {
        if (tm.headSlot !== undefined && this.turretHeadInstanced) {
          setInstanceAlphaSlot(this.turretHeadInstanced, tm.headSlot, flag);
        }
        if (tm.barrelSlots && this.barrelInstanced) {
          for (const slot of tm.barrelSlots) {
            setInstanceAlphaSlot(this.barrelInstanced, slot, flag);
          }
        }
      }
    }

    if (m.mirrors?.panelSlots && this.mirrorPanelInstanced) {
      for (const slot of m.mirrors.panelSlots) {
        setInstanceAlphaSlot(this.mirrorPanelInstanced, slot, flag);
      }
    }
  }

  private updateUnits(): void {
    const unitRenderMode = this.lod.gfx.unitRenderMode;

    if (unitRenderMode === 'mass') {
      this.clearMassRichUnits();
      if (this.unitMeshes.size > 0) {
        this.rebuildAllUnitsOnLodChange();
      }
      this.updateUnitsInstanced();
      return;
    }

    if (unitRenderMode === 'hybrid') {
      const richUnits = this.updateUnitsInstanced(undefined, true);
      this.updateUnitMeshes(richUnits);
      return;
    }

    if (this.unitInstancedSlot.size > 0) {
      this.releaseAllInstancedSlots();
    }
    this.clearMassRichUnits();
    const units = this.clientViewState.getUnits();
    this.updateUnitMeshes(units);
  }

  private updateUnitMeshes(units: readonly Entity[]): void {
    const seen = this._seenUnitIds;
    seen.clear();
    const spinDt = this._spinDt;
    this.richUnitDetailFrame = (this.richUnitDetailFrame + 1) & 0x3fffffff;
    let smoothColorDirty = false;
    this.turretHeadColorDirty = false;
    this.mirrorPanelColorDirty = false;

    for (const e of units) {
      seen.add(e.id);
      // Hoist transform reads — referenced by the scope gate AND the
      // per-tick group / yaw write; reading the same prop slot off
      // `e.transform` four+ times for thousands of units adds up.
      const transform = e.transform;
      const tx = transform.x;
      const ty = transform.y;
      const tRot = transform.rotation;
      // RIGID-BODY POSE TRACKS THE SIM EVERY FRAME, scope or no scope.
      // The unit group carries the chassis AND its child turret /
      // mirror groups (both parented to yawGroup). Skipping the
      // group-level position/yaw update for off-scope units would
      // leave the whole rigid body — turrets included — frozen at
      // its last on-screen pose; if the camera then panned to it
      // before the next in-scope tick, the user would see a unit
      // floating somewhere it isn't. Cheap to set unconditionally.
      const inScope = this.scope.inScope(tx, ty, 100);
      const existing = this.unitMeshes.get(e.id);
      if (existing) {
        existing.group.position.set(tx, getUnitGroundZ(e), ty);
        if (existing.yawGroup) existing.yawGroup.rotation.set(0, -tRot, 0);
        // Shell-state visual — two paths must agree:
        //   - applyShellOverride handles per-Mesh chassis fallbacks
        //     and treads (objects that own their own material).
        //   - updateShellAlphas handles every InstancedMesh slot the
        //     entity occupies (smooth/poly chassis, turret heads,
        //     barrels, mirror panels, MIN-tier mass sphere) via the
        //     per-instance alpha shader injection in instanceAlpha.ts.
        applyShellOverride(
          existing.group,
          !!(e.buildable && !e.buildable.isComplete && !e.buildable.isGhost),
        );
        this.updateShellAlphas(e, existing);
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
      const radius = e.unit?.radius.body
        ?? e.unit?.radius.shot
        ?? 15;
      const pid = e.ownership?.playerId;
      const colorKey = pid ?? -1;
      const turrets = e.turrets ?? [];
      const objectTier = this.massRichObjectTiers.get(e.id) ?? this.resolveEntityObjectLod(e);
      const isCommanderUnit = isCommander(e);
      const fullUnitDetail =
        isRichObjectLod(objectTier) || objectTier === 'simple' || objectTier === 'impostor';
      const unitGraphicsTier = objectTier === 'impostor'
        ? 'min'
        : objectLodToGraphicsTier(objectTier, this.lod.gfx.tier);
      const unitGfx = getGraphicsConfigFor(unitGraphicsTier);
      const unitLodKey = lodKey(unitGfx);

      let m = this.unitMeshes.get(e.id);
      if (m && m.lodKey !== unitLodKey) {
        // Preserve leg state across the LOD-driven rebuild — feet keep
        // their planted world positions through the teardown so the
        // newly built mesh resumes the gait instead of snapping back
        // to rest. Captured BEFORE destroyUnitMesh frees the legs.
        const legSnap = captureLegState(m.locomotion);
        if (legSnap) this.legStateCache.set(e.id, legSnap);
        this.destroyUnitMesh(e.id, m);
        m = undefined;
      }
      const meshWasBuilt = !m;
      if (!m) {
        const group = new THREE.Group();
        // Pull the authored body shape from the unit blueprint and use
        // it for both the visible chassis geometry and the instanced
        // pool key. Falls back to the shared body-shape fallback for
        // unknown unit types.
        let bp: ReturnType<typeof getUnitBlueprint> | undefined;
        try { bp = getUnitBlueprint(e.unit!.unitType); }
        catch { /* leave undefined; fallback handled below */ }
        const bodyShape = bp?.bodyShape ?? FALLBACK_UNIT_BODY_SHAPE;
        const bodyShapeKey = getUnitBodyShapeKey(bodyShape);
        const bodyEntry = getBodyGeom(bodyShape);
        const hideChassis = bp?.hideChassis === true;
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
        //   2. Polygon / rect → body-shape `polyChassis` pool (one
        //      InstancedMesh per body-shape key, single slot per unit
        //      because polygonal bodies are single-part).
        //   3. Cap exhausted → fall back to per-Mesh chassis (one Mesh
        //      per part, shared team-primary material).
        // Per-instance matrix + color are written by the per-frame
        // transform pipeline below; the per-Mesh fallback is rendered
        // by the scenegraph chain like before.
        let smoothChassisSlots: number[] | undefined;
        let polyChassisSlot: number | undefined;
        if (
          USE_DETAILED_UNIT_INSTANCING &&
          !hideChassis &&
          bodyEntry.isSmooth &&
          bodyEntry.parts.length > 0
        ) {
          smoothChassisSlots = this.allocSmoothChassisSlots(bodyEntry.parts.length) ?? undefined;
        } else if (
          USE_DETAILED_UNIT_INSTANCING &&
          !hideChassis &&
          !bodyEntry.isSmooth &&
          bodyEntry.parts.length > 0
        ) {
          const allocated = this.allocPolyChassisSlot(
            e.id, bodyShapeKey, bodyEntry.parts[0].geometry,
          );
          if (allocated !== null) polyChassisSlot = allocated;
        }
        if (!hideChassis && !smoothChassisSlots && polyChassisSlot === undefined) {
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
        const turretMeshes: TurretMesh[] = [];
        const turretOff = unitGfx.turretStyle === 'none';
        const commanderDgunTurretId = isCommanderUnit ? bp?.dgun?.turretId : undefined;
        for (let ti = 0; ti < turrets.length; ti++) {
          const t = turrets[ti];
          // Decide whether to route this turret's head through the
          // shared `turretHeadInstanced` InstancedMesh. The same
          // hideHead conditions buildTurretMesh3D uses (turret-off
          // / force-field) skip the slot entirely; for
          // visible heads, alloc a slot and pass `skipHead: true`
          // so buildTurretMesh3D doesn't ALSO build a per-Mesh head
          // (would double-render). Slot alloc returns null on cap
          // exhaustion → fall back to per-Mesh head.
          const isForceField = (t.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
          const isConstructionEmitter = t.config.constructionEmitter !== undefined;
          const hideHead = turretOff || isForceField || isConstructionEmitter;
          let headSlot: number | undefined;
          if (USE_DETAILED_UNIT_INSTANCING && !hideHead && !isCommanderUnit) {
            const allocated = this.allocTurretHeadSlot();
            if (allocated !== null) headSlot = allocated;
          }
          // Decide whether to route this turret's barrels through the
          // shared `barrelInstanced` InstancedMesh. Force-field and
          // turretOff turrets have no barrels. For
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
          const tm = buildTurretMesh3D(liftGroup, t, unitGfx, {
            headGeom: this.turretHeadGeom,
            barrelGeom: this.barrelGeom,
            barrelMat: this.barrelMat,
            primaryMat: this.getPrimaryMat(pid),
            skipHead: headSlot !== undefined,
            skipBarrels: false, // try to attach for fallback safety
          });
          if (tm.head) tm.head.userData.entityId = e.id;
          if (isCommanderUnit && !hideHead) {
            this.decorateCommanderTurret(
              tm,
              t.config.id === commanderDgunTurretId,
              unitGraphicsTier,
            );
          }
          for (const b of tm.barrels) b.userData.entityId = e.id;
          tm.headSlot = headSlot;
          // Try to allocate one barrel slot per barrel. All-or-nothing:
          // partial allocations get freed and we leave the per-Mesh
          // barrels in the scene as the fallback.
          if (USE_DETAILED_UNIT_INSTANCING && tm.barrels.length > 0 && this.barrelInstanced) {
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

        this.world.add(group);
        m = {
          group, yawGroup, liftGroup, chassis, chassisMeshes, bodyShapeKey, bodyShape,
          hideChassis,
          turrets: turretMeshes, lodKey: unitLodKey,
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
        // Restore leg state if this was an LOD-driven rebuild — feet
        // resume from where they were planted instead of snapping
        // back to rest. Cache entry consumed (deleted) on restore so
        // a stale snapshot doesn't pollute a future genuinely-fresh
        // build (e.g. spawn after death). Non-legged locomotion
        // ignores the call (applyLegState early-outs on type !== 'legs').
        const legSnap = this.legStateCache.get(e.id);
        if (legSnap !== undefined) {
          applyLegState(m.locomotion, legSnap);
          this.legStateCache.delete(e.id);
        }


        // Mirror panels (e.g. Loris): square slabs mounted at arm's
        // length out from the turret body sphere. The panel offset
        // (= arm length) lives on each panel's `offsetX` from
        // mirrorPanelCache; we use the first panel's value here so the
        // visual arm + panel match the sim's collision rectangle.
        const mirrorPanels = e.unit?.mirrorPanels;
        if (mirrorPanels && mirrorPanels.length > 0 && e.unit) {
          // Read panel size from the cached collision rectangle so
          // the visual panel and the sim panel are guaranteed to
          // agree — bumping MIRROR_PANEL_SIZE_MULT in
          // mirrorPanelCache.ts flows through here automatically.
          const panelHalfSide = mirrorPanels[0].halfWidth;
          const panelArmLength = mirrorPanels[0].offsetX;
          // Panel world-y should be the unit's bodyCenterHeight; the
          // mesh is parented to liftGroup at y = chassisLift, so the
          // panel-local y must subtract chassisLift to land at
          // bodyCenterHeight in world space — same trick the turret
          // head root uses.
          const panelCenterY =
            getUnitBodyCenterHeight(e.unit) - liftGroup.position.y;
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
          let allMirrorAlloc =
            USE_DETAILED_UNIT_INSTANCING &&
            panelCount > 0 &&
            this.mirrorPanelInstanced !== null;
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
            liftGroup, mirrorPanels,
            panelCenterY, panelHalfSide, panelArmLength,
            this.mirrorGeom, this.mirrorArmGeom, this.mirrorSupportGeom,
            this.getMirrorShinyMat(), this.getPrimaryMat(pid),
            allMirrorAlloc, // skipPerMesh when instancing is on
          );
          if (allMirrorAlloc) m.mirrors.panelSlots = allocedPanelSlots;
          for (const panel of m.mirrors.panels) {
            panel.userData.entityId = e.id;
          }
          for (const frame of m.mirrors.frames) {
            frame.userData.entityId = e.id;
          }
        }

        const isShellState = !!(
          e.buildable && !e.buildable.isComplete && !e.buildable.isGhost
        );
        applyShellOverride(group, isShellState);
        this.updateShellAlphas(e, m);
        this.unitMeshes.set(e.id, m);
      } else {
        // Per-frame team-color refresh for the per-Mesh paths
        // (chassis-meshes fallback, non-instanced turret heads, mirror
        // arms). These writes would clobber the per-Mesh shell-material
        // override that applyShellOverride installs earlier in this
        // iteration — visible as e.g. mirror-turret arms staying team-
        // colored on a shell unit. Skip the refresh while the entity
        // is a shell; applyShellOverride re-runs every frame so the
        // first frame after completion will install the original
        // material (cached on userData) and the next refresh will
        // touch up to the latest team color.
        const isShellState = !!(
          e.buildable && !e.buildable.isComplete && !e.buildable.isGhost
        );
        if (!isShellState) {
          const primaryMat = this.getPrimaryMat(pid);
          for (const mesh of m.chassisMeshes) mesh.material = primaryMat;
          for (const tm of m.turrets) {
            if (tm.head) tm.head.material = this.getPrimaryMat(pid);
          }
          if (m.mirrors) {
            for (const arm of m.mirrors.arms) arm.material = primaryMat;
          }
        }
      }
      m.chassis.visible = fullUnitDetail && !m.hideChassis;

      if (!this.shouldUpdateRichUnitDetails(e, m, objectTier, meshWasBuilt)) {
        continue;
      }

      // Position group at the unit's footprint. sim.x → Three.x, sim.y
      // → Three.z (the existing horizontal convention). Vertical =
      // sim.z - bodyCenterHeight: for a ground-resting unit sim.z is
      // terrain + bodyCenterHeight, so the group sits at the terrain
      // surface and the chassis/turret meshes stack from there.
      m.group.position.set(e.transform.x, getUnitGroundZ(e), e.transform.y);

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
      // Read the unit's sim-side smoothed normal instead of querying
      // the raw terrain mesh per frame. The sim's updateUnitTilt EMA
      // owns the canonical value (initialized at spawn, blended each
      // tick); for unit entities this is what we want.
      // For non-unit entities (buildings, projectiles) we fall back
      // to the raw terrain query since they don't run through the
      // tilt EMA.
      const n = e.unit
        ? e.unit.surfaceNormal
        : getSurfaceNormal(
            e.transform.x, e.transform.y,
            this.clientViewState.getMapWidth(), this.clientViewState.getMapHeight(),
            LAND_CELL_SIZE,
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
      if (!fullUnitDetail || m.hideChassis) {
        if (m.smoothChassisSlots && this.smoothChassis) {
          for (const slot of m.smoothChassisSlots) {
            this.smoothChassis.setMatrixAt(slot, Render3DEntities._ZERO_MATRIX);
          }
        } else if (m.polyChassisSlot !== undefined) {
          const pool = this.polyChassis.get(m.bodyShapeKey);
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
        const pool = this.polyChassis.get(m.bodyShapeKey);
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

      // BODY / SHOT / PUSH unit-radius indicator rings. The 2D renderer
      // draws these as stroked circles at the respective collider radii;
      // here we mirror the same toggle → ring visibility behaviour.
      this.updateRadiusRings(m, e);
      this.updateRangeRings(m, e);

      // Per-turret placement. The runtime 3D mount is derived from the
      // unit blueprint's `turrets[i].mount` in body-radius fractions.
      // Sim coords (x, y, z) map to Three local (x, y, z) as
      // forward, height, lateral.
      // On mirror-host units (e.g. Loris) turret[0] owns the mirror panel
      // and the visible host turret body.
      const spinState = this.barrelSpins.get(e.id);
      for (let i = 0; i < m.turrets.length && i < turrets.length; i++) {
        const tm = m.turrets[i];
        const t = turrets[i];
        const headRadius = tm.headRadius ?? getTurretHeadRadius(t.config);
        const turretHeadCenterY = getTurretMountHeight(e, i);
        const turretMountY = turretHeadCenterY - (m.chassisLift ?? 0) - headRadius;
        tm.root.position.set(t.mount.x, turretMountY, t.mount.y);

        if (tm.constructionEmitter) {
          const visible = buildingTierAtLeast(unitGraphicsTier, 'low');
          tm.root.visible = visible;
          tm.root.rotation.y = 0;
          if (tm.pitchGroup) tm.pitchGroup.rotation.z = 0;
          if (tm.spinGroup) tm.spinGroup.rotation.x = 0;
          if (visible) {
            this.updateCommanderEmitter(tm.constructionEmitter, e, unitGraphicsTier);
          }
          continue;
        }

        // Head InstancedMesh write — the head sphere's chassis-local
        // position is (mount.x, mountY + headRadius, mount.y) inside
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
            t.mount.x,
            lift + turretMountY + tm.headRadius,
            t.mount.y,
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
      // tilting backward, so the rendered panel would lean opposite to
      // where the sim's reflection plane actually sits.
      if (m.mirrors) {
        m.mirrors.root.visible = this.mirrorsEnabled;
        if (this.mirrorsEnabled) {
          const mirrorRot = turrets[0]?.rotation ?? e.transform.rotation;
          const mirrorPitch = turrets[0]?.pitch ?? 0;
          // SINGLE JOINT at the turret attachment point. The whole
          // rigid arm + panel assembly is parented to mirrors.root,
          // and ALL rotation lives there. Yaw + pitch are two
          // descriptions of one ball-joint orientation — applied as
          // one Euler 'YZX' (yaw first around world Y, then pitch
          // around the post-yaw side axis Z). No per-arm or per-panel
          // rotation; the arms and panels keep their static
          // build-time transforms (arm at visibleArmLength/2 forward,
          // panel at panelArmLength forward, both at panelCenterY up)
          // and sweep through 3D as one body when root rotates.
          _aimDir.set(Math.cos(mirrorRot), 0, Math.sin(mirrorRot));
          if (chassisTilted) _aimDir.applyQuaternion(_invTiltQuat);
          const mCombinedYaw = Math.atan2(-_aimDir.z, _aimDir.x);
          m.mirrors.root.rotation.set(
            0,
            mCombinedYaw + e.transform.rotation,
            mirrorPitch,
            'YZX',
          );

          // Mirror-panel InstancedMesh write. parentMat = group ·
          // yawGroup · liftGroup · mirrors.root — first three groups
          // come from the cached unit chain, mirrors.root contributes
          // the full ball-joint rotation. Reading the root's full
          // quaternion (auto-synced from .rotation by Three) instead
          // of building a yaw-only quat is what makes the panel
          // render where the sim collides: pitch sweeps the panel
          // through 3D via the parent matrix, not by per-mesh
          // post-rotations.
          if (m.mirrors.panelSlots && this.mirrorPanelInstanced) {
            // parentMat = group · yawGroup · liftGroup · root.local.
            // root.local is now T(0, panelCenterY, 0) · R(quaternion)
            // — the translation lifts the joint to the body-center
            // height, the quaternion is the single ball-joint
            // rotation. Compose with root's actual position (not
            // zero) so the writer agrees with the scene-graph that
            // would render the per-Mesh fallback path.
            this._barrelParentMat.copy(this._unitChainMat);
            this._barrelStepMat.compose(
              m.mirrors.root.position,
              m.mirrors.root.quaternion,
              this._barrelOneVec,
            );
            this._barrelParentMat.multiply(this._barrelStepMat);

            const mirrorColorKey = MIRROR_PANEL_COLOR;
            this._instColor.set(MIRROR_PANEL_COLOR);
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
              if (this.mirrorPanelColorKey.get(slot) !== mirrorColorKey) {
                this.mirrorPanelInstanced.setColorAt(slot, this._instColor);
                this.mirrorPanelColorKey.set(slot, mirrorColorKey);
                this.mirrorPanelColorDirty = true;
              }
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
      this.markRichUnitDetailsUpdated(e, m);

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
        // Polygonal-chassis slot lives in the body-shape pool keyed by
        // m.bodyShapeKey — release it back so a future unit with the
        // same body shape can take the slot.
        if (m.polyChassisSlot !== undefined) {
          this.freePolyChassisSlotForEntity(m.bodyShapeKey, id);
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
        // True entity removal — drop any stashed leg-state snapshot
        // so a future re-spawn of a different unit reusing this
        // entityId starts fresh instead of inheriting last unit's
        // foot positions.
        this.legStateCache.delete(id);
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
    // Same for every body-shape polygonal pool. count rides on
    // each pool's nextSlot independently so a pool serving 50 units
    // doesn't get stuck running 4096 VS invocations per frame just
    // because it shares the architecture with a busier body shape.
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
    // Mirror panels — one shared shiny-gray PBR draw call.
    if (this.mirrorPanelInstanced) {
      this.mirrorPanelInstanced.count = this.mirrorsEnabled ? this.mirrorPanelNextSlot : 0;
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
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const pruneBuildings = entitySetVersion !== this.lastBuildingEntitySetVersion;
    if (pruneBuildings) seen.clear();
    this.releaseFactorySprayTargets();

    // LOD-driven detail visibility for buildings. Each accent mesh now
    // declares its own tier range, and the per-object resolver can lower
    // distant buildings below the global tier without using footprint size.

    for (const e of buildings) {
      if (pruneBuildings) seen.add(e.id);
      // Buildings are sparse and strategically important. Do not apply
      // the 2D render-scope early-out here: it can disagree with the
      // perspective/frustum view at steep camera angles and make a
      // building vanish even though its 3D LOD cell should render a
      // full shape or marker. Let Three frustum-cull the final meshes.
      const objectTier = this.resolveEntityObjectLod(e);
      const markerOnly = objectTier === 'marker';
      const tier = markerOnly ? 'min' : objectLodToGraphicsTier(objectTier, this.lod.gfx.tier);
      const pid = e.ownership?.playerId;
      const shapeType: BuildingShapeType = e.buildingType
        ? getBuildingConfig(e.buildingType).renderProfile
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
        if (shape.factoryRig?.group) {
          shape.factoryRig.group.userData.entityId = e.id;
          shape.factoryRig.group.traverse((obj) => { obj.userData.entityId = e.id; });
          group.add(shape.factoryRig.group);
        }
        this.world.add(group);
        m = {
          group,
          chassis,
          chassisMeshes: [shape.primary],
          // Buildings don't use unit body-shape pools (they have
          // their own BuildingShape3D path), so the field is unused
          // here — empty string is fine since the unit-update loop
          // never reaches a building.
          bodyShapeKey: '',
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
        this.registerAnimatedBuilding(e, m);
      }

      const buildable = e.buildable;
      const progress =
        buildable && !buildable.isComplete
          ? Math.max(0.05, Math.min(1, getBuildFraction(buildable)))
          : 1;
      const selected = e.selectable?.selected === true;
      const buildingBaseY = e.building ? e.transform.z - e.building.depth / 2 : 0;
      const detailsReady = !markerOnly && progress >= 1;
      const buildingRenderDirty =
        m.buildingCachedTier !== objectTier ||
        m.buildingCachedGraphicsTier !== tier ||
        m.buildingCachedOwnerId !== pid ||
        m.buildingCachedProgress !== progress ||
        m.buildingCachedSelected !== selected ||
        m.buildingCachedWidth !== w ||
        m.buildingCachedDepth !== d ||
        m.buildingCachedX !== e.transform.x ||
        m.buildingCachedY !== e.transform.y ||
        m.buildingCachedZ !== e.transform.z ||
        m.buildingCachedRotation !== e.transform.rotation;

      if (buildingRenderDirty) {
        m.group.visible = true;
        if (!m.buildingPrimaryMaterialLocked) {
          const primaryMat = this.getPrimaryMat(pid);
          for (const mesh of m.chassisMeshes) mesh.material = primaryMat;
        }
        if (m.buildingDetails) {
          const primaryMat = this.getPrimaryMat(pid);
          for (const detail of m.buildingDetails) {
            if (detail.role === 'solarTeamAccent') detail.mesh.material = primaryMat;
          }
        }

        // Transform.z is the building's vertical center in sim space.
        // Render from the footprint base so buildings sit on the same
        // terrain height the server used when creating their collider.
        m.group.position.set(e.transform.x, buildingBaseY, e.transform.y);
        m.group.rotation.y = -e.transform.rotation;
        // Shell-state visual — same logic as units: while the
        // building's buildable is incomplete, every mesh inside the
        // group flips to the shared transparent gray shell material.
        applyShellOverride(
          m.group,
          !!(e.buildable && !e.buildable.isComplete && !e.buildable.isGhost),
        );
        const h = m.buildingHeight ?? BUILDING_HEIGHT;

        // Build-progress visual — bottom-up fill. Primary body scales
        // vertically by `progress` (the average fill across the three
        // resource axes computed from paid / required, clamped to a
        // small minimum so a 0% building still catches light and is
        // clickable); accent meshes (chimney, solar cells) stay hidden
        // until the building is complete so they don't pop out of an
        // incomplete silhouette.
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
          const marker = new THREE.Mesh(this.buildingMarkerBoxGeom, this.getPrimaryMat(pid));
          marker.userData.entityId = e.id;
          m.group.add(marker);
          m.lodMarker = marker;
        } else {
          m.lodMarker.material = this.getPrimaryMat(pid);
        }
        // At marker tier the type-specific primary mesh and the accent
        // details are all hidden, so without a stand-in the building
        // would collapse to nothing. Show a simple team-colored box
        // sized to the building's LOGICAL sim cuboid (width × depth ×
        // height — identical to the static collider on the host) so it
        // still reads as a building on the ground. Same volume the
        // high-LOD primary occupies, just one cube instead of a bespoke
        // shape.
        const markerHeight = e.building?.depth ?? (m.buildingHeight ?? BUILDING_HEIGHT);
        m.lodMarker.visible = markerOnly;
        m.lodMarker.position.set(0, markerHeight / 2, 0);
        m.lodMarker.scale.set(w, markerHeight, d);
        if (m.buildingDetails) {
          for (const detail of m.buildingDetails) {
            const visible = detailsReady && buildingDetailVisible(detail, tier);
            detail.mesh.visible = visible;
          }
        }

        // Building selection halo. Uses the same torus material/geometry as
        // units so clicking a factory/solar/wind reads like selecting any
        // other owned entity. Scale by footprint diagonal so rectangular
        // buildings sit fully inside the donut.
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

        m.buildingCachedTier = objectTier;
        m.buildingCachedGraphicsTier = tier;
        m.buildingCachedOwnerId = pid;
        m.buildingCachedProgress = progress;
        m.buildingCachedSelected = selected;
        m.buildingCachedWidth = w;
        m.buildingCachedDepth = d;
        m.buildingCachedX = e.transform.x;
        m.buildingCachedY = e.transform.y;
        m.buildingCachedZ = e.transform.z;
        m.buildingCachedRotation = e.transform.rotation;
        m.buildingCachedDetailsReady = detailsReady;
      } else {
        m.group.visible = true;
      }

      // Health + build-progress bars handled by HealthBar3D
      // (billboarded sprite in the world group).
    }

    this.updateAnimatedBuildings();

    if (pruneBuildings) {
      for (const [id, m] of this.buildingMeshes) {
        if (!seen.has(id)) {
          this.world.remove(m.group);
          this.buildingMeshes.delete(id);
          this.unregisterAnimatedBuilding(id);
        }
      }
      this.lastBuildingEntitySetVersion = entitySetVersion;
    }
  }

  private addAnimatedBuilding(
    list: EntityId[],
    set: Set<EntityId>,
    id: EntityId,
  ): void {
    if (set.has(id)) return;
    set.add(id);
    list.push(id);
  }

  private removeAnimatedBuilding(
    list: EntityId[],
    set: Set<EntityId>,
    id: EntityId,
  ): void {
    if (!set.delete(id)) return;
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
  }

  private registerAnimatedBuilding(entity: Entity, mesh: EntityMesh): void {
    const id = entity.id;
    if (entity.buildingType === 'solar' && mesh.buildingDetails) {
      this.addAnimatedBuilding(this.solarBuildingIds, this.solarBuildingIdSet, id);
    }
    if (mesh.windRig) {
      this.addAnimatedBuilding(this.windBuildingIds, this.windBuildingIdSet, id);
    }
    if (mesh.extractorRig) {
      this.addAnimatedBuilding(this.extractorBuildingIds, this.extractorBuildingIdSet, id);
    }
    if (mesh.factoryRig) {
      this.addAnimatedBuilding(this.factoryBuildingIds, this.factoryBuildingIdSet, id);
    }
  }

  private unregisterAnimatedBuilding(id: EntityId): void {
    this.removeAnimatedBuilding(this.solarBuildingIds, this.solarBuildingIdSet, id);
    this.removeAnimatedBuilding(this.windBuildingIds, this.windBuildingIdSet, id);
    this.removeAnimatedBuilding(this.extractorBuildingIds, this.extractorBuildingIdSet, id);
    this.extractorRotorPhases.delete(id);
    this.removeAnimatedBuilding(this.factoryBuildingIds, this.factoryBuildingIdSet, id);
  }

  private updateAnimatedBuildings(): void {
    for (const id of this.solarBuildingIds) {
      const mesh = this.buildingMeshes.get(id);
      const entity = this.clientViewState.getEntity(id);
      if (mesh && entity) {
        this.updateSolarCollectorAnimation(mesh, entity, mesh.buildingCachedDetailsReady === true);
      }
    }

    if (this.windBuildingIds.length > 0) {
      this.updateWindAnimationGlobals();
      for (const id of this.windBuildingIds) {
        const mesh = this.buildingMeshes.get(id);
        if (mesh) this.updateWindTurbineRig(mesh, mesh.buildingCachedDetailsReady === true);
      }
    }

    if (this.extractorBuildingIds.length > 0) {
      // Each extractor advances its own rotor phase by dt × base ×
      // coverageFraction, so spin scales 1:1 with metal-per-second.
      // 0 covered tiles → stationary; full coverage → full base rate.
      // metalProduction is the extractor's configured ceiling rate;
      // metalExtractionRate is what this particular instance pulls
      // (computed at construction time). The per-entity jitter
      // (`id × 0.173`) is baked INTO the stored phase the first time
      // we see an extractor and never re-applied, so the per-frame
      // body is one Map.get + one Map.set.
      const invBase = INV_EXTRACTOR_BASE_PRODUCTION;
      const dtRate = this._spinDt * EXTRACTOR_ROTOR_RAD_PER_SEC;
      const TWO_PI = Math.PI * 2;
      const phases = this.extractorRotorPhases;
      for (const id of this.extractorBuildingIds) {
        const mesh = this.buildingMeshes.get(id);
        const entity = this.clientViewState.getEntity(id);
        if (!mesh || !entity) continue;
        const rate = entity.metalExtractionRate ?? 0;
        let phase = phases.get(id);
        if (phase === undefined) phase = id * 0.173; // first-frame jitter seed
        phase = (phase + dtRate * (rate * invBase)) % TWO_PI;
        phases.set(id, phase);
        // Inline the rig write. Every per-tier rotor in the rig
        // array gets the same yaw — only one is visible at a time
        // (tier-gated by detail.minTier/maxTier), so writing the
        // hidden one is just a property assign with no GPU work.
        // Avoids an LOD-flip glitch where the swapped-in rotor would
        // briefly point at an old yaw.
        const rig = mesh.extractorRig;
        if (rig && mesh.buildingCachedDetailsReady === true) {
          const yaw = -phase;
          const rotors = rig.rotors;
          for (let r = 0; r < rotors.length; r++) {
            rotors[r].rotation.y = yaw;
          }
        }
      }
    }

    for (const id of this.factoryBuildingIds) {
      const mesh = this.buildingMeshes.get(id);
      const entity = this.clientViewState.getEntity(id);
      if (!mesh || !entity) continue;
      this.updateFactoryConstructionRig(
        mesh.factoryRig,
        entity,
        mesh.buildingCachedGraphicsTier ?? 'min',
        mesh.buildingCachedDetailsReady === true,
        mesh.buildingCachedWidth ?? entity.building?.width ?? 100,
        mesh.buildingCachedDepth ?? entity.building?.height ?? 100,
        mesh.group,
      );
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
    // Recycled targets may carry a stale per-resource colorRGB from
    // their last use. Clear it so callers that don't set one fall
    // back to team color cleanly.
    target.colorRGB = undefined;
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
      _solarPetalDirection
        .copy(anim.closedDirection)
        .lerp(anim.openDirection, t)
        .normalize();
      writeSolarPetalMatrix(
        detail.mesh.matrix,
        anim.width,
        anim.length,
        anim.hinge,
        anim.tangent,
        _solarPetalDirection,
        anim.inset,
        anim.normalOffset,
        anim.thickness,
        anim.panelSideHint,
      );
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

  private updateConstructionTowerSpin(
    rig: ConstructionTowerSpinRig,
    active: boolean,
    dtSec: number,
  ): void {
    if (rig.towerOrbitParts.length === 0) return;
    const preset = getDriftPreset(getDriftMode());
    const alpha = halfLifeBlend(
      dtSec,
      preset.rotation.vel * CONSTRUCTION_TOWER_SPIN_CONFIG.driftHalfLifeMultiplier,
    );
    const target = active ? 1 : 0;
    const amountBefore = rig.towerSpinAmount;
    rig.towerSpinAmount += (target - rig.towerSpinAmount) * alpha;
    if (!active && rig.towerSpinAmount < 0.001) {
      rig.towerSpinAmount = 0;
    }
    if (rig.towerSpinAmount > 0) {
      rig.towerSpinPhase =
        (rig.towerSpinPhase + dtSec * CONSTRUCTION_TOWER_SPIN_CONFIG.radPerSec * rig.towerSpinAmount)
        % (Math.PI * 2);
    }
    // Stable-state short-circuit: when both this frame's amount AND
    // the previous frame's amount are 0, the phase didn't advance and
    // every per-mesh write below would re-stamp the same transform we
    // wrote last frame. The first frame after the fade-out completes
    // still runs the loop (amountBefore > 0 → amount === 0) so the
    // resting positions get one final settled write.
    if (amountBefore === 0 && rig.towerSpinAmount === 0) return;
    const c = Math.cos(rig.towerSpinPhase);
    const s = Math.sin(rig.towerSpinPhase);
    for (let i = 0; i < rig.towerOrbitParts.length; i++) {
      const part = rig.towerOrbitParts[i];
      part.mesh.position.x = part.baseX * c - part.baseZ * s;
      part.mesh.position.z = part.baseX * s + part.baseZ * c;
      part.mesh.rotation.y = part.baseRotationY + rig.towerSpinPhase;
    }
    for (let i = 0; i < rig.pylonTopsLocal.length && i < rig.pylonTopBaseLocals.length; i++) {
      const base = rig.pylonTopBaseLocals[i];
      const current = rig.pylonTopsLocal[i];
      current.x = base.x * c - base.z * s;
      current.y = base.y;
      current.z = base.x * s + base.z * c;
    }
  }


  /** EMA-blend new per-resource rate targets toward the rig's smoothed
   *  store. Shared by factory + commander emitters so the smoothing
   *  contract can't drift between them. */
  private blendSmoothedRates(
    smoothed: { energy: number; mana: number; metal: number },
    targetEnergy: number,
    targetMana: number,
    targetMetal: number,
    alpha: number,
  ): void {
    smoothed.energy += (targetEnergy - smoothed.energy) * alpha;
    smoothed.mana   += (targetMana   - smoothed.mana)   * alpha;
    smoothed.metal  += (targetMetal  - smoothed.metal)  * alpha;
  }

  /** Drive each shower cylinder bottom-up from the rig's smoothed
   *  per-resource rates (0..1). Hidden when the rate is essentially
   *  zero so a fully-funded build doesn't leave a stub. Shared by
   *  factory active/inactive paths and commander active path. */
  private applyShowerFromSmoothedRates(rig: {
    showers: THREE.Mesh[];
    showerRadius: number;
    pylonHeight: number;
    pylonBaseY: number;
    smoothedRates: { energy: number; mana: number; metal: number };
  }): void {
    const smoothed: readonly [number, number, number] = [
      rig.smoothedRates.energy,
      rig.smoothedRates.mana,
      rig.smoothedRates.metal,
    ];
    for (let i = 0; i < rig.showers.length && i < 3; i++) {
      const shower = rig.showers[i];
      const r = smoothed[i];
      if (r < 0.01) {
        shower.visible = false;
        continue;
      }
      shower.visible = true;
      const h = rig.pylonHeight * r;
      shower.scale.set(rig.showerRadius, h, rig.showerRadius);
      shower.position.y = rig.pylonBaseY + h / 2;
    }
  }

  /** Emit the three per-resource colored build sprays from each pylon
   *  top to the supplied world-space target. Skipped per-pylon when
   *  that resource's smoothed rate is below the 0.05 visibility floor.
   *  Caller is responsible for the upstream tier gate (only fires at
   *  'high' tier or above), for calling `group.updateWorldMatrix(true,
   *  false)` once before invocation (so factory callers can reuse the
   *  fresh matrix when computing their own target), and for writing
   *  the desired three.js world point into `targetWorld`. */
  private emitPylonResourceSprays(
    rig: {
      pylonTopsLocal: THREE.Vector3[];
      smoothedRates: { energy: number; mana: number; metal: number };
    },
    group: THREE.Group,
    sourceId: EntityId,
    sourcePlayerId: PlayerId,
    targetId: EntityId,
    targetWorld: THREE.Vector3,
    targetRadius: number,
  ): void {
    const smoothed: readonly [number, number, number] = [
      rig.smoothedRates.energy,
      rig.smoothedRates.mana,
      rig.smoothedRates.metal,
    ];
    for (let i = 0; i < rig.pylonTopsLocal.length && i < 3; i++) {
      const rate = smoothed[i];
      if (rate < 0.05) continue;
      this._factorySpraySourceWorld
        .copy(rig.pylonTopsLocal[i])
        .applyMatrix4(group.matrixWorld);
      const spray = this.acquireFactorySprayTarget();
      spray.source.id = sourceId;
      spray.source.pos.x = this._factorySpraySourceWorld.x;
      spray.source.pos.y = this._factorySpraySourceWorld.z;
      spray.source.z = this._factorySpraySourceWorld.y;
      spray.source.playerId = sourcePlayerId;
      spray.target.id = targetId;
      spray.target.pos.x = targetWorld.x;
      spray.target.pos.y = targetWorld.z;
      spray.target.z = targetWorld.y;
      spray.target.dim = undefined;
      spray.target.radius = targetRadius;
      spray.type = 'build';
      // Intensity = the EMA rate fraction directly (clamped to [0,1]).
      // The renderer uses this linearly for spawn rate so the particle
      // stream density tracks the shower-cylinder fill exactly — i.e.
      // when the shower is at 50% the spray emits at 50% of the spawn
      // budget. The upstream 0.05 cull (above) gates whether to emit
      // a spray at all; below that the visual would be ~zero anyway.
      spray.intensity = Math.min(1, rate);
      spray.colorRGB = RESOURCE_SPRAY_COLORS[i];
    }
  }

  /** Drive the commander build emitter: EMA the per-resource transfer
   *  rates derived from the build target's `buildable.paid` deltas,
   *  scale each shower bottom-up, and emit one colored build spray
   *  from each pylon top toward the build target. Mirrors the factory
   *  pattern but rates are computed render-side (no extra wire
   *  payload) since builders already ship `paid` for every Buildable. */
  private updateCommanderEmitter(
    rig: ConstructionEmitterRig,
    commander: Entity,
    tier: ConcreteGraphicsQuality,
  ): void {
    const dtSec = this._currentDtMs / 1000;
    const halfLife = BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE];
    const rateAlpha = halfLifeBlend(dtSec, halfLife);

    const targetId = commander.builder?.currentBuildTarget ?? null;
    let targetRateE = 0;
    let targetRateM = 0;
    let targetRateT = 0;
    let spinActive = false;
    if (targetId !== null && commander.builder && dtSec > 0) {
      const target = this.clientViewState.getEntity(targetId);
      const buildable = target?.buildable;
      if (target && buildable && !buildable.isComplete) {
        spinActive = true;
        // Reset baseline on target switch — otherwise the first frame
        // would see a giant delta and spike all three showers.
        if (rig.lastPaidTargetId !== targetId) {
          rig.lastPaid.energy = buildable.paid.energy;
          rig.lastPaid.mana = buildable.paid.mana;
          rig.lastPaid.metal = buildable.paid.metal;
          rig.lastPaidTargetId = targetId;
        }
        const dE = Math.max(0, buildable.paid.energy - rig.lastPaid.energy);
        const dM = Math.max(0, buildable.paid.mana - rig.lastPaid.mana);
        const dT = Math.max(0, buildable.paid.metal - rig.lastPaid.metal);
        rig.lastPaid.energy = buildable.paid.energy;
        rig.lastPaid.mana = buildable.paid.mana;
        rig.lastPaid.metal = buildable.paid.metal;

        const cap = commander.builder.constructionRate * dtSec;
        if (cap > 0) {
          targetRateE = Math.max(0, Math.min(1, dE / cap));
          targetRateM = Math.max(0, Math.min(1, dM / cap));
          targetRateT = Math.max(0, Math.min(1, dT / cap));
        }
      }
    } else {
      // Not actively building — drop the cached baseline so a future
      // build starts cleanly.
      rig.lastPaidTargetId = null;
    }

    this.updateConstructionTowerSpin(rig, spinActive, dtSec);
    this.blendSmoothedRates(rig.smoothedRates, targetRateE, targetRateM, targetRateT, rateAlpha);
    this.applyShowerFromSmoothedRates(rig);

    // Per-resource colored sprays from each pylon top to the build
    // target, intensity gated by smoothed rate. Skipped at low tiers
    // (matches factory's 'high' gate) and when no live target.
    if (
      buildingTierAtLeast(tier, 'high')
      && targetId !== null
      && commander.ownership
    ) {
      const target = this.clientViewState.getEntity(targetId);
      if (!target) return;
      rig.group.updateWorldMatrix(true, false);
      // Build target's bounding sphere — spray particles fill this
      // volume so they paint every part of the structure. Uses the
      // building's actual width/height/depth when present (so a long
      // factory and a small solar both get fully covered) and the
      // unit's body radius as a fallback for unit-shaped targets.
      let halfHeight = 8;
      let sphereRadius = 12;
      const b = target.building;
      if (b) {
        halfHeight = b.depth * 0.5;
        sphereRadius = Math.hypot(b.width, b.height, b.depth) * 0.5;
      } else if (target.unit) {
        halfHeight = target.unit.radius.body;
        sphereRadius = target.unit.radius.body;
      }
      this._factorySprayTargetWorld.set(
        target.transform.x,
        target.transform.z + halfHeight,
        target.transform.y,
      );
      this.emitPylonResourceSprays(
        rig,
        rig.group,
        commander.id,
        commander.ownership.playerId,
        target.id,
        this._factorySprayTargetWorld,
        sphereRadius,
      );
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
      && factory.isProducing;
    // Show the construction tower (the factory's "turret") during the
    // shell phase too — units render their turrets while being built,
    // so buildings should follow the same rule. applyShellOverride on
    // the parent group cascades into the rig's meshes, so the tower
    // reads as a translucent white shell until the building completes.
    // The tier check still gates marker-LOD (markerOnly forces tier='min',
    // which fails buildingTierAtLeast(tier, 'medium')); the !active
    // early-return below naturally suppresses sprays/showers for shells
    // because factory.isProducing is false until completion.
    rig.group.visible = buildingTierAtLeast(tier, 'medium');

    // EMA the live per-resource rate fractions toward the smoothed
    // values stored on the rig. Targets are 0 when the factory isn't
    // producing (so the showers + sprays fade out instead of popping
    // off). Rate fractions are 0..1.
    const dtSec = this._currentDtMs / 1000;
    const halfLife = BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE];
    const rateAlpha = halfLifeBlend(dtSec, halfLife);
    const targetEnergy = active ? Math.max(0, Math.min(1, factory?.energyRateFraction ?? 0)) : 0;
    const targetMana   = active ? Math.max(0, Math.min(1, factory?.manaRateFraction   ?? 0)) : 0;
    const targetMetal  = active ? Math.max(0, Math.min(1, factory?.metalRateFraction  ?? 0)) : 0;
    this.updateConstructionTowerSpin(rig, active, dtSec);
    this.blendSmoothedRates(rig.smoothedRates, targetEnergy, targetMana, targetMetal, rateAlpha);

    if (!active) {
      rig.unitGhost.visible = false;
      rig.unitCore.visible = false;
      for (const spark of rig.sparks) spark.visible = false;
      // Keep showers visible while the smoothed rate hasn't decayed
      // to ~0 yet so the fade-out reads. Once they're effectively
      // zero, hide entirely.
      this.applyShowerFromSmoothedRates(rig);
      return;
    }

    this.applyShowerFromSmoothedRates(rig);

    let blueprintRadius = Math.min(footprintW, footprintD) * 0.13;
    let buildSpotRadius = blueprintRadius;
    if (queuedUnitType) {
      try {
        const bp = getUnitBlueprint(queuedUnitType);
        blueprintRadius = bp.radius.body;
        buildSpotRadius = bp.radius.push;
      } catch {
        // Unknown queue ids should not break rendering; keep the generic bay ghost.
      }
    }

    // Outer ghost shell ("build bubble") — sized as a SPHERE at
    // BUILD_BUBBLE_RADIUS_PUSH_MULT × the queued unit's PUSH collider
    // radius, easing in with build progress and modulated by a small
    // breathing pulse for life. The original implementation grew the
    // bubble off the unit's body radius and stretched it into a flat
    // ellipsoid; the user pinned it to the push collider so the bubble
    // visually matches the footprint the unit will occupy after it
    // exits the factory bay.
    const targetGhostRadius = Math.max(8, buildSpotRadius * BUILD_BUBBLE_RADIUS_PUSH_MULT);
    const easedProgress = progress * progress * (3 - 2 * progress);
    const ghostScaleProgress = 0.28 + easedProgress * 0.72;
    const timeSec = this._lastSpinMs / 1000;
    const phase = timeSec * 4.7 + e.id * 0.19;
    const pulse = 1 + Math.sin(phase * 1.7) * 0.035;
    const ghostRadius = targetGhostRadius * ghostScaleProgress * pulse;
    // The remaining rig elements (core orb, travelling pulses,
    // sparks) keep their old per-blueprint sizing for now — they're
    // small relative to the outer shell, and locking them to the push
    // multiplier would visually swamp small units. `radius` below is
    // the legacy "rig radius" they lerp against.
    const maxBayRadius = Math.max(
      12,
      Math.min(getFactoryConstructionRadius() * 0.34, blueprintRadius * 1.35),
    );
    const baseRadius = Math.max(8, Math.min(maxBayRadius, blueprintRadius * 1.15));
    const radius = baseRadius * (0.28 + easedProgress * 0.72);
    const centerY = Math.max(5, ghostRadius * 0.68);
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

    // The build-bubble outer ghost and inner core orb were a visual
    // proxy for the unit being assembled; now that the actual unit
    // shell renders translucent in-place, the bubble obscures the
    // shell. Hide both meshes outright (positions/scales kept stable
    // so any unhide later reads coherent values, not stale zeros).
    rig.unitGhost.visible = false;
    rig.unitGhost.position.set(localSpotX, centerY, localSpotZ);
    rig.unitGhost.scale.setScalar(ghostRadius);

    rig.unitCore.visible = false;
    rig.unitCore.position.set(localSpotX, centerY + radius * 0.08, localSpotZ);
    rig.unitCore.scale.setScalar(Math.max(3, radius * 0.18));

    // Three colored build sprays — one per pylon top to the build
    // spot, intensity gated by that resource's smoothed transfer rate.
    // The sprays replace the single nozzle stream; each pylon now both
    // fills its shower bottom-up AND emits its colored particles
    // toward the forming unit.
    if (buildingTierAtLeast(tier, 'high') && e.ownership) {
      group.updateWorldMatrix(true, false);
      rig.group.updateWorldMatrix(true, false);
      this._factorySprayTargetLocal.set(localSpotX, centerY + radius * 0.06, localSpotZ);
      this._factorySprayTargetWorld
        .copy(this._factorySprayTargetLocal)
        .applyMatrix4(group.matrixWorld);
      this.emitPylonResourceSprays(
        rig,
        rig.group,
        e.id,
        e.ownership.playerId,
        e.id,
        this._factorySprayTargetWorld,
        radius,
      );
    }

    // Orbiting sparks were the small white spheres orbiting inside the
    // build bubble. Hidden alongside the bubble for the same reason —
    // the translucent unit shell now carries the in-progress reading.
    for (const spark of rig.sparks) spark.visible = false;
  }

  private updateProjectiles(): void {
    const projectiles = this.clientViewState.collectTravelingProjectiles(this._projectileRenderScratch);
    const seen = this._seenProjectileIds;
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const pruneProjectiles = entitySetVersion !== this.lastProjectileEntitySetVersion;
    if (pruneProjectiles) seen.clear();
    const sphereMesh = this.projectileSphereInstanced;
    const cylinderMesh = this.projectileCylinderInstanced;
    let sphereCount = 0;
    let cylinderCount = 0;
    // Hoist the per-frame range-toggle reads to once per call instead of
    // twice per projectile (was inside updateProjRadiusMeshes). Toggle
    // state is global so it can't change between projectiles within a
    // single frame, and at high projectile counts the dictionary read
    // for each toggle dominated the inner loop.
    const wantCol = getProjRangeToggle('collision');
    const wantExp = getProjRangeToggle('explosion');

    for (const e of projectiles) {
      if (pruneProjectiles) seen.add(e.id);
      // Hoist the transform reads once per projectile — used in
      // scope gate, position write, and (for cylinders) the orientation
      // basis. Property access on `e.transform` six times each frame
      // for thousands of in-flight shots adds up; one local-var copy
      // pays for the rest of the loop body.
      const tx = e.transform.x;
      const ty = e.transform.y;
      const tz = e.transform.z;
      // Scope gate — tighter padding (projectiles are small and moving fast).
      if (!this.scope.inScope(tx, ty, 50)) {
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
      if (shot && isProjectileShot(shot)) radius = shot.collision.radius;
      const radiusScale = PROJECTILE_RADIUS_BY_TIER[projectileGraphicsTier];
      const visualRadius = radius * radiusScale;
      const isCylinder = richProjectile
        && shot
        && isProjectileShot(shot)
        && shot.shape === 'cylinder';

      // Projectile altitude is authoritative sim state (arcs through
      // real z from turret muzzle to ground / target). SHOT_HEIGHT is
      // no longer the truth — the sphere renders exactly where the
      // sim says it is.
      this._projPos.set(tx, tz, ty);

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
        const cylSpec = (shot && isProjectileShot(shot)) ? shot.cylinderShape : undefined;
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
        this.updateProjRadiusMeshes(e, wantCol, wantExp);
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
    // This map is sparse, but avoid the walk on frames where the
    // network entity set did not change.
    if (pruneProjectiles) {
      for (const [id, radii] of this.projectileRadiusMeshes) {
        if (!seen.has(id)) {
          this.releaseProjRadiusMesh(radii.collision);
          this.releaseProjRadiusMesh(radii.explosion);
          this.projectileRadiusMeshes.delete(id);
        }
      }
      this.lastProjectileEntitySetVersion = entitySetVersion;
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
  private updateProjRadiusMeshes(
    entity: Entity,
    wantCol: boolean,
    wantExp: boolean,
  ): void {
    const proj = entity.projectile;
    if (!proj) return;
    const shot = proj.config.shot;
    if (!isProjectileShot(shot)) return;

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
    // Per-unit overlays (TURR RAD rings, BLD ring, BODY + PUSH rings)
    // are parented to the world group rather than the unit group so
    // they stay flat on the ground regardless of unit rotation /
    // altitude — destroy() has to release them explicitly.
    for (const m of this.unitMeshes.values()) {
      destroyLocomotion(m.locomotion, this.legRenderer);
      this.world.remove(m.group);
      this.disposeWorldParentedOverlays(m);
    }
    // Renderer-wide teardown — drop every cached leg snapshot, no
    // future build will consume them.
    this.legStateCache.clear();
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
    this.barrelSpins.clear();
    this._seenUnitIds.clear();
    this._seenBuildingIds.clear();
    this._seenProjectileIds.clear();
    this.projectileRadiusMeshes.clear();
    this.projectileRadiusMeshPool.length = 0;
    this.factorySprayTargets.length = 0;
    this.factorySprayTargetPool.length = 0;
    // Polygonal-chassis pools must tear down BEFORE disposeBodyGeoms().
    // Each pool owns an instanced-only clone of the BodyShape3D cached
    // geometry, so dispose that clone here; BodyShape3D still disposes
    // the original cached geometry immediately below.
    for (const pool of this.polyChassis.values()) {
      this.world.remove(pool.mesh);
      pool.mesh.geometry.dispose();
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
    this.ringMatEngageMinAcquire.dispose();
    this.ringMatEngageMinRelease.dispose();
    this.ringMatBuild.dispose();
    this.selectionRingMat.dispose();
    this.projMatCollision.dispose();
    this.projMatExplosion.dispose();
    this.mirrorGeom.dispose();
    this.mirrorArmGeom.dispose();
    this.mirrorSupportGeom.dispose();
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
    this.clearMassRichUnits();
    this.unitInstancedEntityBySlot.length = 0;
    this.unitInstancedFreeSlots.length = 0;
    this.unitInstancedCompactFrame = 0;
    this.unitInstancedFrame = 0;
    this.unitInstancedLastFullPassFrame = -1;
    this.unitInstancedLastFullPassEntitySetVersion = -1;
    this.unitInstancedLastFullPassLodKey = '';
    this.unitInstancedLastFullPassCellSize = 0;
    this.unitInstancedLastFullPassCameraCellX = 0;
    this.unitInstancedLastFullPassCameraCellY = 0;
    this.unitInstancedActiveUnits.length = 0;
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
    this.smoothChassisColorKey.clear();
    this.smoothChassisFreeSlots.length = 0;
    if (this.turretHeadInstanced) {
      this.world.remove(this.turretHeadInstanced);
      // Material and geometry are private to the InstancedMesh.
      this.turretHeadInstanced.geometry.dispose();
      (this.turretHeadInstanced.material as THREE.Material).dispose();
      this.turretHeadInstanced.dispose();
      this.turretHeadInstanced = null;
    }
    this.turretHeadFreeSlots.length = 0;
    this.turretHeadColorKey.clear();
    if (this.barrelInstanced) {
      this.world.remove(this.barrelInstanced);
      // Instanced barrels own their cloned geometry and patched
      // material; per-Mesh fallback barrels use barrelGeom/barrelMat.
      this.barrelInstanced.geometry.dispose();
      (this.barrelInstanced.material as THREE.Material).dispose();
      this.barrelInstanced.dispose();
      this.barrelInstanced = null;
    }
    this.barrelFreeSlots.length = 0;
    if (this.mirrorPanelInstanced) {
      this.world.remove(this.mirrorPanelInstanced);
      // Material and geometry are private to the InstancedMesh.
      this.mirrorPanelInstanced.geometry.dispose();
      (this.mirrorPanelInstanced.material as THREE.Material).dispose();
      this.mirrorPanelInstanced.dispose();
      this.mirrorPanelInstanced = null;
    }
    this.mirrorPanelFreeSlots.length = 0;
    this.mirrorPanelColorKey.clear();
  }
}
