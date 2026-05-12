import type * as THREE from 'three';
import type { UnitBodyShape } from '@/types/blueprints';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import type { PlayerId } from '../sim/types';
import type { Locomotion3DMesh } from './Locomotion3D';
import type { TurretMesh } from './TurretMesh3D';
import type { MirrorMesh } from './MirrorMesh3D';
import type {
  BuildingDetailMesh,
  ExtractorRig,
  FactoryConstructionRig,
  WindTurbineRig,
} from './BuildingShape3D';
import type { SolarRig } from './SolarCollectorMesh3D';
import type { RenderObjectLodTier } from './RenderObjectLod';

export type RadiusRingMeshes = {
  scale?: THREE.LineSegments;
  shot?: THREE.LineSegments;
  push?: THREE.LineSegments;
};

export type RangeRingMesh = THREE.Mesh & {
  userData: THREE.Object3D['userData'] & {
    radius?: number;
    ribbon?: unknown;
  };
};

export type EntityMesh = {
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
  /** Selection ring mesh — material/geometry are owned by
   *  SelectionOverlayRenderer3D, so we don't store a per-unit material
   *  reference. The mesh itself lives under `m.group` and is GC'd with
   *  the group on death. */
  ring?: THREE.Mesh;
  /** Outer camera-sphere marker for buildings. Units use the packed
   *  mass InstancedMesh for the same role; buildings need a tiny mesh
   *  because their normal render path is type-specific scenegraph art. */
  lodMarker?: THREE.Mesh;
  /** UNIT SPH wireframe spheres. All three channels are now 3D in
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
  radiusRings?: RadiusRingMeshes;
  radiusRingsVisible?: boolean;
  /** Builder-unit BLD ground-plane circle. Build range is a 2D
   *  horizontal check, so this lives at the local terrain surface and
   *  draws as a fixed-width ground ribbon instead of a 3D sphere. */
  buildRing?: RangeRingMesh;
  rangeRingsVisible?: boolean;
  /** Per-building accent meshes (chimney, solar cells, etc.). Tracked
   *  so rebuilds / destroy() know what to clean up alongside the primary
   *  body. Empty / undefined for units. */
  buildingDetails?: BuildingDetailMesh[];
  factoryRig?: FactoryConstructionRig;
  windRig?: WindTurbineRig;
  extractorRig?: ExtractorRig;
  solarRig?: SolarRig;
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
  /** Whether this foreign building rendered last frame as a fog-of-war
   *  ghost (no current local-player vision covering it). Drives the
   *  material swap to the desaturated ghost variant — flagged as a
   *  cache key so that toggling vision in/out of the building re-runs
   *  updateBuildingMesh. */
  buildingCachedIsGhost?: boolean;
  unitDetailCachedX?: number;
  unitDetailCachedY?: number;
  unitDetailCachedZ?: number;
  unitDetailCachedRotation?: number;
  /** The LOD key this unit's geometry was built at. Render3DEntities rebuilds
   *  the mesh when the current frame's LOD key differs. */
  lodKey: string;
};
