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
import { FALLBACK_UNIT_BODY_SHAPE } from '../sim/blueprints';
import type { ClientViewState } from '../network/ClientViewState';
import {
  buildLocomotion,
  updateLocomotion,
  destroyLocomotion,
  getChassisLift,
  captureLegState,
  applyLegState,
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
  disposeBuildingGeoms,
} from './BuildingShape3D';
import type { ViewportFootprint } from '../ViewportFootprint';
import { getUnitBlueprint } from '../sim/blueprints';
import { getUnitBodyCenterHeight, getUnitGroundZ } from '../sim/unitGeometry';
import { getGraphicsConfigFor } from '@/clientBarConfig';
import { getTurretHeadRadius, shouldRunOnStride } from '../math';
import { getTurretMountHeight, isCommander } from '../sim/combat/combatUtils';
import { buildTurretMesh3D, type TurretMesh } from './TurretMesh3D';
import { buildMirrorMesh3D } from './MirrorMesh3D';
import { ProjectileRenderer3D } from './ProjectileRenderer3D';
import { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';
import { ConstructionVisualController3D } from './ConstructionVisualController3D';
import { CommanderVisualKit3D } from './CommanderVisualKit3D';
import type { EntityMesh } from './EntityMesh3D';
import { buildingTierAtLeast } from './RenderTier3D';
import { BuildingEntityRenderer3D } from './BuildingEntityRenderer3D';
import { isConstructionShell } from './EntityInstanceColor3D';
import { UnitMassInstanceRenderer3D } from './UnitMassInstanceRenderer3D';
import { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';
import { createMirrorReflectorPanelMaterial } from './MirrorReflectorVisual3D';
import { applyTurretAimPose3D } from './TurretAimPose3D';
import { ProjectileRangeEnvelope3D } from './ProjectileRangeEnvelope3D';
import { BarrelTipCache3D, type BarrelTipEntry } from './BarrelTipCache3D';
import { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';

// Turret head height is the one remaining shared vertical constant —
// chassis heights are now per-unit (see getBodyTopY in BodyDimensions.ts).
// The sim's projectile-spawn point is derived by getBarrelTip
// (src/game/math/BarrelGeometry.ts) pivoted at the world mount returned
// by resolveWeaponWorldMount (sim/combat/combatUtils.ts), so visual
// barrel tip and sim muzzle stay locked together.

const BARREL_COLOR = 0xffffff;
// Detailed unit parts use shared instanced pools by default. The
// per-mesh path remains only as an allocation fallback, not as the
// normal rendering route.
const USE_DETAILED_UNIT_INSTANCING = true;

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
// Scratch direction vector reused by mirror-panel compensation math.
const _aimDir = new THREE.Vector3();
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
  private projectileRangeEnvelope: ProjectileRangeEnvelope3D;

  private barrelSpinState = new UnitBarrelSpinState3D();

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
  // (edge → +Z, normal → +X) per panel below. Plane has zero physical
  // thickness so the visible mesh and the sim collision rectangle live
  // on EXACTLY the same surface — no front/back offset where a beam
  // could appear to clip the visible mirror but miss the sim plane.
  private mirrorGeom = new THREE.PlaneGeometry(1, 1);
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

  /** Per-frame cache of barrel-tip sim/world positions, keyed by
   *  `(entityId * 256) + (turretIdx << 4) + barrelIdx`. Populated in
   *  the per-barrel matrix-compose loop and consumed by BeamRenderer3D
   *  when the player-client `beamSnapToBarrel` toggle is on, so the
   *  start of the first beam segment exactly matches the rendered
   *  barrel mesh's tip rather than the snapshot-extrapolated point. */
  private barrelTipCache = new BarrelTipCache3D();

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
    // Reset the per-frame barrel-tip cache before updateUnits writes
    // fresh entries. The pool is reused across frames so steady-state
    // beam combat allocates zero per frame.
    this.barrelTipCache.reset();
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

  private updateUnitLiftGroupPose(m: EntityMesh, e: Entity): void {
    if (!m.liftGroup) return;
    const suspension = e.unit?.suspension;
    if (!suspension) {
      m.liftGroup.position.set(0, m.chassisLift ?? 0, 0);
      return;
    }
    m.liftGroup.position.set(
      suspension.offsetX,
      (m.chassisLift ?? 0) + suspension.offsetZ,
      suspension.offsetY,
    );
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
        this.updateUnitLiftGroupPose(existing, e);
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
      const isCommanderUnit = isCommander(e);
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
        liftGroup.position.set(0, bp ? getChassisLift(bp, radius) : 0, 0);
        yawGroup.add(liftGroup);

        const chassis = new THREE.Group();
        chassis.userData.entityId = e.id;
        const chassisMeshes: THREE.Mesh[] = [];
        const useDetailedUnitInstancing = USE_DETAILED_UNIT_INSTANCING && !unitIsShell;
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
          useDetailedUnitInstancing &&
          !hideChassis &&
          bodyEntry.isSmooth &&
          bodyEntry.parts.length > 0
        ) {
          smoothChassisSlots = this.unitDetailInstances.allocSmoothChassisSlots(bodyEntry.parts.length) ?? undefined;
        } else if (
          useDetailedUnitInstancing &&
          !hideChassis &&
          !bodyEntry.isSmooth &&
          bodyEntry.parts.length > 0
        ) {
          const allocated = this.unitDetailInstances.allocPolyChassisSlot(
            bodyShapeKey,
            bodyEntry.parts[0].geometry,
            e.id,
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
          const commanderKit = this.commanderVisualKit.buildKit(unitGraphicsTier);
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
          if (useDetailedUnitInstancing && !hideHead && !isCommanderUnit) {
            const allocated = this.unitDetailInstances.allocTurretHeadSlot();
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
            this.commanderVisualKit.decorateTurret(
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
          if (useDetailedUnitInstancing && tm.barrels.length > 0) {
            const barrelSlots = this.unitDetailInstances.allocBarrelSlots(tm.barrels.length);
            if (barrelSlots) {
              tm.barrelSlots = barrelSlots;
              // Detach the per-Mesh barrels from spinGroup so they
              // don't double-render — we still keep the Mesh
              // references in tm.barrels[] as the per-frame writer
              // reads .position / .quaternion / .scale off them.
              for (const b of tm.barrels) b.parent?.remove(b);
            }
          }
          turretMeshes.push(tm);
        }

        this.world.add(group);
        m = {
          group, yawGroup, liftGroup, chassis, chassisMeshes, bodyShapeKey, bodyShape,
          hideChassis,
          turrets: turretMeshes, lodKey: unitRenderKey,
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
          this.unitDetailInstances.registerSmoothChassisSlots(e.id, smoothChassisSlots);
        }
        this.updateUnitLiftGroupPose(m, e);
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
          const allocedPanelSlots = useDetailedUnitInstancing && panelCount > 0
            ? this.unitDetailInstances.allocMirrorPanelSlots(panelCount)
            : null;
          const allMirrorAlloc = allocedPanelSlots !== null;
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
            panel.renderOrder = 7;
          }
          for (const frame of m.mirrors.frames) {
            frame.userData.entityId = e.id;
          }
        }

        const isShellState = isConstructionShell(e);
        applyShellOverride(group, isShellState);
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
        this._barrelOneVec,
      );
      this._unitParentInvQuat.copy(this._smoothParentQuat).invert();
      this._unitBodyCenterLocal
        .set(0, getUnitBodyCenterHeight(e.unit), 0)
        .applyQuaternion(this._unitParentInvQuat);
      this._unitBodyCenterLocal.y -= m.chassisLift ?? 0;

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
        this.unitDetailInstances.hideChassisSlots(m);
      } else if (m.smoothChassisSlots) {
        // Reuse cached parentQuat / liftedPos from the per-unit prefix
        // block above. Chassis adds its own radius scale on top of the
        // shared chain. parentMat = T(liftedPos) · R(parentQuat) · S(radius).
        this._smoothParentScale.set(radius, radius, radius);
        this._smoothParentMat.compose(
          this._smoothLiftedPos,
          this._smoothParentQuat,
          this._smoothParentScale,
        );
        const writeColor = this.unitDetailInstances.prepareSmoothChassisColor(e);
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
          this.unitDetailInstances.writeSmoothChassisMatrix(
            slot,
            this._smoothFinalMat,
            e,
            writeColor,
          );
        }
      } else if (m.polyChassisSlot !== undefined) {
        // Polygonal/rect chassis: same parentMat × partMat composition
        // as the smooth path, including the lift translation.
        // Same per-unit chain as smooth chassis — reuse cached
        // parentQuat / liftedPos.
        this._smoothParentScale.set(radius, radius, radius);
        this._smoothParentMat.compose(
          this._smoothLiftedPos,
          this._smoothParentQuat,
          this._smoothParentScale,
        );
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
        this.unitDetailInstances.writePolyChassisMatrix(
          e,
          m.bodyShapeKey,
          m.polyChassisSlot,
          this._smoothFinalMat,
        );
      }

      const selected = e.selectable?.selected === true;
      this.selectionOverlays.updateSelectionRing(m, selected, radius * 1.35);
      this.selectionOverlays.updateUnitRadiusRings(m, e);
      this.selectionOverlays.updateRangeRings(m, e);

      // Per-turret placement. The runtime 3D mount is derived from the
      // unit blueprint's `turrets[i].mount` in body-radius fractions.
      // Sim coords (x, y, z) map to Three local (x, y, z) as
      // forward, height, lateral.
      // On mirror-host units (e.g. Loris) turret[0] owns the mirror panel
      // and the visible host turret body.
      const spinAngle = this.barrelSpinState.angleFor(e.id);
      for (let i = 0; i < m.turrets.length && i < turrets.length; i++) {
        const tm = m.turrets[i];
        const t = turrets[i];
        const headRadius = tm.headRadius ?? getTurretHeadRadius(t.config);
        if (t.config.passive && m.mirrors) {
          // The mirror turret is the Loris body center in gameplay
          // terms. Keep the visible turret head/joint at the exact
          // same world XYZ as entity.transform, even under a tilted
          // parent chain.
          tm.root.position.set(
            this._unitBodyCenterLocal.x,
            this._unitBodyCenterLocal.y - headRadius,
            this._unitBodyCenterLocal.z,
          );
        } else {
          const turretHeadCenterY = getTurretMountHeight(e, i);
          const turretMountY = turretHeadCenterY - (m.chassisLift ?? 0) - headRadius;
          tm.root.position.set(t.mount.x, turretMountY, t.mount.y);
        }

        if (tm.constructionEmitter) {
          const visible = buildingTierAtLeast(unitGraphicsTier, 'low');
          tm.root.visible = visible;
          tm.root.rotation.y = 0;
          if (tm.pitchGroup) tm.pitchGroup.rotation.z = 0;
          if (tm.spinGroup) tm.spinGroup.rotation.x = 0;
          if (visible) {
            this.constructionVisuals.updateCommanderEmitter(
              tm.constructionEmitter,
              e,
              unitGraphicsTier,
              this._currentDtMs,
            );
          }
          continue;
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
        // Do this before writing instanced barrel matrices and the
        // snap-to-barrel cache; both need the current frame's pose.
        applyTurretAimPose3D(
          tm,
          e.transform.rotation,
          t.rotation,
          t.pitch,
          chassisTilted ? _invTiltQuat : undefined,
        );
        // Spin: gatling roll around the LOCAL +X of the pitch group,
        // which is the actual barrel axis after the tilt-aware yaw
        // and pitch compose into the parent chain.
        if (tm.spinGroup) {
          tm.spinGroup.rotation.x = unitGfx.barrelSpin
            ? spinAngle ?? 0
            : 0;
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
          && tm.headRadius !== undefined
        ) {
          const liftPos = m.liftGroup?.position;
          // parentQuat is already cached for this unit. Compute the
          // turret-head position by rotating its chassis-local offset
          // through parentQuat and adding to group.position. Note the
          // cached liftedPos already includes the lift offset, but the
          // head's own y-component supplies (lift + mountY + headRadius)
          // explicitly here so we go from raw m.group.position, not
          // from liftedPos, to avoid double-counting lift.
          this._smoothPartLocalPos.set(
            (liftPos?.x ?? 0) + tm.root.position.x,
            (liftPos?.y ?? (m.chassisLift ?? 0)) + tm.root.position.y + tm.headRadius,
            (liftPos?.z ?? 0) + tm.root.position.z,
          );
          this._smoothPartLocalPos.applyQuaternion(this._smoothParentQuat);
          this._smoothLiftedPos
            .copy(m.group.position)
            .add(this._smoothPartLocalPos);
          this._smoothPartMat.makeScale(tm.headRadius, tm.headRadius, tm.headRadius);
          this._smoothPartMat.setPosition(this._smoothLiftedPos);
          this.unitDetailInstances.writeTurretHeadMatrix(tm.headSlot, this._smoothPartMat, e);
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
            this.unitDetailInstances.writeBarrelMatrix(slot, this._smoothFinalMat);
            // Cache the sim/world barrel tip for the BeamRenderer
            // snap-to-barrel toggle. The cylinder geometry is unit
            // height centered at origin, so local (0, 0.5, 0) is the
            // tip; multiplying by `_smoothFinalMat` (which already
            // bakes in the per-barrel length scale) yields the Three.js
            // muzzle position the rendered cylinder front face sits at
            // this frame; cache it in sim axes for beam polylines.
            this.barrelTipCache.write(e.id, i, bi, this._smoothFinalMat);
          }
        }
      }

      // Mirror panels: track the first turret's full world-space
      // normal. Like standard turret barrels above, yaw + pitch must
      // be decomposed through the tilted chassis parent so the visible
      // mirror stays aimed at the same world direction the sim solved.
      if (m.mirrors) {
        m.mirrors.root.position.copy(this._unitBodyCenterLocal);
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
          const cosMirrorRot = Math.cos(mirrorRot);
          const sinMirrorRot = Math.sin(mirrorRot);
          const cosMirrorPitch = Math.cos(mirrorPitch);
          const sinMirrorPitch = Math.sin(mirrorPitch);
          _aimDir.set(
            cosMirrorRot * cosMirrorPitch,
            sinMirrorPitch,
            sinMirrorRot * cosMirrorPitch,
          );
          if (chassisTilted) _aimDir.applyQuaternion(_invTiltQuat);
          const mCombinedYaw = Math.atan2(-_aimDir.z, _aimDir.x);
          const mNy = _aimDir.y;
          const mLocalPitch = Math.asin(mNy < -1 ? -1 : mNy > 1 ? 1 : mNy);
          m.mirrors.root.rotation.set(
            0,
            mCombinedYaw + e.transform.rotation,
            mLocalPitch,
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
          if (m.mirrors.panelSlots) {
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
              this.unitDetailInstances.writeMirrorPanelMatrix(slot, this._smoothFinalMat, e);
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

  /** Look up the sim/world barrel-tip position the rendered cylinder is
   *  drawn at this frame, for `(entityId, turretIdx, barrelIdx)`.
   *  Populated by updateUnits' per-barrel matrix compose; consumed by
   *  BeamRenderer3D when the `beamSnapToBarrel` toggle is on so the
   *  start of the first beam segment exactly matches the visible
   *  barrel mouth. Returns null when the source unit is off-scope or
   *  its mesh hasn't been built yet — caller should fall back to
   *  `points[0]` from the snapshot polyline. */
  getBarrelTipWorldPos(entityId: EntityId, turretIdx: number, barrelIdx: number): BarrelTipEntry | null {
    return this.barrelTipCache.get(entityId, turretIdx, barrelIdx);
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
