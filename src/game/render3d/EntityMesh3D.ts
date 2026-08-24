import type * as THREE from 'three';
import type { UnitBodyShape } from '@/types/blueprints';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import type { PlayerId } from '../sim/types';
import type { Locomotion3DMesh } from './Locomotion3D';
import type { EntityBuildVisual } from './EntityFade3D';
import type { TurretMesh } from './TurretMesh3D';
import type { GroundRing3D } from './GroundRing3D';
import type { ShieldPanelMesh } from './ShieldPanelMesh3D';
import type {
  BuildingDetailMesh,
  ExtractorRig,
  RadarRig,
  ResourceConverterRig,
  WindTurbineRig,
} from './BuildingShape3D';
import type { SolarRig } from './SolarCollectorMesh3D';
import type { HostOrnamentProfile } from './TeamOrnament3D';
import type { EntityDeathBlast3D } from './EntityDeathDisassembly3D';
import type { BuildingOperationalRig } from './BuildingOperationalRig3D';

/** One wireframe per debug-volume category the host actually carries.
 *  Keys mirror the unified VOLUMES bar group (`VolumeType`) exactly —
 *  one shape per concept, no companions. */
export type RadiusRingMeshes = {
  selection?: THREE.LineSegments;
  hit?: THREE.LineSegments;
  collision?: THREE.LineSegments;
  arming?: THREE.LineSegments;
};


export type EntityMesh = {
  group: THREE.Group;
  /** Renderer-owned visibility token for scoped render pruning. Live rows
   *  stamp the current token; meshes with an older token are outside the
   *  active render scope and can be torn down without querying view state. */
  renderSeenToken?: number;
  /** True while this entity is represented by the renderer-wide LOD
   *  hitbox proxy instead of its full detail mesh. The detailed mesh is
   *  retained so crossing back under the threshold can resume without a
   *  rebuild. */
  renderLodProxyActive?: boolean;
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
  /** This host stands upright: it poses off world vertical rather than off the
   *  terrain normal, and ignores its body quaternion.
   *
   *  A biped does not lean into a hill — it takes the slope up in its legs,
   *  which is exactly what the stand rig's per-foot terrain reach is for. Left
   *  tilting, a walking commander leans back going uphill while its feet stay
   *  flat on it, and the two read as a mistake in opposite directions. */
  uprightPose?: boolean;
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
  /** Detail tier this mesh's geometry was built at. Bespoke ornament pools
   *  allocate at the same tier, so a unit's trim always matches the body it
   *  is bolted to — and a rung change rebuilds the mesh, which re-allocs
   *  the trim into the new tier's pool. */
  geometryTier?: PrimitiveGeometryTier;
  bodyShape?: UnitBodyShape | null;
  /** Cached close-tier getBodyGeom entry for bodyShape — the lookup keys
   *  on a JSON-ish string of the whole body spec, which is too hot for a
   *  per-unit per-frame call. Invalidate alongside bodyShape. */
  bodyGeomEntryCache?: import('./BodyShape3D').BodyGeomEntry | null;
  /** Transport carry-expansion factor (1 = at rest); smoothed by the
   *  pose loop while the beam holds or releases a unit. */
  carryScale?: number;
  turrets: TurretMesh[];
  mirrors?: ShieldPanelMesh;
  locomotion?: Locomotion3DMesh;
  /** Selection ring mesh — material/geometry are owned by
   *  SelectionOverlayRenderer3D, so we don't store a per-unit material
   *  reference. The mesh itself lives under `m.group` and is GC'd with
   *  the group on death. */
  ring?: GroundRing3D;
  /** UNIT SPH wireframe spheres. All three channels are now 3D in
   *  the sim:
   *    - other     → unit.radius.other, the drawn body footprint.
   *    - hitbox    → 3D swept + area-damage check (lineSphereIntersectionT
   *      + sqrt(dx²+dy²+dz²) in DamageSystem).
   *    - collision → full 3D sphere-vs-sphere contact in PhysicsEngine3D.
   *
   *  Meshes are created lazily on first show and hidden (not destroyed)
   *  when toggled off. All three parent to the unit group at local
   *  y = collision radius so the sphere center sits on the unit's sim
   *  sphere center and rides along with altitude changes. */
  /** Slot in the team-ornament pools holding this unit's rail-and-rib kit.
   *  The slot encodes which pool, so one field covers every body profile. */
  teamTrimSlot?: number;
  /** The kit's fit for this unit, derived from its body once and cached —
   *  the pose pass runs every frame and the body's extents do not change. */
  teamTrimProfile?: HostOrnamentProfile;
  radiusRings?: RadiusRingMeshes;
  radiusRingsVisible?: boolean;
  /** Builder-unit BLD ground-plane circle. Build range is a 2D
   *  horizontal check, so this lives at the local terrain surface and
   *  draws as a fixed-width ground ribbon instead of a 3D sphere. */
  buildRing?: GroundRing3D;
  /** Radar-building ground-plane circle. This previews the visual fog
   *  clearing radius without changing snapshot semantics. */
  radarRing?: GroundRing3D;
  /** Reclaim-mode ground highlight for reclaimable entities. It is
   *  world-parented like range rings so it follows terrain height. */
  reclaimRing?: GroundRing3D;
  rangeRingsVisible?: boolean;
  /** Per-building accent meshes (chimney, solar cells, etc.). Tracked
   *  so rebuilds / destroy() know what to clean up alongside the primary
   *  body. Empty / undefined for units. */
  buildingDetails?: BuildingDetailMesh[];
  buildingTurretHostPieces?: Array<{
    pieceId: string;
    root: THREE.Group;
    pitchRoot?: THREE.Group;
    ownerTurretIndex: number;
  }>;
  /** Authored, building-specific pieces that carry ally-team identity.
   * May include descendants nested under an animation rig. */
  buildingTeamOrnaments?: THREE.Mesh[];
  /** Last ally-team colour applied to the authored building ornaments. */
  buildingTeamOrnamentColorHex?: number;
  /** Authored pieces that carry the OWNER's body colour. Used by hosts whose
   * primary chassis is material-locked art and therefore cannot. */
  buildingPlayerColorMeshes?: THREE.Mesh[];
  windRig?: WindTurbineRig;
  extractorRig?: ExtractorRig;
  solarRig?: SolarRig;
  radarRig?: RadarRig;
  converterRig?: ResourceConverterRig;
  buildingOperationalRig?: BuildingOperationalRig;
  /** Per-building render height (solar is shorter than the default). */
  buildingHeight?: number;
  /** True when the building primary mesh owns its material and should
   *  not be recolored to team primary on ownership updates. */
  buildingPrimaryMaterialLocked?: boolean;
  /** True for hosts that render no body shell at all. The primary mesh
   *  is kept for bookkeeping but stays hidden and unscaled. */
  buildingBodyless?: boolean;
  solarOpenAmount?: number;
  solarPetalPoseAmount?: number;
  buildingOperationalAmount?: number;
  buildingOperationalMotionTime?: number;
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
  buildingRangeOverlayVersion?: number;
  buildingUnitOverlayVersion?: number;
  /** Last construction/body opacity received from a building render row.
   *  Building rows are dirty-driven, so the vision fade queue reuses this
   *  value on frames where the entity itself did not need a row. */
  buildingMaterializationOpacity?: number;
  buildingGroupFadeActive?: boolean;
  buildingHasPerFrameTurretWork?: boolean;
  buildingRenderFrameKey?: string;
  buildingRenderBlueprintId?: string | null;
  buildingRenderTurretCount?: number;
  /** Authored local footprint dimensions. Runtime collision dimensions are
   * world-axis-aligned and swap on odd quarter turns; meshes rotate these
   * unswapped dimensions instead. */
  buildingLocalWidth?: number;
  buildingLocalDepth?: number;
  /** Native plan-view yaw supplied by BuildingShape3D. */
  buildingAuthoredYaw?: number;
  buildingRenderDetailBand?: number;
  /** True while the detail rung has this building's animators + gatling
   *  spin frozen (live gate, no rebuild). */
  buildingAnimationsGated?: boolean;
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
  unitRenderBlueprintId?: string;
  unitRenderTurretCount?: number;
  /** Binary detail band this mesh was built at. In AUTO, units are either
   *  full-detail meshes or proxy glyphs; this is kept as a cheap rebuild key
   *  for explicit HIGH/LOW and future config changes. */
  unitRenderDetailBand?: number;
  /** Cached color for per-Mesh dynamic turret heads, currently shield
   *  sphere emitter cores. Instanced heads carry this through
   *  instanceColor instead. */
  unitDynamicTurretHeadColorHex?: number[];
  /** Cached answer for whether this unit has material state that must
   *  animate even when the snapshot/render row is otherwise steady. */
  unitHasSteadyDynamicMaterialWork?: boolean;
  unitOverlayVersion?: number;
  /** Set when the sim reports this entity was DESTROYED (a 'death' SimEvent),
   *  as opposed to merely leaving the local player's vision. Read when the
   *  render removal queue drops the mesh from the live set: killed units play
   *  the scatter + death-fade, killed buildings/towers play the same per-piece
   *  scatter + death-fade, and entities that just lost vision fade out quietly
   *  while coasting. */
  killed?: boolean;
  /** Killing-blow motion consumed only by the death disassembly. Undefined
   *  keeps the ordinary intact death fade (for example when the client-side
   *  material-explosion toggle is off). */
  deathBlast?: EntityDeathBlast3D;
  /** Effective opacity most recently written to the entity's rendered parts.
   *  A vision/death fade-out starts here instead of forcing opacity back to
   *  one, which keeps a removal continuous when it interrupts a fade-in or
   *  construction materialization. */
  entityLifecycleFade?: number;
  /** Whether a per-Mesh group fade clone is currently installed on
   *  this unit. Used to restore real materials exactly once when
   *  construction/death fade returns to full opacity. */
  unitGroupFadeActive?: boolean;
  /** Reusable nanoframe band parameters while this entity is under
   *  construction (see EntityFade3D). Mutated in place each frame so
   *  the steady-state build loop allocates nothing. */
  entityBuildVisual?: EntityBuildVisual;
  /** Cached visual height (world units) and group-local base offset for
   *  normalizing nanoframe band height. Computed once per mesh from its
   *  bounding box the first frame it renders under construction. */
  buildVisualHeight?: number;
  buildVisualBaseOffsetY?: number;
  /** Whether instanced body/turret/mirror slots or leg slots are carrying
   *  a non-opaque materialization fade. Used to restore those slots to
   *  opacity 1 exactly once, then skip steady-state fade writes. */
  unitFadeActive?: boolean;
  unitTurretGroupFadeActive?: boolean[];
  /** Last visible linear velocity mapped into Three world axes. When a unit
   *  leaves vision, its retained render mesh coasts at this velocity for the
   *  short alpha fade without advancing or mutating simulation state. */
  unitPresentationVelocityX?: number;
  unitPresentationVelocityY?: number;
  unitPresentationVelocityZ?: number;
  /** Smoothed visual bank angle (radians, sim-frame: positive rolls
   *  the body-+Y wing down) for drone/airframe chassis. EMA-tracked at
   *  render cadence from body-lateral centripetal acceleration
   *  (v_forward · ω_z); never crosses the wire, never read by sim
   *  code. Undefined for ground units.
   *  See the "Airborne Banking Is Visual" section of
   *  budget_design_philosophy.html. */
  visualBankRoll?: number;
};
