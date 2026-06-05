import type * as THREE from 'three';
import type { UnitBodyShape } from '@/types/blueprints';
import type { PlayerId } from '../sim/types';
import type { Locomotion3DMesh } from './Locomotion3D';
import type { TurretMesh } from './TurretMesh3D';
import type { ShieldPanelMesh } from './ShieldPanelMesh3D';
import type {
  BuildingDetailMesh,
  ExtractorRig,
  FactoryBuildSpotRig,
  RadarRig,
  ResourceConverterRig,
  WindTurbineRig,
} from './BuildingShape3D';
import type { SolarRig } from './SolarCollectorMesh3D';

export type RadiusRingMeshes = {
  visual?: THREE.LineSegments;
  hitbox?: THREE.LineSegments;
  collision?: THREE.LineSegments;
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
   *  level. The BODY (chassis, turrets, mirrors, shield) lives
   *  inside `liftGroup` which is itself inside yawGroup but offset
   *  upward — so the locomotion stays on the ground while the body
   *  is held aloft, like a vehicle riding on its wheels.
   *  Undefined for buildings (no tilt / yaw plumbing). */
  yawGroup?: THREE.Group;
  /** Lift subgroup. Sits inside `yawGroup` with a positive Y offset
   *  (`Locomotion3D.getChassisLift(blueprint, unitRadius)`) — chassis,
   *  turret roots, shield panels, and shield meshes all parent
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
   *  snipe, commander, shield, loris); undefined for polygon /
   *  rect bodies, which use polyChassisSlot. */
  smoothChassisSlots?: number[];
  /** Single slot index into the body-shape keyed polygonal-chassis
   *  InstancedMesh pool. Present on polygon / rect units; undefined for
   *  smooth bodies, which use smoothChassisSlots. */
  polyChassisSlot?: number;
  /** Cached body-shape key resolved once at mesh-build time. The unit's
   *  bodyShape is the authored source; this key only identifies the
   *  matching instanced geometry pool. */
  bodyShapeKey: string;
  bodyShape?: UnitBodyShape;
  turrets: TurretMesh[];
  mirrors?: ShieldPanelMesh;
  locomotion?: Locomotion3DMesh;
  /** Selection ring mesh — material/geometry are owned by
   *  SelectionOverlayRenderer3D, so we don't store a per-unit material
   *  reference. The mesh itself lives under `m.group` and is GC'd with
   *  the group on death. */
  ring?: THREE.Mesh;
  /** UNIT SPH wireframe spheres. All three channels are now 3D in
   *  the sim:
   *    - visual    → unit.radius.visual, the drawn body footprint.
   *    - hitbox    → 3D swept + area-damage check (lineSphereIntersectionT
   *      + sqrt(dx²+dy²+dz²) in DamageSystem).
   *    - collision → full 3D sphere-vs-sphere contact in PhysicsEngine3D.
   *
   *  Meshes are created lazily on first show and hidden (not destroyed)
   *  when toggled off. All three parent to the unit group at local
   *  y = collision radius so the sphere center sits on the unit's sim
   *  sphere center and rides along with altitude changes. */
  radiusRings?: RadiusRingMeshes;
  radiusRingsVisible?: boolean;
  /** Builder-unit BLD ground-plane circle. Build range is a 2D
   *  horizontal check, so this lives at the local terrain surface and
   *  draws as a fixed-width ground ribbon instead of a 3D sphere. */
  buildRing?: RangeRingMesh;
  /** Radar-building ground-plane circle. This previews the visual fog
   *  clearing radius without changing snapshot semantics. */
  radarRing?: RangeRingMesh;
  rangeRingsVisible?: boolean;
  /** Per-building accent meshes (chimney, solar cells, etc.). Tracked
   *  so rebuilds / destroy() know what to clean up alongside the primary
   *  body. Empty / undefined for units. */
  buildingDetails?: BuildingDetailMesh[];
  factoryBuildSpotRig?: FactoryBuildSpotRig;
  windRig?: WindTurbineRig;
  extractorRig?: ExtractorRig;
  solarRig?: SolarRig;
  radarRig?: RadarRig;
  converterRig?: ResourceConverterRig;
  /** Per-building render height (solar is shorter than the default). */
  buildingHeight?: number;
  /** True when the building primary mesh owns its material and should
   *  not be recolored to team primary on ownership updates. */
  buildingPrimaryMaterialLocked?: boolean;
  /** True for hosts that render no body shell at all. The primary mesh
   *  is kept for bookkeeping but stays hidden and unscaled. */
  buildingBodyless?: boolean;
  solarOpenAmount?: number;
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
  /** Geometry key this unit was built at. Render3DEntities rebuilds
   *  the mesh when graphics-shape settings differ. */
  geometryKey: string;
  /** Unit render-key components cached separately so the per-frame
   *  unit loop can compare cheap primitives without rebuilding the
   *  full template-string key for every unchanged unit. */
  unitRenderFrameKey?: string;
  unitRenderOwnerId?: PlayerId;
  /** Per-Mesh fallback head-only turrets switch material when engaged.
   *  Instanced heads carry this through instanceColor; this cache keeps
   *  the rare per-Mesh fallback path from rewriting materials every
   *  frame when the state has not changed. */
  unitHeadOnlyTurretEngaged?: boolean[];
  /** Cached color for per-Mesh dynamic turret heads, currently shield
   *  sphere emitter cores. Instanced heads carry this through
   *  instanceColor instead. */
  unitDynamicTurretHeadColorHex?: number[];
  /** Set when the sim reports this unit was DESTROYED (a 'death' SimEvent),
   *  as opposed to merely leaving the local player's vision. Read once when
   *  the mesh leaves the live set (Render3DEntities removal sweep): killed
   *  units play the scatter + death-fade; units that just lost vision fade
   *  out quietly in place. */
  killed?: boolean;
  /** Whether a per-Mesh group fade clone is currently installed on
   *  this unit. Used to restore real materials exactly once when
   *  construction/death fade returns to full opacity. */
  unitGroupFadeActive?: boolean;
  unitTurretGroupFadeActive?: boolean[];
  /** Smoothed visual bank angle (radians, sim-frame: positive rolls
   *  the body-+Y wing down) for hover/flying chassis. EMA-tracked at
   *  render cadence from body-lateral centripetal acceleration
   *  (v_forward · ω_z); never crosses the wire, never read by sim
   *  code. Undefined for ground units.
   *  See the "Airborne Banking Is Visual" section of
   *  design_philosophy.html. */
  visualBankRoll?: number;
};
