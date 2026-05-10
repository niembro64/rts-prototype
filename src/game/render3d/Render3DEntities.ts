// Render3DEntities — extrudes the 2D sim primitives into 3D shapes.
//
// - Units:        cylinder (radius from unit.radius.body, height ∝ radius)
// - Turrets:      one per entry in entity.combat.turrets, positioned at the
//                 blueprint-authored chassis-local 3D mount, rotated to
//                 the turret's firing angle, with white barrel cylinders.
// - Buildings:    box (width/height from building component, y-depth ∝ scale)
// - Projectiles:  small sphere (radius from projectile collision)
//
// Coordinate mapping: sim (x, y) → three (x, z). Y is up. Ground at y=0.

import * as THREE from 'three';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { SprayTarget } from '@/types/ui';
import { getPlayerColors } from '../sim/types';
import { applyShellOverride } from './ShellMaterial';
import { LAND_CELL_SIZE } from '../../config';
import { getSurfaceNormal } from '../sim/Terrain';
import type { ClientViewState } from '../network/ClientViewState';
import {
  updateLocomotion,
  destroyLocomotion,
  captureLegState,
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
import {
  disposeBuildingGeoms,
} from './BuildingShape3D';
import type { ViewportFootprint } from '../ViewportFootprint';
import { getUnitBodyCenterHeight, getUnitGroundZ } from '../sim/unitGeometry';
import { getGraphicsConfigFor } from '@/clientBarConfig';
import { shouldRunOnStride } from '../math';
import { ProjectileRenderer3D } from './ProjectileRenderer3D';
import { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';
import { ConstructionVisualController3D } from './ConstructionVisualController3D';
import { CommanderVisualKit3D } from './CommanderVisualKit3D';
import type { EntityMesh } from './EntityMesh3D';
import { BuildingEntityRenderer3D } from './BuildingEntityRenderer3D';
import { isConstructionShell } from './EntityInstanceColor3D';
import { UnitMassInstanceRenderer3D } from './UnitMassInstanceRenderer3D';
import { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';
import { createMirrorReflectorPanelMaterial } from './MirrorReflectorVisual3D';
import { ProjectileRangeEnvelope3D } from './ProjectileRangeEnvelope3D';
import { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';
import { MirrorPose3D } from './MirrorPose3D';
import { UnitChassisInstancePose3D } from './UnitChassisInstancePose3D';
import { UnitTurretPose3D } from './UnitTurretPose3D';
import { applyUnitLiftGroupPose3D, UnitMeshBuilder3D } from './UnitMeshBuilder3D';

// Turret head height is the one remaining shared vertical constant —
// chassis heights are now per-unit (see getBodyTopY in BodyDimensions.ts).
// The sim's projectile-spawn point is the turret world mount center;
// barrel endpoint geometry is visual-only.

const BARREL_COLOR = 0xffffff;

// Shared Y-up axis for manual instanced transform composition.
const _INST_UP = new THREE.Vector3(0, 1, 0);

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
// Mirror panels (reflective mirror-unit armor plates) are square slabs
// mounted at the rigid mirror-arm's far end. The cache in
// mirrorPanelCache.ts computes baseY/topY/halfWidth from the turret's
// mount.z + radius.body scaled by MIRROR_PANEL_SIZE_MULT; both the
// renderer and the sim's beam-reflection tracer read those cached
// fields so the visible mesh and the collision rectangle stay in sync.

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
  // Reusable "seen this frame" set for unit pruning. Keeping it as an
  // instance field and calling `.clear()` avoids a fresh Set allocation
  // every render frame.
  private _seenUnitIds = new Set<EntityId>();
  private projectileRenderer: ProjectileRenderer3D;
  private selectionOverlays: SelectionOverlayRenderer3D;
  private constructionVisuals: ConstructionVisualController3D;
  private buildingRenderer: BuildingEntityRenderer3D;
  private unitMassInstances: UnitMassInstanceRenderer3D;
  private unitDetailInstances: UnitDetailInstanceRenderer3D;
  private unitMeshBuilder!: UnitMeshBuilder3D;
  private projectileRangeEnvelope: ProjectileRangeEnvelope3D;

  private barrelSpinState = new UnitBarrelSpinState3D();
  private mirrorPose = new MirrorPose3D();
  private chassisInstancePose = new UnitChassisInstancePose3D();
  private turretPose = new UnitTurretPose3D();

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
  private commanderVisualKit = new CommanderVisualKit3D();
  /** Unit box used as the BUILDING marker mesh at the lowest LOD tier.
   *  Scaled per-frame to the building's logical sim cuboid
   *  (width × depth × height) so the building still reads as a building
   *  on the ground at marker tier — same volume the host sim uses for
   *  its static collider, same volume the high-LOD primary occupies. */
  private buildingMarkerBoxGeom = new THREE.BoxGeometry(1, 1, 1);
  private barrelGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  private barrelMat = new THREE.MeshLambertMaterial({ color: BARREL_COLOR });
  // Mirror panel = flat unit square plane. Default orientation: face
  // in XY plane with normal +Z; we rotate it into the panel-local frame
  // (edge → +Z, normal → +X) per panel below. The mesh is a thin BoxGeometry
  // so the mirror reads as a slab with a hint of depth; the slab is
  // centered on the sim collision plane (depth distributed equally to
  // both sides) so the visible surface and the sim rectangle still share
  // the same center plane.
  private mirrorGeom = new THREE.BoxGeometry(1, 1, 1);
  private mirrorArmGeom = new THREE.BoxGeometry(1, 1, 1);
  private mirrorSupportGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
  // Unit-radius indicator wireframe spheres (BODY/SHOT/PUSH). Unit
  // radius = 1 → scale per mesh to the actual collider radius. The
  // sim's hit-detection uses 3D spheres centered on transform.z, so
  // the debug viz is a matching 3D wireframe sphere (not a flat
  // ground ring) that shows exactly what volume the collision code
  // tests against.
  private radiusSphereGeom = new THREE.WireframeGeometry(
    new THREE.SphereGeometry(1, 16, 10),
  );

  private primaryMats = new Map<PlayerId, THREE.MeshLambertMaterial>();
  private neutralMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
  // Mirror panels keep their existing shape and mount, but use the
  // force-field shield treatment so they read as reflector surfaces
  // instead of chrome slabs.
  private mirrorShinyNeutralMat = createMirrorReflectorPanelMaterial();
  private ownedObjectLodGrid = new RenderLodGrid();
  private objectLodGrid = this.ownedObjectLodGrid;
  private richUnitDetailFrame = 0;

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
   *  chassis-instanced unit at LOW+ tier. */
  private _smoothLiftOffset = new THREE.Vector3();
  private _smoothLiftedPos = new THREE.Vector3();

  private _unitOneVec = new THREE.Vector3(1, 1, 1);

  /** Per-unit cached prefix matrix `T(liftedPos) · R(parentQuat) · S(1)`
   *  — i.e. the scenegraph chain `group · yawGroup · liftGroup` evaluated
   *  once at the top of the per-unit body. Reused as the BARREL parent-
   *  chain seed so the per-turret loop's first three composes /
   *  multiplies (which used to rebuild this chain from m.group every
   *  turret) collapse to a single `Matrix4.copy()`. */
  private _unitChainMat = new THREE.Matrix4();
  private _unitParentInvQuat = new THREE.Quaternion();
  private _unitBodyCenterLocal = new THREE.Vector3();

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
      markerBoxGeom: this.buildingMarkerBoxGeom,
      turretHeadGeom: this.turretHeadGeom,
      barrelGeom: this.barrelGeom,
      barrelMat: this.barrelMat,
      getPrimaryMat: (playerId) => this.getPrimaryMat(playerId),
      resolveObjectLod: (entity) => this.resolveEntityObjectLod(entity),
      disposeWorldParentedOverlays: (mesh) => this.disposeWorldParentedOverlays(mesh),
    });
    this.projectileRenderer = new ProjectileRenderer3D({
      world: this.world,
      clientViewState: this.clientViewState,
      scope: this.scope,
      radiusSphereGeom: this.radiusSphereGeom,
      resolveObjectLod: (entity) => this.resolveEntityObjectLod(entity),
    });
    // Per-team materials are created lazily on first use (see
    // getPrimaryMat / getSecondaryMat). The
    // player-color generator (sim/types.getPlayerColors) supports any
    // pid, so we don't pre-allocate for a fixed table here.

    this.unitMassInstances = new UnitMassInstanceRenderer3D({
      world: this.world,
      clientViewState: this.clientViewState,
      scope: this.scope,
      resolveObjectLod: (entity) => this.resolveEntityObjectLod(entity),
      hasSceneMesh: (entityId) => this.unitMeshes.has(entityId),
    });
    this.unitDetailInstances = new UnitDetailInstanceRenderer3D({
      world: this.world,
      turretHeadGeom: this.turretHeadGeom,
      barrelGeom: this.barrelGeom,
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
      barrelMat: this.barrelMat,
      mirrorGeom: this.mirrorGeom,
      mirrorArmGeom: this.mirrorArmGeom,
      mirrorSupportGeom: this.mirrorSupportGeom,
      getPrimaryMat: (playerId) => this.getPrimaryMat(playerId),
      getMirrorShinyMat: () => this.getMirrorShinyMat(),
      getMapWidth: () => this.clientViewState.getMapWidth(),
      getMapHeight: () => this.clientViewState.getMapHeight(),
    });
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

    const frameSpin = this.barrelSpinState.beginFrame();
    this._currentDtMs = frameSpin.currentDtMs;
    this._spinDt = frameSpin.spinDtSec;
    this.updateUnits();
    this.buildingRenderer.update(this.lod, this._spinDt, this._currentDtMs, frameSpin.timeMs);
    this.projectileRangeEnvelope.update();
    this.projectileRenderer.update(this.lod);
    // One flush per frame uploads the per-instance leg cylinder
    // buffers (start / end / thickness) to the GPU. Every leg in
    // every unit wrote into the same shared pool above; the GPU
    // now draws all leg cylinders in two draw calls (upper, lower).
    this.legRenderer.flush();
  }

  private _spinDt = 0;

  private _currentDtMs = 0;

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
    this.barrelSpinState.clear();
    this.unitDetailInstances.releaseAllSlots();
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
      const suspension = unit.suspension;
      if (suspension) {
        const sx = suspension.offsetX;
        const sy = suspension.offsetY;
        const sz = suspension.offsetZ;
        const svx = suspension.velocityX;
        const svy = suspension.velocityY;
        const svz = suspension.velocityZ;
        if (
          sx * sx + sy * sy + sz * sz > UNIT_DETAIL_TRANSFORM_EPSILON * UNIT_DETAIL_TRANSFORM_EPSILON ||
          svx * svx + svy * svy + svz * svz > UNIT_DETAIL_VELOCITY_EPSILON_SQ
        ) {
          return true;
        }
      }
    }
    if (entity.combat?.hasActiveCombat) return true;
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
    return shouldRunOnStride(this.richUnitDetailFrame, stride, entity.id);
  }

  private markRichUnitDetailsUpdated(entity: Entity, mesh: EntityMesh): void {
    mesh.unitDetailCachedX = entity.transform.x;
    mesh.unitDetailCachedY = entity.transform.y;
    mesh.unitDetailCachedZ = entity.transform.z;
    mesh.unitDetailCachedRotation = entity.transform.rotation;
  }

  /** Remove every overlay mesh that lives in the world group (not the
   *  unit group) so a teardown/rebuild cycle doesn't leak them into
   *  the scene. TURR CIR circles (per-turret) and the BLD build circle
   *  are the only ones in this category — they represent absolute
   *  horizontal ranges keyed to the turret mount / unit center. UNIT
   *  SPH spheres (BODY/SHOT/PUSH) ride the unit group and leave
   *  alongside m.group. */
  private disposeWorldParentedOverlays(m: EntityMesh): void {
    this.selectionOverlays.removeWorldParentedOverlays(m);
  }

  private destroyUnitMesh(id: EntityId, m: EntityMesh): void {
    destroyLocomotion(m.locomotion, this.legRenderer);
    this.world.remove(m.group);
    this.disposeWorldParentedOverlays(m);
    this.unitDetailInstances.freeMeshSlots(id, m);
    this.unitMeshes.delete(id);
  }

  private resolveEntityObjectLod(entity: Entity): RenderObjectLodTier {
    return this.objectLodGrid.resolve(
      entity.transform.x,
      entity.transform.z,
      entity.transform.y,
    );
  }

  /** Per-frame shell-state color sync for instanced render paths. This
   *  intentionally uses ordinary instanceColor only: no per-instance alpha
   *  attributes and no material shader patching. Per-Mesh fallbacks still use
   *  applyShellOverride for the translucent shell material. */
  private updateShellInstanceColors(e: Entity, m: EntityMesh): void {
    this.unitMassInstances.syncColorForEntity(e);
    this.unitDetailInstances.syncShellColors(e, m);
  }

  private updateUnits(): void {
    const unitRenderMode = this.lod.gfx.unitRenderMode;

    if (unitRenderMode === 'mass') {
      this.unitMassInstances.clearRichUnits();
      if (this.unitMeshes.size > 0) {
        this.rebuildAllUnitsOnLodChange();
      }
      this.unitMassInstances.update(this.lod);
      return;
    }

    if (unitRenderMode === 'hybrid') {
      const richUnits = this.unitMassInstances.update(this.lod, undefined, true);
      this.updateUnitMeshes(richUnits);
      return;
    }

    if (this.unitMassInstances.hasSlots()) {
      this.unitMassInstances.releaseAll();
    }
    this.unitMassInstances.clearRichUnits();
    const units = this.clientViewState.getUnits();
    this.updateUnitMeshes(units);
  }

  private updateUnitMeshes(units: readonly Entity[]): void {
    const seen = this._seenUnitIds;
    seen.clear();
    const spinDt = this._spinDt;
    this.richUnitDetailFrame = (this.richUnitDetailFrame + 1) & 0x3fffffff;

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
        applyUnitLiftGroupPose3D(existing, e);
        // Shell-state visual — two paths must agree:
        //   - applyShellOverride handles per-Mesh chassis fallbacks
        //     and treads (objects that own their own material).
        //   - updateShellInstanceColors handles every InstancedMesh slot
        //     the entity occupies with plain instanceColor updates.
        applyShellOverride(
          existing.group,
          isConstructionShell(e),
        );
        this.updateShellInstanceColors(e, existing);
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
      this.barrelSpinState.advance(e, spinDt);
      // Use `scale` (visual) rather than `shot` (collider) for horizontal
      // footprint, matching the 2D renderer. Body height is per-unit
      // (see BodyShape3D / BodyDimensions); turrets mount on top of
      // whatever height the body resolves to.
      const radius = e.unit?.radius.body
        ?? e.unit?.radius.shot
        ?? 15;
      const pid = e.ownership?.playerId;
      const turrets = e.combat?.turrets ?? [];
      const objectTier = this.unitMassInstances.getRichObjectTier(e.id) ?? this.resolveEntityObjectLod(e);
      const fullUnitDetail =
        isRichObjectLod(objectTier) || objectTier === 'simple' || objectTier === 'impostor';
      const unitGraphicsTier = objectTier === 'impostor'
        ? 'min'
        : objectLodToGraphicsTier(objectTier, this.lod.gfx.tier);
      const unitGfx = getGraphicsConfigFor(unitGraphicsTier);
      const unitLodKey = lodKey(unitGfx);
      const unitIsShell = isConstructionShell(e);
      const unitRenderKey = `${unitLodKey}|shell:${unitIsShell ? 1 : 0}`;

      let m = this.unitMeshes.get(e.id);
      if (m && m.lodKey !== unitRenderKey) {
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
        const legSnap = this.legStateCache.get(e.id);
        m = this.unitMeshBuilder.build({
          entity: e,
          radius,
          ownerId: pid,
          turrets,
          unitGfx,
          unitGraphicsTier,
          unitRenderKey,
          unitIsShell,
          legState: legSnap,
        });
        if (legSnap !== undefined) this.legStateCache.delete(e.id);
        applyShellOverride(m.group, unitIsShell);
        this.updateShellInstanceColors(e, m);
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
        const isShellState = isConstructionShell(e);
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
      this._unitParentInvQuat.copy(this._smoothParentQuat).invert();
      this._unitBodyCenterLocal
        .set(0, getUnitBodyCenterHeight(e.unit), 0)
        .applyQuaternion(this._unitParentInvQuat);
      this._unitBodyCenterLocal.y -= m.chassisLift ?? 0;

      this.chassisInstancePose.update({
        entity: e,
        mesh: m,
        bodyEntry,
        radius,
        fullUnitDetail,
        parentPosition: this._smoothLiftedPos,
        parentQuaternion: this._smoothParentQuat,
        unitDetailInstances: this.unitDetailInstances,
      });

      const selected = e.selectable?.selected === true;
      this.selectionOverlays.updateSelectionRing(m, selected, radius * 1.35);
      this.selectionOverlays.updateUnitRadiusRings(m, e);
      this.selectionOverlays.updateRangeRings(m, e);

      this.turretPose.update({
        entity: e,
        mesh: m,
        turrets,
        bodyCenterLocal: this._unitBodyCenterLocal,
        parentQuaternion: this._smoothParentQuat,
        unitChainMat: this._unitChainMat,
        chassisTiltInverse: chassisTilted ? _invTiltQuat : undefined,
        graphicsTier: unitGraphicsTier,
        barrelSpinEnabled: unitGfx.barrelSpin,
        spinAngle: this.barrelSpinState.angleFor(e.id),
        currentDtMs: this._currentDtMs,
        unitDetailInstances: this.unitDetailInstances,
        constructionVisuals: this.constructionVisuals,
      });

      if (m.mirrors) {
        this.mirrorPose.update({
          entity: e,
          mirrors: m.mirrors,
          turrets,
          bodyCenterLocal: this._unitBodyCenterLocal,
          unitChainMat: this._unitChainMat,
          chassisTiltInverse: chassisTilted ? _invTiltQuat : undefined,
          mirrorsEnabled: this.mirrorsEnabled,
          unitDetailInstances: this.unitDetailInstances,
        });
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
        this.unitDetailInstances.freeMeshSlots(id, m);
        // True entity removal — drop any stashed leg-state snapshot
        // so a future re-spawn of a different unit reusing this
        // entityId starts fresh instead of inheriting last unit's
        // foot positions.
        this.legStateCache.delete(id);
        this.unitMeshes.delete(id);
        this.barrelSpinState.delete(id);
      }
    }
    // Drop barrel-spin state for units that no longer exist. Reuses
    // the same `seen` set populated by the unit loop above — no
    // separate sweep needed.
    this.barrelSpinState.prune(seen);
    this.unitDetailInstances.flush(this.mirrorsEnabled);
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
    return this.constructionVisuals.getFactorySprayTargets();
  }

  /** Look up an entity's currently built locomotion mesh — undefined
   *  if the unit has no rendered mesh yet (off-scope at scene start),
   *  has been torn down, or its blueprint has no locomotion (statics,
   *  buildings). Used by GroundPrint3D to read each unit's
   *  per-contact world XZ once it has finished updating this frame. */
  getLocomotionMesh(eid: EntityId): import('./Locomotion3D').Locomotion3DMesh {
    return this.unitMeshes.get(eid)?.locomotion;
  }

  destroy(): void {
    // TURR CIR / BLD overlays are world-parented so they stay flat on
    // the terrain regardless of unit rotation; release those explicitly.
    // UNIT SPH overlays are parented to m.group and leave with it.
    for (const m of this.unitMeshes.values()) {
      destroyLocomotion(m.locomotion, this.legRenderer);
      this.world.remove(m.group);
      this.disposeWorldParentedOverlays(m);
    }
    // Renderer-wide teardown — drop every cached leg snapshot, no
    // future build will consume them.
    this.legStateCache.clear();
    this.buildingRenderer.destroy();
    this.projectileRangeEnvelope.destroy();
    this.projectileRenderer.destroy();
    this.unitMeshes.clear();
    this.barrelSpinState.clear();
    this._seenUnitIds.clear();
    this.constructionVisuals.destroy();
    this.unitMassInstances.destroy();
    this.unitDetailInstances.destroy();
    disposeBodyGeoms();
    disposeBuildingGeoms();
    this.buildingMarkerBoxGeom.dispose();
    this.turretHeadGeom.dispose();
    this.commanderVisualKit.dispose();
    this.barrelGeom.dispose();
    this.radiusSphereGeom.dispose();
    this.selectionOverlays.dispose();
    this.mirrorGeom.dispose();
    this.mirrorArmGeom.dispose();
    this.mirrorSupportGeom.dispose();
    this.mirrorShinyNeutralMat.dispose();
    this.barrelMat.dispose();
    for (const m of this.primaryMats.values()) m.dispose();
    this.neutralMat.dispose();
  }
}
