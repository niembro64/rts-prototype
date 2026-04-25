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
import type { Entity, EntityId, PlayerId, Turret } from '../sim/types';
import { getPlayerColors } from '../sim/types';
import type { SpinConfig } from '../../config';
import { TURRET_HEIGHT, MIRROR_BASE_Y, MIRROR_EXTRA_HEIGHT } from '../../config';
import type { ClientViewState } from '../network/ClientViewState';
import {
  buildLocomotion,
  updateLocomotion,
  destroyLocomotion,
  type Locomotion3DMesh,
} from './Locomotion3D';
import { snapshotLod, type Lod3DState } from './Lod3D';
import type { GraphicsConfig } from '@/types/graphics';
import { getBodyGeom, disposeBodyGeoms } from './BodyShape3D';
import {
  buildBuildingShape,
  disposeBuildingGeoms,
  type BuildingShapeType,
} from './BuildingShape3D';
import type { ViewportFootprint } from '../ViewportFootprint';
import { getUnitBlueprint } from '../sim/blueprints';
import { getUnitRadiusToggle, getRangeToggle, getProjRangeToggle } from '@/clientBarConfig';
import { getWeaponWorldPosition } from '../math';

// Turret head height is the one remaining shared vertical constant —
// chassis heights are now per-unit (see getBodyTopY in BodyDimensions.ts).
// The sim's projectile-spawn code (getUnitMuzzleHeight in
// combat/combatUtils.ts) derives muzzle altitude from the same body-top
// value so visual barrel tip and sim muzzle stay locked together.

const BUILDING_HEIGHT = 120;
const PROJECTILE_MIN_RADIUS = 1.5;   // floor so very-small shots stay visible
const TURRET_HEAD_FOOTPRINT = 0.42;  // head X/Z footprint as fraction of chassis radius
const BARREL_COLOR = 0xffffff;
const BARREL_MIN_THICKNESS = 2;      // fallback when blueprint didn't set one

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

type TurretMesh = {
  root: THREE.Group;       // positioned at turret.offset, rotated to turret rotation
  /** Absent for turrets without a "body" — force fields (the glowing sphere
   *  is the whole visual) and mirror units (the mirror panels are). */
  head?: THREE.Mesh;
  barrels: THREE.Mesh[];
  /** Pitch pivot (rotation.z = pitch) — tilts the firing direction up/
   *  down. Parent of spinGroup. Present on every turret with a barrel. */
  pitchGroup?: THREE.Group;
  /** Spin pivot, nested INSIDE pitchGroup. rotation.x = gatling angle.
   *  Because it lives under pitchGroup, its local +X is the already-
   *  pitched firing axis — so spin rotates the barrel cluster around
   *  the real barrel direction (not around world-X). Without this
   *  nesting, pitch+spin compose extrinsically and high-pitch gatling
   *  barrels "cone" around the horizontal instead of spinning around
   *  their own pitched axis. */
  spinGroup?: THREE.Group;
  /** Per-turret TURR RAD overlay spheres. The underlying sim checks
   *  (tracking + engage distance) are now full 3D distance3(...) calls
   *  that include altitude, so the viz is a 3D wireframe sphere —
   *  centered at the weapon's mount point (world XY + mount Z) and
   *  scaled to the range. Parented to the WORLD group so it stays
   *  put in absolute world coords as the unit rotates/moves. */
  rangeRings?: {
    trackAcquire?: THREE.LineSegments;
    trackRelease?: THREE.LineSegments;
    engageAcquire?: THREE.LineSegments;
    engageRelease?: THREE.LineSegments;
  };
};

type MirrorMesh = {
  /** Rotates with the turret (children of this rotate in turret frame). */
  root: THREE.Group;
  panels: THREE.Mesh[];
};

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
  turrets: TurretMesh[];
  mirrors?: MirrorMesh;
  locomotion?: Locomotion3DMesh;
  ringMat?: THREE.MeshBasicMaterial;
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
  private barrelGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  private projectileGeom = new THREE.SphereGeometry(1, 10, 8);
  // White projectile mat — team-agnostic so any shot reads as "can hit
  // anyone". Shooter identity comes from the turret/barrel and impact
  // effects, not the projectile body. Matches the 2D getProjectileColor
  // override.
  private projectileMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private buildingGeom = new THREE.BoxGeometry(1, 1, 1);
  private barrelMat = new THREE.MeshLambertMaterial({ color: BARREL_COLOR });
  private mirrorGeom = new THREE.BoxGeometry(1, 1, 1);
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

  // SHOT RAD wireframe spheres. These sim checks ARE 3D
  // (lineSphereIntersectionT for collision, 3D sqrt(dx²+dy²+dz²) for
  // area damage), so the viz is a 3D sphere — not a ring — to match
  // the real volume the sim tests. Separate materials per toggle so
  // overlapping spheres stay visually distinct.
  private projMatCollision = new THREE.LineBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.55, depthWrite: false });
  private projMatPrimary = new THREE.LineBasicMaterial({ color: 0xff8844, transparent: true, opacity: 0.35, depthWrite: false });
  private projMatSecondary = new THREE.LineBasicMaterial({ color: 0xffdd44, transparent: true, opacity: 0.30, depthWrite: false });

  private primaryMats = new Map<PlayerId, THREE.MeshLambertMaterial>();
  private secondaryMats = new Map<PlayerId, THREE.MeshLambertMaterial>();
  private neutralMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
  // Super-shiny PBR materials for mirror panels. metalness=1 + near-zero
  // roughness turns the panel into team-tinted chrome that reflects the
  // scene's PMREM-processed RoomEnvironment cube set on the scene in
  // ThreeApp. One material per team color (plus a neutral).
  private mirrorShinyMats = new Map<PlayerId, THREE.MeshStandardMaterial>();
  private mirrorShinyNeutralMat = new THREE.MeshStandardMaterial({
    color: 0xdddddd, metalness: 1.0, roughness: 0.0,
  });

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
  }

  private getMirrorShinyMat(pid: PlayerId | undefined): THREE.MeshStandardMaterial {
    if (pid === undefined) return this.mirrorShinyNeutralMat;
    let mat = this.mirrorShinyMats.get(pid);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: getPlayerColors(pid).secondary,
        metalness: 1.0,
        roughness: 0.0,
      });
      this.mirrorShinyMats.set(pid, mat);
    }
    return mat;
  }

  /**
   * Build a turret mesh matching a single Turret's barrel configuration.
   * The turret's local +X is its firing direction; barrels point along +X
   * (or at a slight outward tilt for cone barrels).
   *
   * Barrel dimensions mirror TurretRenderer.ts (the 2D renderer):
   *   - length    = unitRadius · barrel.barrelLength
   *   - thickness = shotWidth (line shots) ?? barrel.barrelThickness ?? 2
   *     (barrelThickness is already derived from the shot size in blueprints)
   *   - orbit     = (orbitRadius | baseOrbit) · unitRadius, clamped so barrels
   *                 stay inside the head vertically
   */
  private buildTurretMesh(
    parent: THREE.Group,
    turret: Turret,
    unitRadius: number,
    pid: PlayerId | undefined,
    isMirrorHost: boolean,
    gfx: GraphicsConfig,
  ): TurretMesh {
    const root = new THREE.Group();
    const barrel = turret.config.barrel;
    const isForceField = barrel?.type === 'complexSingleEmitter';

    // Skip the head cylinder entirely for:
    //  - turretStyle='none' (min LOD): no body, no barrels — chassis only.
    //  - force-field turrets at ANY LOD: the ForceFieldRenderer3D's glowing
    //    sphere is the whole visual — a stubby cylinder underneath just
    //    clips through the orb and reads as a separate piece.
    //  - the mirror-host turret on mirror units (Loris index 0): the mirror
    //    panels already represent that turret's body.
    const turretOff = gfx.turretStyle === 'none';
    const hideHead = turretOff || isForceField || isMirrorHost;

    let head: THREE.Mesh | undefined;
    if (!hideHead) {
      head = new THREE.Mesh(this.turretHeadGeom, this.getSecondaryMat(pid));
      // Sphere head: scale by a single radius so it's a true ball (not
      // a stretched ellipsoid). The ball sits at TURRET_HEIGHT/2 so its
      // center is at the same height the old cylinder's center was —
      // barrel mounts stay in place. Radius is tied to TURRET_HEIGHT so
      // the ball visually matches the turret's vertical extent.
      const headRadius = Math.max(unitRadius * TURRET_HEAD_FOOTPRINT, TURRET_HEIGHT / 2);
      head.scale.setScalar(headRadius);
      head.position.set(0, TURRET_HEIGHT / 2, 0);
      root.add(head);
    }

    const barrels: THREE.Mesh[] = [];
    if (!barrel || isForceField || turretOff) {
      // No physical barrel for: force-field turrets, min LOD (turretOff).
      parent.add(root);
      return { root, head, barrels, pitchGroup: undefined, spinGroup: undefined };
    }

    const barrelCenterY = TURRET_HEIGHT / 2;

    // Barrel thickness is the shot width (for line shots) falling back to the
    // blueprint-derived barrelThickness. Matches the 2D single-barrel path.
    const shot = turret.config.shot;
    const shotWidth =
      shot && (shot.type === 'beam' || shot.type === 'laser')
        ? shot.width
        : undefined;
    const diameter =
      (barrel.type === 'simpleSingleBarrel' ? shotWidth : undefined)
      ?? barrel.barrelThickness
      ?? BARREL_MIN_THICKNESS;
    // CylinderGeometry is unit radius = 1, so physical radius = scale.x = diameter/2.
    const cylRadius = Math.max(diameter, BARREL_MIN_THICKNESS) / 2;

    // Two nested pivots so pitch and spin don't fight each other:
    //
    //   root
    //   └── pitchGroup   — rotation.z = pitch (tilts firing direction)
    //       └── spinGroup — rotation.x = gatling spin
    //           └── barrel meshes
    //
    // Because spinGroup is a child of pitchGroup, spinGroup's local +X
    // is ALREADY the pitched firing direction. Rotating around its
    // local +X therefore spins the barrel cluster around its real 3D
    // firing axis at any pitch. A single group carrying both rotations
    // would compose them extrinsically — spin around world-X after
    // pitch — and high-elevation gatling barrels would cone around the
    // horizontal instead of rolling around their own axis.
    const pitchGroup = new THREE.Group();
    pitchGroup.position.set(0, barrelCenterY, 0);
    root.add(pitchGroup);
    const spinGroup = new THREE.Group();
    pitchGroup.add(spinGroup);
    const barrelParent: THREE.Object3D = spinGroup;
    // Barrels attach to spinGroup at Y=0 — pitchGroup's position already
    // lifts everything to barrelCenterY.
    const parentBaseY = 0;

    // Place one cylinder segment spanning (base) → (tip) in local coords. Used
    // for straight (gatling) and cone (shotgun) barrels alike.
    const pushSegment = (
      baseX: number, baseY: number, baseZ: number,
      tipX: number, tipY: number, tipZ: number,
    ): void => {
      const dx = tipX - baseX;
      const dy = tipY - baseY;
      const dz = tipZ - baseZ;
      const length = Math.hypot(dx, dy, dz);
      if (length < 1e-4) return;
      const m = new THREE.Mesh(this.barrelGeom, this.barrelMat);
      m.scale.set(cylRadius, length, cylRadius);
      m.position.set(
        (baseX + tipX) / 2,
        (baseY + tipY) / 2,
        (baseZ + tipZ) / 2,
      );
      // Align cylinder's default +Y axis with the (base→tip) direction.
      this._barrelUp.set(0, 1, 0);
      this._barrelDir.set(dx / length, dy / length, dz / length);
      m.quaternion.setFromUnitVectors(this._barrelUp, this._barrelDir);
      barrelParent.add(m);
      barrels.push(m);
    };

    const length = unitRadius * barrel.barrelLength;
    // barrelLength=0 (e.g. commander's d-gun "emitter") → no visible barrel.
    if (length < 1e-4) {
      parent.add(root);
      return { root, head, barrels, pitchGroup, spinGroup };
    }

    if (barrel.type === 'simpleSingleBarrel') {
      pushSegment(0, parentBaseY, 0, length, parentBaseY, 0);
    } else if (barrel.type === 'simpleMultiBarrel') {
      // Parallel barrels arranged in a YZ circle around the firing axis. The
      // barrelGroup's origin IS the firing axis (passes through the cluster
      // center), so rotating the group spins each barrel around that axis at
      // its own orbit radius — like a real gatling.
      const orbitR = Math.min(
        barrel.orbitRadius * unitRadius,
        TURRET_HEIGHT * 0.45,
      );
      const n = barrel.barrelCount;
      for (let i = 0; i < n; i++) {
        const a = (i + 0.5) / n * Math.PI * 2;
        const oy = Math.cos(a) * orbitR;
        const oz = Math.sin(a) * orbitR;
        pushSegment(0, parentBaseY + oy, oz, length, parentBaseY + oy, oz);
      }
    } else if (barrel.type === 'coneMultiBarrel') {
      // Barrels diverge from base orbit to a wider tip orbit — a 3D cone
      // analogue of the 2D shotgun's perpendicular spread. Same firing-axis
      // rotation center as the parallel case. Mirrors the primitive in
      // BarrelGeometry.getBarrelTip so the rendered barrel tips and the
      // sim-spawned shot origins land at the same point.
      const baseOrbitR = Math.min(
        barrel.baseOrbit * unitRadius,
        TURRET_HEIGHT * 0.35,
      );
      // Explicit `tipOrbit` is trusted as-authored (no clamp) so VLS
      // rocket pods can splay their tubes wider than the legacy
      // shotgun safety. The auto-derived path keeps its clamp.
      const tipOrbitR = barrel.tipOrbit !== undefined
        ? barrel.tipOrbit * unitRadius
        : Math.min(
            baseOrbitR + length * Math.tan((turret.config.spread?.angle ?? Math.PI / 5) / 2),
            TURRET_HEIGHT * 0.9,
          );
      const n = barrel.barrelCount;
      for (let i = 0; i < n; i++) {
        const a = (i + 0.5) / n * Math.PI * 2;
        const cosA = Math.cos(a);
        const sinA = Math.sin(a);
        pushSegment(
          0, parentBaseY + cosA * baseOrbitR, sinA * baseOrbitR,
          length, parentBaseY + cosA * tipOrbitR, sinA * tipOrbitR,
        );
      }
    }

    parent.add(root);
    return { root, head, barrels, pitchGroup, spinGroup };
  }

  // Scratch vectors reused across buildTurretMesh calls (no per-barrel allocations).
  private _barrelUp = new THREE.Vector3();
  private _barrelDir = new THREE.Vector3();

  /**
   * Build the mirror-panel slab set for a unit (e.g. Loris). Panels live in a
   * sub-group that rotates with the TURRET, not the chassis — mirror units'
   * armor plates follow the mirror emitter's aim, not the hull's heading.
   */
  private buildMirrorMesh(
    parent: THREE.Group,
    panels: readonly { halfWidth: number; halfHeight: number; offsetX: number; offsetY: number; angle: number }[],
    pid: PlayerId | undefined,
    gfx: GraphicsConfig,
    panelTopY: number,
  ): MirrorMesh {
    const root = new THREE.Group();
    parent.add(root);
    const meshes: THREE.Mesh[] = [];
    const mirrorHeight = Math.max(panelTopY - MIRROR_BASE_Y, 1);

    // Mirrors are always the super-shiny PBR chrome material — no LOD
    // downgrade to flat Lambert, and no orbital sparkle meshes; the
    // near-zero-roughness reflection IS the shine.
    void gfx;
    const mat = this.getMirrorShinyMat(pid);

    for (let i = 0; i < panels.length; i++) {
      const p = panels[i];
      const m = new THREE.Mesh(this.mirrorGeom, mat);
      // Default box +X runs along the "edge" (length); +Z runs along the
      // panel normal (thickness). Set local rotation.y = -(panel.angle + π/2)
      // so the combined chassis → mirrorRoot → panel transforms put the
      // edge in world direction (turret.rotation + panel.angle + π/2).
      // Euler order YXZ so the pitch (rotation.x) is applied INSIDE the
      // panel-local frame after the yaw flip — i.e. pitch rotates around
      // the panel's edge axis instead of the world X axis.
      m.rotation.order = 'YXZ';
      m.rotation.y = -(p.angle + Math.PI / 2);
      m.scale.set(p.halfWidth * 2, mirrorHeight, p.halfHeight * 2);
      m.position.set(p.offsetX, MIRROR_BASE_Y + mirrorHeight / 2, p.offsetY);
      root.add(m);
      meshes.push(m);
    }
    return { root, panels: meshes };
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

  private getSecondaryMat(pid: PlayerId | undefined): THREE.MeshLambertMaterial {
    if (pid === undefined) return this.neutralMat;
    let mat = this.secondaryMats.get(pid);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color: getPlayerColors(pid).secondary });
      this.secondaryMats.set(pid, mat);
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
    // Selection ring is parented to m.group and would be GC'd along with
    // it, but its per-unit ringMat is unique (created with new
    // MeshBasicMaterial each time the unit got selected) so dispose
    // explicitly to release the GPU resource.
    if (m.ringMat) {
      m.ringMat.dispose();
      m.ringMat = undefined;
    }
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
          const tm = this.buildTurretMesh(group, t, radius, pid, isMirrorHost, this.lod.gfx);
          if (tm.head) tm.head.userData.entityId = e.id;
          for (const b of tm.barrels) b.userData.entityId = e.id;
          turretMeshes.push(tm);
        }

        this.world.add(group);
        m = { group, chassis, chassisMeshes, turrets: turretMeshes, lodKey: this.lod.key };

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
          // Panel top is the unit's body top plus the turret head so
          // the mirror is flush with the tallest point of the unit.
          const panelTopY = bodyEntry.topY * radius + TURRET_HEIGHT + MIRROR_EXTRA_HEIGHT;
          m.mirrors = this.buildMirrorMesh(group, mirrorPanels, pid, this.lod.gfx, panelTopY);
          for (const panel of m.mirrors.panels) {
            panel.userData.entityId = e.id;
          }
        }

        this.unitMeshes.set(e.id, m);
      } else {
        const primaryMat = this.getPrimaryMat(pid);
        for (const mesh of m.chassisMeshes) mesh.material = primaryMat;
        for (const tm of m.turrets) {
          if (tm.head) tm.head.material = this.getSecondaryMat(pid);
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
      const rendererId = (() => {
        try { return getUnitBlueprint(e.unit!.unitType).renderer ?? 'arachnid'; }
        catch { return 'arachnid'; }
      })();
      const bodyEntry = getBodyGeom(rendererId);
      m.chassis.position.set(0, 0, 0);
      m.chassis.scale.setScalar(radius);
      // Turrets now mount on top of the per-unit body instead of a
      // shared CHASSIS_HEIGHT constant. Spheroid-bodied units like the
      // arachnid get a tall mount; squat polygons (scout, burst) get a
      // lower one.
      const bodyTopY = bodyEntry.topY * radius;

      // Selection ring (flat ring on ground under the unit)
      const selected = e.selectable?.selected === true;
      if (selected && !m.ring) {
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const ring = new THREE.Mesh(this.ringGeom, ringMat);
        ring.rotation.x = -Math.PI / 2;
        // Group is at ground; ring sits just above ground to avoid z-fighting.
        ring.position.y = 1;
        m.group.add(ring);
        m.ring = ring;
        m.ringMat = ringMat;
      } else if (!selected && m.ring) {
        m.group.remove(m.ring);
        m.ringMat?.dispose();
        m.ring = undefined;
        m.ringMat = undefined;
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
      for (let i = 0; i < m.turrets.length && i < turrets.length; i++) {
        const tm = m.turrets[i];
        const t = turrets[i];
        // Non-mirror turrets on mirror-host units sit ON TOP of the
        // mirror panel stack: root Y = mirror panel top in chassis-local
        // coords = bodyTopY + TURRET_HEIGHT + MIRROR_EXTRA_HEIGHT.
        const turretMountY = unitHasMirrorsHere && i > 0
          ? bodyTopY + TURRET_HEIGHT + MIRROR_EXTRA_HEIGHT
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

      // Mirror panels: track the first turret's rotation (same rule the
      // 2D LorisRenderer uses — `mirrorRot = turret?.rotation ?? bodyRot`).
      // Pitch tilts each panel around its edge axis so the panel's 3D
      // normal points at the beam source. With the panel mesh on Euler
      // order YXZ, rotation.x is applied AFTER the yaw flip — so it
      // genuinely rotates around the panel-local edge axis. The sign is
      // negated because positive sim/turret pitch (= "tilt up") in the
      // mesh frame corresponds to a negative Euler X rotation after the
      // yaw flip.
      if (m.mirrors) {
        const mirrorRot = turrets[0]?.rotation ?? e.transform.rotation;
        const mirrorPitch = turrets[0]?.pitch ?? 0;
        m.mirrors.root.rotation.y = -(mirrorRot - e.transform.rotation);
        for (const panel of m.mirrors.panels) {
          panel.rotation.x = -mirrorPitch;
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
      let mesh = this.projectileMeshes.get(e.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.projectileGeom, this.projectileMat);
        this.world.add(mesh);
        this.projectileMeshes.set(e.id, mesh);
      }

      // Projectile altitude is authoritative sim state (arcs through
      // real z from turret muzzle to ground / target). SHOT_HEIGHT is
      // no longer the truth — the sphere renders exactly where the
      // sim says it is.
      mesh.position.set(e.transform.x, e.transform.z, e.transform.y);
      // Match 2D: `fillCircle(x, y, radius)` — the sphere's world-space radius
      // equals the sim's shot.collision.radius. SphereGeometry has radius 1,
      // so setScalar(radius) is the correct scale. Barrel diameter (= 2·cylRadius
      // = shotRadius · 2 · BARREL_THICKNESS_MULTIPLIER) then sits naturally
      // inside the projectile, matching the 2D relationship.
      mesh.scale.setScalar(Math.max(radius, PROJECTILE_MIN_RADIUS));

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
    this.projMatCollision.dispose();
    this.projMatPrimary.dispose();
    this.projMatSecondary.dispose();
    this.mirrorGeom.dispose();
    for (const m of this.mirrorShinyMats.values()) m.dispose();
    this.mirrorShinyMats.clear();
    this.mirrorShinyNeutralMat.dispose();
    this.barrelMat.dispose();
    for (const m of this.primaryMats.values()) m.dispose();
    for (const m of this.secondaryMats.values()) m.dispose();
    this.neutralMat.dispose();
  }
}
