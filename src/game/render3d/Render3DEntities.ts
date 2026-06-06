// Render3DEntities — extrudes the 2D sim primitives into 3D shapes.
//
// - Units:        cylinder (radius from unit.radius.visual, height ∝ radius)
// - Turrets:      one per entry in entity.combat.turrets, positioned at the
//                 blueprint-authored chassis-local 3D mount, rotated to
//                 the turret's firing angle, with white barrel cylinders.
// - Buildings:    box (width/height from building component, y-depth ∝ scale)
// - Projectiles:  small sphere (radius from projectile collision)
//
// Coordinate mapping: sim (x, y) → three (x, z). Y is up. Ground at y=0.

import * as THREE from 'three';
import type { Entity, EntityId, PlayerId, Turret } from '../sim/types';
import type { PylonTubeFlow, SprayTarget } from '@/types/ui';
import type { MetalDeposit } from '../../metalDepositConfig';
import { COLORS } from '@/colorsConfig';
import { getPlayerColors } from '../sim/types';
import { GRAVITY } from '../../config';
import type { ClientViewState } from '../network/ClientViewState';
import {
  updateLocomotion,
  destroyLocomotion,
  fadeLocomotion,
  translateLocomotion,
  captureLegState,
  type LegStateSnapshot,
} from './Locomotion3D';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import {
  createRenderFrameState,
  snapshotRenderFrameState,
  type RenderFrameState3D,
} from './RenderFrameState3D';
import { getBodyGeom, disposeBodyGeoms } from './BodyShape3D';
import {
  disposeBuildingGeoms,
} from './BuildingShape3D';
import type { ViewportFootprint } from '../ViewportFootprint';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';
import {
  getConstructionPieceOpacity,
  isBuildInProgress,
  isConstructionPieceMaterialized,
} from '../sim/buildableHelpers';
import { ProjectileRenderer3D } from './ProjectileRenderer3D';
import { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';
import { ConstructionVisualController3D } from './ConstructionVisualController3D';
import { CommanderVisualKit3D } from './CommanderVisualKit3D';
import type { EntityMesh } from './EntityMesh3D';
import { BuildingEntityRenderer3D } from './BuildingEntityRenderer3D';
import {
  entityShieldSphereTurretHeadColorHex,
  turretAccentColorHexForPlayer,
} from './EntityInstanceColor3D';
import { UnitDetailInstanceRenderer3D, type DyingUnitPartDelta } from './UnitDetailInstanceRenderer3D';
import {
  applyEntityGroupFade,
  disposeEntityGroupFade,
  DyingMeshFade,
  ENTITY_DEATH_FADE_MS,
} from './EntityFade3D';
import { VISION_FADE_IN_MS, VISION_FADE_OUT_MS } from '@/visionConfig';
import { createShieldFallbackPanelMaterial } from './ShieldReflectorVisual3D';
import { ProjectileRangeEnvelope3D } from './ProjectileRangeEnvelope3D';
import { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';
import { TurretMountCache3D, type TurretMountEntry } from './TurretMountCache3D';
import { TurretBeamAimCache3D } from './TurretBeamAimCache3D';
import { ShieldPanelPose3D } from './ShieldPanelPose3D';
import { UnitChassisInstancePose3D } from './UnitChassisInstancePose3D';
import { UnitTurretPose3D } from './UnitTurretPose3D';
import { applyUnitLiftGroupPose3D, UnitMeshBuilder3D } from './UnitMeshBuilder3D';
import type { SmokePuffEmitter } from './SmokeTrail3D';
import { refreshLocomotionSupportSurfaces } from './LocomotionTerrainSampler';
import {
  UnitRenderPacket3D,
  type BuildingRenderPacket3D,
} from './EntityRenderPackets3D';

// Turret head height is the one remaining shared vertical constant —
// chassis heights are now per-unit (see getBodyTopY in BodyDimensions.ts).
// The sim's projectile-spawn point is the turret world mount center;
// barrel endpoint geometry is visual-only.

const BARREL_COLOR = COLORS.units.turret.barrel.colorHex;

// Visual-only bank for hover/flying chassis. The sim writes yaw-only
// into the orientation quat (see UnitForceSystem hover branch); the
// renderer composes a body-frame roll on top from the body-lateral
// acceleration the chassis is experiencing. None of this state
// crosses the wire or feeds sim math — the y=z=0 mount invariant on
// airborne turrets keeps the rolled chassis agreeing with the sim's
// yaw-only mount math.
//
// We bank on centripetal acceleration (forward speed × yaw rate)
// rather than lateral velocity: the yaw spring continuously aligns
// body forward with the thrust direction, so in a sustained turn the
// body-lateral velocity collapses to ~0 and a velocity-derived bank
// would decay to flat right when the visible turn is at its strongest.
// `v_forward · ω_z` stays high for as long as the unit is actually
// turning, so the bank persists through the turn.
//
// AIRBORNE_BANK_PER_LATERAL_A is dimensionless (radians of roll per
// (world-unit/sec) · (rad/sec) of body-lateral acceleration);
// AIRBORNE_BANK_MAX clamps to 45° so collision spikes can't turn
// into barrel rolls.
const AIRBORNE_BANK_PER_LATERAL_A = 0.003;
const AIRBORNE_BANK_MAX = Math.PI * 0.25;
// EMA time constant in seconds. Intentionally independent from ROT POS:
// banking is a local acceleration-derived embellishment that never
// travels on the wire.
const AIRBORNE_BANK_TAU_SEC = 0.18;
const EMPTY_TURRETS: readonly Turret[] = [];

const DEATH_SCATTER_SPEED_MIN = 26;
const DEATH_SCATTER_SPEED_RANGE = 70;
const DEATH_SCATTER_UP_MIN = 24;
const DEATH_SCATTER_UP_RANGE = 64;
const DEATH_SCATTER_BODY_SPEED_SCALE = 0.5;
const DEATH_SCATTER_LOCOMOTION_SPEED_SCALE = 0.85;
const DEATH_SCATTER_ANGULAR_INIT = 5.5;
const DEATH_SCATTER_LINEAR_DRAG = 0.965;
const DEATH_SCATTER_ANGULAR_DRAG = 0.92;
const DEATH_SCATTER_GRAVITY_SCALE = 0.45;

type DyingUnitPartMotion = {
  vx: number;
  vy: number;
  vz: number;
  avx: number;
  avy: number;
  avz: number;
};

type DyingUnitScatter = {
  body: DyingUnitPartMotion;
  locomotion?: DyingUnitPartMotion;
  turrets: DyingUnitPartMotion[];
};

function createDyingUnitPartDelta(): DyingUnitPartDelta {
  return { dx: 0, dy: 0, dz: 0, drx: 0, dry: 0, drz: 0 };
}

export type RenderEntityUpdatePacket3D = {
  unitRows: UnitRenderPacket3D;
  buildingRows: BuildingRenderPacket3D;
  beamAimProjectiles?: readonly Entity[];
  scoped: boolean;
};

// Shared Y-up axis for manual instanced transform composition.
const _INST_UP = new THREE.Vector3(0, 1, 0);

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
// Force-field panels (reflective mirror-unit armor plates) are square slabs
// mounted at the rigid mirror-arm's far end. The cache in
// shieldPanelCache.ts computes baseY/topY/halfWidth from the turret's
// mount.z + radius.visual scaled by SHIELD_PANEL_SIZE_MULT; both the
// renderer and the sim's beam-reflection tracer read those cached
// fields so the visible mesh and the collision rectangle stay in sync.

export class Render3DEntities {
  private world: THREE.Group;
  private clientViewState: ClientViewState;
  private camera: THREE.PerspectiveCamera;
  private getViewportHeight: () => number;
  private metalDeposits: readonly MetalDeposit[];
  /** Visibility scope (RENDER: WIN/PAD/ALL). Unit pose, locomotion,
   *  and turret updates intentionally ignore this so camera distance
   *  cannot change their update cadence. Effect/projectile renderers
   *  still use it for visual-only culling. */
  private scope: ViewportFootprint;
  /** Shared instanced cylinder pool for every leg in the scene.
   *  Flushed once per frame after every unit's locomotion has
   *  written into it; the GPU then draws all leg cylinders in 2
   *  draw calls (upper + lower). */
  private legRenderer!: LegInstancedRenderer;

  private unitMeshes = new Map<number, EntityMesh>();
  // Shared death-out flow: a dying unit's mesh is kept (instanced slots
  // allocated, pose frozen) and its materialization fade ramped 1 → 0
  // before teardown, so the body/turrets/locomotion scatter and fade while
  // Debris3D flings its material pieces and Explosion3D fires the blast.
  // Same controller buildings use — see EntityFade3D. Assigned in the
  // constructor (needs `this`).
  private dyingUnits!: DyingMeshFade<EntityMesh>;
  // Units that left the local player's VISION (not killed). Same fade
  // controller, but a plain alpha fade-out with no scatter/explosion and
  // its own VISION_FADE_OUT_MS clock. Assigned in the constructor.
  private vanishingUnits!: DyingMeshFade<EntityMesh>;
  private readonly dyingUnitScatter = new WeakMap<EntityMesh, DyingUnitScatter>();
  /** Per-entity vision fade-IN clock (ms elapsed, 0..VISION_FADE_IN_MS) for
   *  units that have newly entered vision. Keyed by entity id so it survives
   *  mesh rebuilds (LOD / owner recolor) and only resets when the unit truly
   *  leaves the live set, so re-entering vision fades in afresh. */
  private readonly spawnFadeElapsed = new Map<EntityId, number>();
  // Reusable per-entity turret fade buffer — avoids a fresh array per
  // unit per frame in the build-in materialization write.
  private _turretFadeScratch: number[] = [];
  private readonly _turretScatterScratch: DyingUnitPartDelta[] = [];
  private readonly _deathScatterBodyDelta = createDyingUnitPartDelta();
  private readonly _deathScatterLocomotionDelta = createDyingUnitPartDelta();
  // Reusable "seen this frame" set for unit pruning. Keeping it as an
  // instance field and calling `.clear()` avoids a fresh Set allocation
  // every render frame.
  private _seenUnitIds = new Set<EntityId>();
  private projectileRenderer: ProjectileRenderer3D;
  private selectionOverlays: SelectionOverlayRenderer3D;
  private constructionVisuals: ConstructionVisualController3D;
  private buildingRenderer: BuildingEntityRenderer3D;
  private unitDetailInstances: UnitDetailInstanceRenderer3D;
  private unitMeshBuilder!: UnitMeshBuilder3D;
  private projectileRangeEnvelope: ProjectileRangeEnvelope3D;
  private readonly hoverSmokeEmitters: SmokePuffEmitter[] = [];

  private barrelSpinState = new UnitBarrelSpinState3D();
  private shieldPanelPose = new ShieldPanelPose3D();
  private chassisInstancePose = new UnitChassisInstancePose3D();
  private turretPose = new UnitTurretPose3D();
  private readonly fallbackUnitRenderRows = new UnitRenderPacket3D();

  // Per-entity leg-state snapshots stashed right before a mesh teardown
  // mesh teardown and consumed immediately after rebuild, so feet keep
  // their world-space planted positions instead of snapping to rest.
  private legStateCache = new Map<EntityId, LegStateSnapshot>();

  // Per-frame graphics state.
  private frameState: RenderFrameState3D = createRenderFrameState();

  // Shared geometries & per-team materials (avoid per-entity allocation).
  // Unit chassis geometries are body-shape keyed and handled by BodyShape3D.
  // Sphere (not cylinder) so the barrels can pivot freely in any
  // direction — the head reads as a turret ball the barrels swing
  // around, letting pitch aim up toward AA targets without the
  // barrels clipping through a flat cylinder top.
  private turretHeadGeom = new THREE.SphereGeometry(1, 16, 12);
  private commanderVisualKit = new CommanderVisualKit3D();
  private barrelGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  // Beam-turret barrels taper to a point at the muzzle (+Y = tip).
  private coneBarrelGeom = new THREE.CylinderGeometry(0, 1, 1, 10);
  private barrelMat = new THREE.MeshLambertMaterial({ color: BARREL_COLOR });
  // Force-field panel = flat unit square plane. Default orientation: face
  // in XY plane with normal +Z; we rotate it into the panel-local frame
  // (edge → +Z, normal → +X) per panel below. The mesh is a thin BoxGeometry
  // so the mirror reads as a slab with a hint of depth; the slab is
  // centered on the sim collision plane (depth distributed equally to
  // both sides) so the visible surface and the sim rectangle still share
  // the same center plane.
  private mirrorGeom = new THREE.BoxGeometry(1, 1, 1);
  private mirrorArmGeom = new THREE.BoxGeometry(1, 1, 1);
  private mirrorSupportGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
  // Unit-radius indicator wireframe spheres (VISUAL/HITBOX/COLLISION). Unit
  // radius = 1 → scale per mesh to the actual collider radius. The
  // sim's hit-detection uses 3D spheres centered on transform.z, so
  // the debug viz is a matching 3D wireframe sphere (not a flat
  // ground ring) that shows exactly what volume the collision code
  // tests against.
  private radiusSphereGeom = new THREE.WireframeGeometry(
    new THREE.SphereGeometry(1, 16, 10),
  );

  private primaryMats = new Map<PlayerId, THREE.MeshLambertMaterial>();
  private turretAccentMats = new Map<number, THREE.MeshLambertMaterial>();
  private neutralMat = new THREE.MeshLambertMaterial({ color: COLORS.units.neutral.colorHex });
  // Force-field panels keep their existing shape and mount, but use the
  // shield shield treatment so they read as reflector surfaces
  // instead of chrome slabs.
  private mirrorShinyNeutralMat = createShieldFallbackPanelMaterial();
  /** Per-frame scratch: combined `tilt · Ry(yaw)` quaternion + scratch
   *  yaw-only quaternion. Module-local axis (`_INST_UP`) drives the yaw
   *  quaternion. */
  private _smoothParentQuat = new THREE.Quaternion();
  private _smoothYawQuat = new THREE.Quaternion();
  /** Lift offset (0, chassisLift, 0) rotated by parentQuat, added to
   *  groupPos so parentMat reproduces the scenegraph chain
   *    group → yawGroup → liftGroup → chassis
   *  (which inserts T(0, lift, 0) after Ry(yaw) and before S(radius)).
   *  Without this, smooth-chassis + poly-chassis instances render at
   *  the OLD ground height while per-Mesh chassis (correctly parented
   *  through liftGroup) render lifted — visible mismatch on every
   *  chassis-instanced unit. */
  private _smoothLiftOffset = new THREE.Vector3();
  private _smoothLiftedPos = new THREE.Vector3();

  private _unitOneVec = new THREE.Vector3(1, 1, 1);
  private turretMountCache = new TurretMountCache3D();
  // Last beam-firing direction per turret, collected from the live beam
  // line-projectiles each frame (collectBeamTurretAim) and read by the
  // unit + building turret-pose passes to aim beam-directed barrels.
  // Persists across frames (freezes on the last direction).
  private turretBeamAimCache = new TurretBeamAimCache3D();
  private _beamAimScratch: Entity[] = [];

  /** Per-unit cached prefix matrix `T(liftedPos) · R(parentQuat) · S(1)`
   *  — i.e. the scenegraph chain `group · yawGroup · liftGroup` evaluated
   *  once at the top of the per-unit body. Reused as the BARREL parent-
   *  chain seed so the per-turret loop's first three composes /
   *  multiplies (which used to rebuild this chain from m.group every
   *  turret) collapse to a single `Matrix4.copy()`. */
  private _unitChainMat = new THREE.Matrix4();
  private _mirrorPivotLocal = new THREE.Vector3();
  private _deathScatterObjPos = new THREE.Vector3();
  private _deathScatterLocalDelta = new THREE.Vector3();
  private _deathScatterParentQuat = new THREE.Quaternion();

  private turretShieldPanelsEnabled = true;

  constructor(
    world: THREE.Group,
    clientViewState: ClientViewState,
    scope: ViewportFootprint,
    legRenderer: LegInstancedRenderer,
    camera: THREE.PerspectiveCamera,
    getViewportHeight: () => number,
    metalDeposits: readonly MetalDeposit[],
  ) {
    this.world = world;
    this.clientViewState = clientViewState;
    this.scope = scope;
    this.legRenderer = legRenderer;
    this.camera = camera;
    this.getViewportHeight = getViewportHeight;
    this.metalDeposits = metalDeposits;
    this.selectionOverlays = new SelectionOverlayRenderer3D({
      world: this.world,
      clientViewState: this.clientViewState,
      radiusSphereGeom: this.radiusSphereGeom,
    });
    this.constructionVisuals = new ConstructionVisualController3D(this.clientViewState);
    this.projectileRangeEnvelope = new ProjectileRangeEnvelope3D(this.world, this.clientViewState);
    this.buildingRenderer = new BuildingEntityRenderer3D({
      world: this.world,
      clientViewState: this.clientViewState,
      selectionOverlays: this.selectionOverlays,
      constructionVisuals: this.constructionVisuals,
      turretHeadGeom: this.turretHeadGeom,
      barrelGeom: this.barrelGeom,
      coneBarrelGeom: this.coneBarrelGeom,
      getPrimaryMat: (playerId) => this.getPrimaryMat(playerId),
      getTurretAccentMat: (playerId) => this.getTurretAccentMat(playerId),
      disposeWorldParentedOverlays: (mesh) => this.disposeWorldParentedOverlays(mesh),
      metalDeposits: this.metalDeposits,
    });
    this.projectileRenderer = new ProjectileRenderer3D({
      world: this.world,
      clientViewState: this.clientViewState,
      scope: this.scope,
      radiusSphereGeom: this.radiusSphereGeom,
    });
    // Per-team materials are created lazily on first use (see
    // getPrimaryMat / getSecondaryMat). The
    // player-color generator (sim/types.getPlayerColors) supports any
    // pid, so we don't pre-allocate for a fixed table here.

    this.unitDetailInstances = new UnitDetailInstanceRenderer3D({
      world: this.world,
      turretHeadGeom: this.turretHeadGeom,
      barrelGeom: this.barrelGeom,
      coneBarrelGeom: this.coneBarrelGeom,
      barrelMat: this.barrelMat,
      mirrorGeom: this.mirrorGeom,
    });
    this.unitMeshBuilder = new UnitMeshBuilder3D({
      world: this.world,
      unitDetailInstances: this.unitDetailInstances,
      commanderVisualKit: this.commanderVisualKit,
      legRenderer: this.legRenderer,
      turretHeadGeom: this.turretHeadGeom,
      barrelGeom: this.barrelGeom,
      coneBarrelGeom: this.coneBarrelGeom,
      mirrorGeom: this.mirrorGeom,
      mirrorArmGeom: this.mirrorArmGeom,
      mirrorSupportGeom: this.mirrorSupportGeom,
      getPrimaryMat: (playerId) => this.getPrimaryMat(playerId),
      getTurretAccentMat: (playerId) => this.getTurretAccentMat(playerId),
      getMirrorShinyMat: () => this.getMirrorShinyMat(),
      getMapWidth: () => this.clientViewState.getMapWidth(),
      getMapHeight: () => this.clientViewState.getMapHeight(),
    });

    // KILLED units: scatter the corpse pieces while ramping the death fade.
    this.dyingUnits = new DyingMeshFade<EntityMesh>(
      ENTITY_DEATH_FADE_MS,
      (mesh, fade, dtMs) => {
        this.advanceDyingUnitScatter(mesh, dtMs);
        this.applyUnitEntityFade(mesh, fade, null);
      },
      (id, mesh) => this.disposeDeadUnitMesh(id, mesh),
    );
    // OUT-OF-VISION units: a plain alpha fade-out in place — frozen pose,
    // no scatter, no explosion — over the separate VISION_FADE_OUT_MS clock.
    this.vanishingUnits = new DyingMeshFade<EntityMesh>(
      VISION_FADE_OUT_MS,
      (mesh, fade) => this.applyUnitEntityFade(mesh, fade, null),
      (id, mesh) => this.disposeDeadUnitMesh(id, mesh),
    );
  }

  /** Shared teardown for a unit mesh once its death / vision fade has run
   *  out: drop the per-object fade clones, free the locomotion + instanced
   *  slots, and detach the group from the world. */
  private disposeDeadUnitMesh(id: EntityId, mesh: EntityMesh): void {
    disposeEntityGroupFade(mesh.group);
    destroyLocomotion(mesh.locomotion, this.legRenderer);
    this.world.remove(mesh.group);
    this.disposeWorldParentedOverlays(mesh);
    this.unitDetailInstances.freeMeshSlots(id, mesh);
  }

  /** Advance and return a unit's vision fade-IN factor (0..1). A unit that
   *  has just entered the local player's vision ramps from 0 → 1 over
   *  VISION_FADE_IN_MS; once complete it pins at 1 for no further cost. The
   *  caller multiplies this into the body opacity so it composes with the
   *  construction materialization fade. */
  private advanceSpawnFadeIn(id: EntityId): number {
    if (VISION_FADE_IN_MS <= 0) return 1;
    const prev = this.spawnFadeElapsed.get(id);
    if (prev === VISION_FADE_IN_MS) return 1; // already fully faded in
    const elapsed = Math.min((prev ?? 0) + this._currentDtMs, VISION_FADE_IN_MS);
    this.spawnFadeElapsed.set(id, elapsed);
    return elapsed / VISION_FADE_IN_MS;
  }

  /** Flag a unit as DESTROYED so its mesh plays the scatter + death-fade
   *  when it leaves the live set, instead of the quiet vision fade-out.
   *  Driven by 'death' SimEvents (see RtsScene3D); units that merely leave
   *  vision are never flagged and so fade away without exploding. Runs
   *  before the per-frame removal sweep, while the mesh is still live. */
  markEntityKilled(id: EntityId): void {
    const m = this.unitMeshes.get(id);
    if (m) m.killed = true;
  }

  private getMirrorShinyMat(): THREE.Material {
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

  private getTurretAccentMat(pid: PlayerId | undefined): THREE.MeshLambertMaterial {
    const color = turretAccentColorHexForPlayer(pid);
    let mat = this.turretAccentMats.get(color);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color });
      this.turretAccentMats.set(color, mat);
    }
    return mat;
  }

  update(
    frameStateOverride?: RenderFrameState3D,
    turretShieldPanelsEnabled: boolean = true,
    entityPacket?: RenderEntityUpdatePacket3D,
  ): void {
    // Refresh the single render-detail snapshot once per frame.
    const newFrameState = frameStateOverride
      ?? snapshotRenderFrameState(this.camera, this.getViewportHeight(), this.frameState);
    this.frameState = newFrameState;
    this.turretShieldPanelsEnabled = turretShieldPanelsEnabled;

    const frameSpin = this.barrelSpinState.beginFrame();
    this._currentDtMs = frameSpin.currentDtMs;
    this._currentTimeMs = frameSpin.timeMs;
    this._spinDt = frameSpin.spinDtSec;
    this.turretMountCache.reset(this._currentDtMs);
    refreshLocomotionSupportSurfaces(this.clientViewState.getPredictionSupportSurfaceEntities());
    // Populate beam-directed turret aim from the live beams BEFORE the
    // unit + building turret-pose passes read it this frame.
    this.collectBeamTurretAim(entityPacket?.beamAimProjectiles);
    this.updateUnits(entityPacket?.unitRows, entityPacket?.scoped === true);
    this.buildingRenderer.update(
      entityPacket?.buildingRows,
      this.frameState,
      this._spinDt,
      this._currentDtMs,
      frameSpin.timeMs,
      this.turretBeamAimCache,
      entityPacket?.scoped === true,
    );
    this.projectileRangeEnvelope.update();
    this.projectileRenderer.update(this.frameState);
    // One flush per frame uploads the per-instance leg cylinder
    // buffers (start / end / thickness) to the GPU. Every leg in
    // every unit wrote into the same shared pool above; the GPU
    // now draws all leg cylinders in two draw calls (upper, lower).
    this.legRenderer.flush();
  }

  private _spinDt = 0;

  private _currentDtMs = 0;
  private _currentTimeMs = 0;

  /** Remove every overlay mesh that lives in the world group (not the
   *  unit group) so a teardown/rebuild cycle doesn't leak them into
   *  the scene. TURR CIR circles (per-turret) and the BLD build circle
   *  are the only ones in this category — they represent absolute
   *  horizontal ranges keyed to the turret mount / unit center. UNIT
   *  SPH spheres (VISUAL/HITBOX/COLLISION) ride the unit group and leave
   *  alongside m.group. */
  private disposeWorldParentedOverlays(m: EntityMesh): void {
    this.selectionOverlays.removeWorldParentedOverlays(m);
  }

  private destroyUnitMesh(id: EntityId, m: EntityMesh): void {
    disposeEntityGroupFade(m.group);
    destroyLocomotion(m.locomotion, this.legRenderer);
    this.world.remove(m.group);
    this.disposeWorldParentedOverlays(m);
    this.unitDetailInstances.freeMeshSlots(id, m);
    this.unitMeshes.delete(id);
  }

  /** Per-frame color sync for instanced render paths. This uses ordinary
   *  instanceColor only; construction opacity lives in the shared
   *  EntityFade3D path below. */
  private updateUnitInstanceColors(
    e: Entity,
    m: EntityMesh,
    turrets: readonly Turret[] = EMPTY_TURRETS,
  ): void {
    this.unitDetailInstances.syncEntityColors(e, m, turrets);
  }

  /** Per-Mesh fallback materials are mostly static after build/rebuild.
   *  The exceptions are head-only turrets, whose visible head flips
   *  between player primary and turret accent when the turret engages,
   *  and shield-sphere emitter cores, which pulse while active. Keep
   *  those dynamic paths cached instead of rewriting every chassis,
   *  barrel, and mirror material for every unit every frame. */
  private updateUnitFallbackDynamicMaterials(
    e: Entity,
    m: EntityMesh,
    turrets: readonly Turret[],
  ): void {
    const ownerId = e.ownership?.playerId;
    let headOnlyStates = m.unitHeadOnlyTurretEngaged;
    let dynamicHeadColors = m.unitDynamicTurretHeadColorHex;
    for (let i = 0; i < m.turrets.length; i++) {
      const turretMesh = m.turrets[i];
      if (!turretMesh.head) continue;
      if (turretMesh.shieldEmitterCore === true) {
        const colorHex = entityShieldSphereTurretHeadColorHex(
          e,
          turrets[i],
          this._currentTimeMs,
        );
        if (dynamicHeadColors !== undefined && dynamicHeadColors[i] === colorHex) continue;
        if (dynamicHeadColors === undefined) {
          dynamicHeadColors = [];
          m.unitDynamicTurretHeadColorHex = dynamicHeadColors;
        }
        dynamicHeadColors[i] = colorHex;
        const mat = turretMesh.shieldEmitterPulseMat ?? turretMesh.head.material;
        if (Array.isArray(mat)) continue;
        const colorMat = mat as THREE.Material & { color?: THREE.Color };
        if (colorMat.color instanceof THREE.Color) colorMat.color.set(colorHex);
        continue;
      }
      if (turretMesh.headOnly === true && turretMesh.barrelFollowsBeam !== true) {
        const engaged = turrets[i]?.state === 'engaged';
        if (headOnlyStates !== undefined && headOnlyStates[i] === engaged) continue;
        if (headOnlyStates === undefined) {
          headOnlyStates = [];
          m.unitHeadOnlyTurretEngaged = headOnlyStates;
        }
        headOnlyStates[i] = engaged;
        turretMesh.head.material = engaged
          ? this.getTurretAccentMat(ownerId)
          : this.getPrimaryMat(ownerId);
      }
    }
  }

  /** Apply the same alpha materialization function buildings use to all
   *  per-Mesh unit parts, while feeding the instanced unit pools via
   *  their per-instance fade attributes. The group traversals are gated
   *  so completed units do not pay this cost every frame. */
  private applyUnitEntityFade(
    m: EntityMesh,
    bodyFade: number,
    turretFades: readonly number[] | null,
  ): void {
    this.unitDetailInstances.writeEntityFade(m, bodyFade, turretFades);
    fadeLocomotion(m.locomotion, bodyFade, this.legRenderer);

    const bodyFadeActive = bodyFade < 1;
    if (bodyFadeActive || m.unitGroupFadeActive === true) {
      applyEntityGroupFade(m.group, bodyFade);
      m.unitGroupFadeActive = bodyFadeActive;
    }

    if (turretFades === null) return;
    const turretStates = m.unitTurretGroupFadeActive ?? [];
    for (let i = 0; i < m.turrets.length; i++) {
      const fade = turretFades[i] ?? bodyFade;
      const hasSpecificFade = fade < 1 && fade !== bodyFade;
      if (hasSpecificFade || turretStates[i] === true) {
        applyEntityGroupFade(m.turrets[i].root, fade);
        turretStates[i] = hasSpecificFade;
      }
    }
    m.unitTurretGroupFadeActive = turretStates;
  }

  private prepareDyingUnitScatter(m: EntityMesh): void {
    if (this.dyingUnitScatter.has(m)) return;
    const turrets: DyingUnitPartMotion[] = [];
    for (const turret of m.turrets) {
      turrets.push(this.makeDyingPartMotionFromObject(
        m,
        turret.root,
        1,
      ));
    }
    const scatter: DyingUnitScatter = {
      body: this.makeDyingPartMotion(0, 0, DEATH_SCATTER_BODY_SPEED_SCALE),
      turrets,
    };
    if (m.locomotion) {
      scatter.locomotion = this.makeDyingPartMotionFromObject(
        m,
        m.locomotion.group,
        DEATH_SCATTER_LOCOMOTION_SPEED_SCALE,
      );
    }
    this.dyingUnitScatter.set(m, scatter);
  }

  private makeDyingPartMotionFromObject(
    m: EntityMesh,
    obj: THREE.Object3D,
    speedScale: number,
  ): DyingUnitPartMotion {
    obj.getWorldPosition(this._deathScatterObjPos);
    return this.makeDyingPartMotion(
      this._deathScatterObjPos.x - m.group.position.x,
      this._deathScatterObjPos.z - m.group.position.z,
      speedScale,
    );
  }

  private makeDyingPartMotion(
    offsetX: number,
    offsetZ: number,
    speedScale: number,
  ): DyingUnitPartMotion {
    let dirX = offsetX;
    let dirZ = offsetZ;
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-3) {
      dirX /= len;
      dirZ /= len;
      const jitter = (Math.random() - 0.5) * 0.9;
      const c = Math.cos(jitter);
      const s = Math.sin(jitter);
      const jx = dirX * c - dirZ * s;
      dirZ = dirX * s + dirZ * c;
      dirX = jx;
    } else {
      const angle = Math.random() * Math.PI * 2;
      dirX = Math.cos(angle);
      dirZ = Math.sin(angle);
    }
    const speed = (DEATH_SCATTER_SPEED_MIN + Math.random() * DEATH_SCATTER_SPEED_RANGE) * speedScale;
    return {
      vx: dirX * speed,
      vy: DEATH_SCATTER_UP_MIN + Math.random() * DEATH_SCATTER_UP_RANGE,
      vz: dirZ * speed,
      avx: (Math.random() - 0.5) * DEATH_SCATTER_ANGULAR_INIT * 2,
      avy: (Math.random() - 0.5) * DEATH_SCATTER_ANGULAR_INIT * 2,
      avz: (Math.random() - 0.5) * DEATH_SCATTER_ANGULAR_INIT * 2,
    };
  }

  private advanceDyingUnitScatter(m: EntityMesh, dtMs: number): void {
    const scatter = this.dyingUnitScatter.get(m);
    if (!scatter || dtMs <= 0) return;
    const dtSec = Math.min(dtMs, 80) / 1000;
    const bodyDelta = this.stepDyingPartMotion(
      scatter.body,
      dtSec,
      this._deathScatterBodyDelta,
    );
    this.applyObjectLocalDelta(m.chassis, bodyDelta);
    if (m.mirrors) this.applyObjectLocalDelta(m.mirrors.root, bodyDelta);

    const turretDeltas = this._turretScatterScratch;
    turretDeltas.length = m.turrets.length;
    for (let i = 0; i < m.turrets.length; i++) {
      const motion = scatter.turrets[i] ?? scatter.body;
      const delta = turretDeltas[i] ?? (turretDeltas[i] = createDyingUnitPartDelta());
      this.stepDyingPartMotion(motion, dtSec, delta);
      turretDeltas[i] = delta;
      this.applyObjectLocalDelta(m.turrets[i].root, delta);
    }

    if (scatter.locomotion && m.locomotion) {
      const delta = this.stepDyingPartMotion(
        scatter.locomotion,
        dtSec,
        this._deathScatterLocomotionDelta,
      );
      this.applyObjectLocalDelta(m.locomotion.group, delta);
      translateLocomotion(
        m.locomotion,
        delta.dx,
        delta.dy,
        delta.dz,
        this.legRenderer,
      );
    }

    this.unitDetailInstances.applyDyingUnitScatter(m, bodyDelta, turretDeltas);
  }

  private stepDyingPartMotion(
    motion: DyingUnitPartMotion,
    dtSec: number,
    out: DyingUnitPartDelta,
  ): DyingUnitPartDelta {
    out.dx = motion.vx * dtSec;
    out.dy = motion.vy * dtSec;
    out.dz = motion.vz * dtSec;
    out.drx = motion.avx * dtSec;
    out.dry = motion.avy * dtSec;
    out.drz = motion.avz * dtSec;
    motion.vy -= GRAVITY * DEATH_SCATTER_GRAVITY_SCALE * dtSec;
    const linearDrag = Math.pow(DEATH_SCATTER_LINEAR_DRAG, dtSec * 60);
    motion.vx *= linearDrag;
    motion.vy *= linearDrag;
    motion.vz *= linearDrag;
    const angularDrag = Math.pow(DEATH_SCATTER_ANGULAR_DRAG, dtSec * 60);
    motion.avx *= angularDrag;
    motion.avy *= angularDrag;
    motion.avz *= angularDrag;
    return out;
  }

  private applyObjectLocalDelta(obj: THREE.Object3D, delta: DyingUnitPartDelta): void {
    this._deathScatterLocalDelta.set(delta.dx, delta.dy, delta.dz);
    if (obj.parent) {
      obj.parent.getWorldQuaternion(this._deathScatterParentQuat);
      this._deathScatterParentQuat.invert();
      this._deathScatterLocalDelta.applyQuaternion(this._deathScatterParentQuat);
    }
    obj.position.add(this._deathScatterLocalDelta);
    obj.rotation.x += delta.drx;
    obj.rotation.y += delta.dry;
    obj.rotation.z += delta.drz;
  }

  private updateUnits(unitRows: UnitRenderPacket3D | undefined, scopedRender: boolean): void {
    this.hoverSmokeEmitters.length = 0;
    const rows = unitRows ?? this.populateFallbackUnitRenderRows();
    this.updateUnitMeshes(rows, scopedRender);
  }

  private populateFallbackUnitRenderRows(): UnitRenderPacket3D {
    const rows = this.fallbackUnitRenderRows;
    rows.reset();
    const units = this.clientViewState.getUnits();
    for (let i = 0; i < units.length; i++) rows.pushEntity(units[i]);
    return rows;
  }

  private updateUnitMeshes(unitRows: UnitRenderPacket3D, scopedRender: boolean): void {
    const seen = this._seenUnitIds;
    seen.clear();
    const spinDt = this._spinDt;
    const unitGfx = this.frameState.gfx;
    const unitGeometryKey = this.frameState.key;
    const mapWidth = this.clientViewState.getMapWidth();
    const mapHeight = this.clientViewState.getMapHeight();

    for (let row = 0; row < unitRows.count; row++) {
      const entityId = unitRows.entityIdAt(row);
      const e = this.clientViewState.getEntity(entityId);
      if (e === undefined || e.unit === null) continue;
      seen.add(entityId);
      // If this entity id is mid fade-out (death scatter OR vision fade)
      // and has reappeared (id reuse, re-add, or vision regained before
      // the fade finished), finalize the old mesh now so we don't draw the
      // fading corpse on top of the freshly built unit.
      if (this.dyingUnits.size > 0 && this.dyingUnits.has(entityId)) {
        this.dyingUnits.finalize(entityId);
      }
      if (this.vanishingUnits.size > 0 && this.vanishingUnits.has(entityId)) {
        this.vanishingUnits.finalize(entityId);
      }
      const tx = unitRows.x[row];
      const ty = unitRows.y[row];
      const tRot = unitRows.rotation[row];
      const turrets = e.combat?.turrets ?? EMPTY_TURRETS;
      const groundZ = unitRows.groundY[row];
      // RIGID-BODY POSE TRACKS THE SIM EVERY FRAME. The unit group
      // carries the chassis AND its child turret / mirror groups
      // (both parented to yawGroup), so all pose/detail work below
      // runs at render cadence instead of being scope/camera gated.
      const existing = this.unitMeshes.get(entityId);
      if (existing) {
        existing.group.position.set(tx, groundZ, ty);
        // Note: the canonical yawGroup orientation write happens later
        // in this iteration after the surface-tilt block (see
        // `m.yawGroup.rotation.set(0, yaw, 0)` and the airborne bank
        // composition that follows it). Setting yawGroup here would
        // be overwritten anyway.
        applyUnitLiftGroupPose3D(existing, e);
        this.updateUnitInstanceColors(e, existing, turrets);
      }
      this.barrelSpinState.advance(e, spinDt);
      // Use `scale` (visual) rather than `shot` (collider) for horizontal
      // footprint, matching the 2D renderer. Body height is per-unit
      // (see BodyShape3D / BodyDimensions); turrets mount on top of
      // whatever height the body resolves to.
      const radius = unitRows.radiusVisual[row];
      const pid = unitRows.ownerIdAt(row);
      const fullUnitDetail = true;

      let m = this.unitMeshes.get(entityId);
      if (
        m &&
        (
          m.unitRenderFrameKey !== unitGeometryKey ||
          m.unitRenderOwnerId !== pid
        )
      ) {
        // Preserve leg state across the rebuild — feet keep
        // their planted world positions through the teardown so the
        // newly built mesh resumes the gait instead of snapping back
        // to rest. Captured BEFORE destroyUnitMesh frees the legs.
        const legSnap = captureLegState(m.locomotion);
        if (legSnap) this.legStateCache.set(entityId, legSnap);
        this.destroyUnitMesh(entityId, m);
        m = undefined;
      }
      if (!m) {
        const legSnap = this.legStateCache.get(entityId);
        const ownerKey = pid ?? 'neutral';
        const unitRenderKey = `${unitGeometryKey}|owner:${ownerKey}`;
        m = this.unitMeshBuilder.build({
          entity: e,
          radius,
          ownerId: pid,
          turrets,
          unitGfx,
          unitFrameKey: unitGeometryKey,
          unitRenderKey,
          legState: legSnap,
        });
        if (legSnap !== undefined) this.legStateCache.delete(entityId);
        this.updateUnitInstanceColors(e, m, turrets);
        this.unitMeshes.set(entityId, m);
      }
      this.updateUnitFallbackDynamicMaterials(e, m, turrets);
      // Build-in materialization: the body reveals via per-instance
      // alpha, not by growing the chassis from a point.
      // 0 = not yet started (invisible), ramping to 1 as the body builds.
      // Composed with the vision fade-in so a unit that pops into the
      // local player's vision eases in instead of appearing instantly;
      // the two alpha reasons multiply (a half-built unit just scouted
      // fades toward its current build opacity, not past it).
      const bodyOpacity = getConstructionPieceOpacity(e, 'body') * this.advanceSpawnFadeIn(entityId);
      const bodyVisible = fullUnitDetail && bodyOpacity > 0;
      m.chassis.visible = bodyVisible;

      // Position group at the unit's footprint. sim.x → Three.x, sim.y
      // → Three.z (the existing horizontal convention). Vertical =
      // sim.z - bodyCenterHeight: for a ground-resting unit sim.z is
      // terrain + bodyCenterHeight, so the group sits at the terrain
      // surface and the chassis/turret meshes stack from there.
      m.group.position.set(tx, groundZ, ty);

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
      const yaw = -tRot;
      let chassisTilted = false;
      // Hover and flying chassis never contact terrain, so the ground
      // normal is not their "up." Leaving the group quaternion at
      // identity keeps the body level regardless of the slope below.
      const locoType = m.locomotion?.type;
      const airborne = locoType === 'hover' || locoType === 'flying';
      // Read the unit's sim-side smoothed normal instead of querying
      // the raw terrain mesh per frame. The sim's updateUnitGroundNormal
      // owns the canonical value (initialized at spawn, blended each
      // tick); for unit entities this is what we want.
      // For non-unit entities (buildings, projectiles) we fall back
      // to the raw terrain query since they don't run through the
      // unit ground normal EMA.
      const n = {
        nx: unitRows.normalX[row],
        ny: unitRows.normalY[row],
        nz: unitRows.normalZ[row],
      };
      if (airborne || (n.nx === 0 && n.ny === 0)) {
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

      // Airborne visual bank — composed on top of the canonical yaw
      // write above so the chassis rolls into turns from body-frame
      // lateral acceleration. Sim has no pitch/roll for hover/flying
      // (see "Airborne Banking Is Visual" in design_philosophy.html);
      // the y=z=0 mount invariant on airborne turrets keeps the
      // rolled chassis agreeing with the sim's yaw-only mount math.
      if (airborne && m.yawGroup) {
        // Body-lateral acceleration in the sim frame, computed as the
        // centripetal term v_forward · ω_z:
        //   v_forward = vx · cos(yaw_sim) + vy · sin(yaw_sim)
        //   ω_z       = angularVelocity3.z  (yaw rate, world frame —
        //               equivalent to body frame for yaw-only quats)
        //   a_lateral = -v_forward · ω_z   (sign: bank INTO the turn;
        //               CCW = +ω_z → left wing down via rotateX(-…)
        //               below)
        // All three inputs (transform.rotation, velocityX/Y,
        // angularVelocity3) ride the ROT POS / MOVE POS / ROT VEL
        // prediction channels respectively, so the bank lags exactly
        // as much as the rest of the unit's rotation/movement
        // visuals — a slower channel (MED/SLOW) yields a more
        // sluggish bank by design.
        const vx = unitRows.velocityX[row];
        const vy = unitRows.velocityY[row];
        const cosY = Math.cos(tRot);
        const sinY = Math.sin(tRot);
        const vForward = vx * cosY + vy * sinY;
        const yawRate = unitRows.yawRate[row];
        const aLateral = -vForward * yawRate;
        let target = AIRBORNE_BANK_PER_LATERAL_A * aLateral;
        if (target > AIRBORNE_BANK_MAX) target = AIRBORNE_BANK_MAX;
        else if (target < -AIRBORNE_BANK_MAX) target = -AIRBORNE_BANK_MAX;
        const prev = m.visualBankRoll ?? 0;
        // Frame-rate independent EMA: smoothed = α·prev + (1−α)·target
        // where α = exp(−dt/τ).
        const alpha = spinDt > 0
          ? Math.exp(-spinDt / AIRBORNE_BANK_TAU_SEC)
          : 1;
        const smoothed = alpha * prev + (1 - alpha) * target;
        m.visualBankRoll = smoothed;
        // Roll about the sim's body-forward axis (sim +X) maps to a
        // negative rotation about three.js local +X under the world→
        // three.js quat mapping. rotateX uses the LOCAL axis, which
        // after the yaw Euler above is the chassis's forward axis.
        m.yawGroup.rotateX(-smoothed);
      }

      // Chassis body lives entirely in unit-radius-1 space (see
      // BodyShape3D). Uniformly scaling the chassis group by the unit's
      // render radius multiplies every child part's offset AND per-axis
      // scale by the same factor — so a sphere part at (x=0.3, y=0.55,
      // z=0) with scale (0.55, 0.55, 0.55) lands at the right place and
      // the right size automatically.
      const bodyEntry = getBodyGeom(m.bodyShape!);
      m.chassis.position.set(0, 0, 0);
      // Full size at all times; the build-in reveal is opacity, not scale.
      const bodyRadius = radius;
      m.chassis.scale.setScalar(bodyRadius);

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
        const liftPos = m.liftGroup?.position;
        this._smoothLiftOffset
          .set(liftPos?.x ?? 0, liftPos?.y ?? (m.chassisLift ?? 0), liftPos?.z ?? 0)
          .applyQuaternion(this._smoothParentQuat);
        this._smoothLiftedPos.copy(m.group.position).add(this._smoothLiftOffset);
      }
      // Unscaled prefix matrix `T(liftedPos) · R(parentQuat) · S(1)`.
      // Barrel chain seeds from this; chassis paths still apply their
      // own radius scale on top of the cached parentQuat / liftedPos.
      this._unitChainMat.compose(
        this._smoothLiftedPos,
        this._smoothParentQuat,
        this._unitOneVec,
      );
      this.chassisInstancePose.update(
        e,
        m,
        bodyEntry,
        bodyRadius,
        bodyVisible,
        this._smoothLiftedPos,
        this._smoothParentQuat,
        this.unitDetailInstances,
      );

      const selected = unitRows.selectedAt(row);
      this.selectionOverlays.updateSelectionRing(m, selected, radius * 1.35);
      this.selectionOverlays.updateUnitRadiusRings(m, e);
      this.selectionOverlays.updateRangeRings(m, e);

      this.turretPose.update(
        e,
        m,
        turrets,
        this._smoothParentQuat,
        this._unitChainMat,
        chassisTilted ? _invTiltQuat : undefined,
        unitGfx.barrelSpin,
        this.barrelSpinState,
        this._currentDtMs,
        this._currentTimeMs,
        this.unitDetailInstances,
        this.turretMountCache,
        this.turretBeamAimCache,
        this.constructionVisuals,
      );

      if (m.mirrors) {
        let shieldPanelTurretIndex = -1;
        for (let i = 0; i < turrets.length; i++) {
          if (turrets[i].config.passive) {
            shieldPanelTurretIndex = i;
            break;
          }
        }
        const shieldPanelTurret = shieldPanelTurretIndex >= 0 ? turrets[shieldPanelTurretIndex] : undefined;
        const shieldPanelMaterialized = shieldPanelTurret !== undefined &&
          isConstructionPieceMaterialized(e, 'body');
        this._mirrorPivotLocal.set(
          shieldPanelTurret?.mount.x ?? 0,
          (shieldPanelTurret?.mount.z ?? getUnitBodyCenterHeight(e.unit)) - (m.chassisLift ?? 0),
          shieldPanelTurret?.mount.y ?? 0,
        );
        if (shieldPanelMaterialized) {
          this.shieldPanelPose.update(
            e,
            m.mirrors,
            shieldPanelTurret,
            this._mirrorPivotLocal,
            this._unitChainMat,
            chassisTilted ? _invTiltQuat : undefined,
            this.turretShieldPanelsEnabled,
            this.unitDetailInstances,
          );
        } else {
          m.mirrors.root.visible = false;
          if (m.mirrors.panelSlots) {
            this.unitDetailInstances.clearShieldPanelSlots(m.mirrors.panelSlots);
          }
        }
      }

      // Locomotion: spin tread wheels per velocity; legs write per-
      // instance buffers in the shared cylinder pool.
      if (m.locomotion) {
        m.locomotion.group.visible = isConstructionPieceMaterialized(e, 'body');
      }
      if (m.locomotion && m.locomotion.group.visible) {
        const locomotionSmokeEmitters = isBuildInProgress(e.buildable)
          ? undefined
          : this.hoverSmokeEmitters;
        updateLocomotion(
          m.locomotion, e, this._currentDtMs,
          mapWidth,
          mapHeight,
          this.legRenderer,
          locomotionSmokeEmitters,
        );
      }

      // Materialization fade — mounted turrets share the host body's
      // build fraction because they are not separate construction pieces.
      // Every part fades by per-instance / per-object ALPHA at constant
      // size — body, turrets, and locomotion legs alike (see EntityFade3D
      // and LegInstancedRenderer) — so nothing changes shape as it builds.
      // Finished units sit at 1, where the shared fade helper restores
      // real materials and then becomes a no-op.
      const turretFades = this._turretFadeScratch;
      turretFades.length = m.turrets.length;
      for (let i = 0; i < m.turrets.length; i++) {
        turretFades[i] = bodyOpacity;
      }
      this.applyUnitEntityFade(m, bodyOpacity, turretFades);

      // Health bar handled by HealthBar3D (billboarded sprite in the
      // world group, depth-occluded by terrain).
    }

    // Units no longer present leave the live set. Rather than tearing the
    // mesh down immediately, hand it to a shared fade controller: the
    // instanced slots stay allocated with their last pose frozen while the
    // fade ramps to zero, then frees them. Which controller depends on WHY
    // the unit left:
    //   - killed (a 'death' SimEvent flagged m.killed) → dyingUnits, which
    //     scatters the corpse pieces over the death fade.
    //   - merely out of the local player's vision → vanishingUnits, a plain
    //     alpha fade-out in place with no scatter or explosion.
    for (const [id, m] of this.unitMeshes) {
      if (!seen.has(id)) {
        const liveEntity = this.clientViewState.getEntity(id);
        if (scopedRender && liveEntity !== undefined && liveEntity.unit !== null) {
          const legSnap = captureLegState(m.locomotion);
          if (legSnap) this.legStateCache.set(id, legSnap);
          this.destroyUnitMesh(id, m);
          this.barrelSpinState.delete(id);
          this.turretBeamAimCache.delete(id);
          continue;
        }
        // World-parented overlays (range circles) and the selection ring
        // leave immediately for both paths; the body/turrets/locomotion
        // remain for the render-only fade.
        this.disposeWorldParentedOverlays(m);
        if (m.ring) m.ring.visible = false;
        if (m.killed) {
          this.prepareDyingUnitScatter(m);
          this.dyingUnits.markDying(id, m);
        } else {
          this.vanishingUnits.markDying(id, m);
        }
        // True entity removal — drop any stashed leg-state snapshot and
        // vision fade-in clock so a future re-spawn (or this unit
        // re-entering vision) starts fresh instead of inheriting the
        // last unit's foot positions / fade progress.
        this.legStateCache.delete(id);
        this.spawnFadeElapsed.delete(id);
        this.unitMeshes.delete(id);
        this.barrelSpinState.delete(id);
        this.turretBeamAimCache.delete(id);
      }
    }
    // Advance any in-progress fade-outs before the flush so their updated
    // per-instance fade is uploaded this frame.
    this.dyingUnits.update(this._currentDtMs);
    this.vanishingUnits.update(this._currentDtMs);
    // Drop barrel-spin state and persisted turret-mount history for
    // units that no longer exist. Reuses the same `seen` set populated
    // by the unit loop above — no separate sweep needed.
    this.barrelSpinState.prune(seen);
    this.turretMountCache.prune(seen);
    this.unitDetailInstances.flush(this.turretShieldPanelsEnabled);
  }

  /** Look up the lift subgroup for a unit's mesh. The lift group
   *  carries the body's vertical lift (so it sits on top of the
   *  locomotion instead of embedded in it) AND is parented through
   *  yawGroup → group, so it inherits position + tilt + yaw + lift.
   *  Renderers that attach extra meshes to a unit's BODY (not its
   *  locomotion) — e.g. the shield bubble — parent to this
   *  group at chassis-local positions; the scenegraph chain places
   *  them in world. Returns undefined for units whose mesh has been
   *  torn down (despawn / renderer rebuild). Buildings have no
   *  liftGroup so this is unit-only. */
  getUnitYawGroup(eid: EntityId): THREE.Group | undefined {
    return this.unitMeshes.get(eid)?.liftGroup;
  }

  getFactorySprayTargets(): readonly SprayTarget[] {
    return this.constructionVisuals.getFactorySprayTargets();
  }

  getPylonTubeFlows(): readonly PylonTubeFlow[] {
    return this.constructionVisuals.getTubeFlows();
  }

  getHoverSmokeEmitters(): readonly SmokePuffEmitter[] {
    return this.hoverSmokeEmitters;
  }

  getTurretMountWorldState(entityId: EntityId, turretIdx: number): TurretMountEntry | null {
    return this.turretMountCache.get(entityId, turretIdx);
  }

  /** Populate the beam-aim cache from the active beam line-projectiles,
   *  BEFORE the unit + building turret-pose passes read it this frame.
   *  A beam's first segment — points[0] (the turret mount center) →
   *  points[1] — is exactly the direction the barrel of its emitting
   *  beam turret should point; the pose pass reads it back and aims the
   *  barrel along it (freezing on the last value when the beam stops).
   *
   *  Recorded under every candidate host id the beam carries
   *  (sourceEntityId, plus the authoritative sourceHostEntityId /
   *  sourceRootEntityId), because composite / parented hosts can key the
   *  rendered turret by a different id than the legacy sourceEntityId. */
  private collectBeamTurretAim(beamProjectiles?: readonly Entity[]): void {
    const beams = beamProjectiles ?? this.clientViewState.collectLineProjectiles(this._beamAimScratch);
    for (const e of beams) {
      const proj = e.projectile;
      if (proj === null) continue;
      const pts = proj.points;
      if (!pts || pts.length < 2) continue;
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const dz = pts[1].z - pts[0].z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-5) continue;
      const inv = 1 / len;
      const ux = dx * inv;
      const uy = dy * inv;
      const uz = dz * inv;
      const ti = proj.config.turretIndex ?? 0;
      const ss = proj.shotSource;
      const id0 = proj.sourceEntityId;
      const id1 = ss?.sourceHostEntityId;
      const id2 = ss?.sourceRootEntityId;
      if (id0) this.turretBeamAimCache.record(id0, ti, ux, uy, uz);
      if (id1 && id1 !== id0) this.turretBeamAimCache.record(id1, ti, ux, uy, uz);
      if (id2 && id2 !== id0 && id2 !== id1) this.turretBeamAimCache.record(id2, ti, ux, uy, uz);
    }
  }

  /** Look up an entity's currently built locomotion mesh — undefined
   *  if the unit has no rendered mesh yet, has been torn down, or
   *  its blueprint has no locomotion (statics, buildings). Used by
   *  GroundPrint3D to read each unit's
   *  per-contact world XZ once it has finished updating this frame. */
  getLocomotionMesh(eid: EntityId): import('./Locomotion3D').Locomotion3DMesh {
    return this.unitMeshes.get(eid)?.locomotion;
  }

  destroy(): void {
    // TURR CIR / BLD overlays are world-parented so they stay flat on
    // the terrain regardless of unit rotation; release those explicitly.
    // UNIT SPH overlays are parented to m.group and leave with it.
    for (const m of this.unitMeshes.values()) {
      disposeEntityGroupFade(m.group);
      destroyLocomotion(m.locomotion, this.legRenderer);
      this.world.remove(m.group);
      this.disposeWorldParentedOverlays(m);
    }
    // Drop any meshes still playing their death-out / vision fade-out.
    this.dyingUnits.destroyAll();
    this.vanishingUnits.destroyAll();
    this.spawnFadeElapsed.clear();
    // Renderer-wide teardown — drop every cached leg snapshot, no
    // future build will consume them.
    this.legStateCache.clear();
    this.buildingRenderer.destroy();
    this.projectileRangeEnvelope.destroy();
    this.projectileRenderer.destroy();
    this.unitMeshes.clear();
    this.barrelSpinState.clear();
    this.turretBeamAimCache.clear();
    this._seenUnitIds.clear();
    this.constructionVisuals.destroy();
    this.unitDetailInstances.destroy();
    this.legRenderer.destroy();
    disposeBodyGeoms();
    disposeBuildingGeoms();
    this.turretHeadGeom.dispose();
    this.commanderVisualKit.dispose();
    this.barrelGeom.dispose();
    this.coneBarrelGeom.dispose();
    this.radiusSphereGeom.dispose();
    this.selectionOverlays.dispose();
    this.mirrorGeom.dispose();
    this.mirrorArmGeom.dispose();
    this.mirrorSupportGeom.dispose();
    this.mirrorShinyNeutralMat.dispose();
    this.barrelMat.dispose();
    for (const m of this.primaryMats.values()) m.dispose();
    for (const m of this.turretAccentMats.values()) m.dispose();
    this.neutralMat.dispose();
  }
}
