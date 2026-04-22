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
import type { EntityId, PlayerId, Turret } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';
import type { SpinConfig } from '../../config';
import type { ClientViewState } from '../network/ClientViewState';

// All units share the same chassis and turret *heights*; only the horizontal
// footprint (radius) varies with the unit's collider scale. That lets projectile
// Y be a single constant aligned with the barrel tips — so shots visibly
// originate from the ends of the turret barrels instead of the chassis center.
const CHASSIS_HEIGHT = 28;           // Y extent of every unit chassis
const TURRET_HEIGHT = 16;            // Y extent of every turret head
const SHOT_HEIGHT = CHASSIS_HEIGHT + TURRET_HEIGHT / 2; // world Y of projectiles/barrel tips

const BUILDING_HEIGHT = 120;
const PROJECTILE_MIN_RADIUS = 1.5;   // floor so very-small shots stay visible
const TURRET_HEAD_FOOTPRINT = 0.55;  // head X/Z footprint as fraction of chassis radius
const BARREL_COLOR = 0xffffff;
const BARREL_MIN_THICKNESS = 2;      // fallback when blueprint didn't set one

// Mirror panels (reflective mirror-unit armor plates): standing rectangular
// slabs positioned in the unit's TURRET frame (not chassis frame), since the
// turret/mirror rotates independently of the hull.
const MIRROR_HEIGHT = 24;            // Y extent of a mirror panel (standing slab)
const MIRROR_BASE_Y = 2;             // bottom of the mirror panel above ground

type TurretMesh = {
  root: THREE.Group;       // positioned at turret.offset, rotated to turret rotation
  /** Absent for turrets without a "body" — force fields (the glowing sphere
   *  is the whole visual) and mirror units (the mirror panels are). */
  head?: THREE.Mesh;
  barrels: THREE.Mesh[];
  /** Present for multi-barrel turrets: a sub-group containing the barrel
   *  cylinders. Rotating this around local +X spins the whole barrel cluster
   *  around the firing axis (the gatling effect). */
  barrelGroup?: THREE.Group;
};

type MirrorMesh = {
  /** Rotates with the turret (children of this rotate in turret frame). */
  root: THREE.Group;
  panels: THREE.Mesh[];
};

type EntityMesh = {
  group: THREE.Group;
  chassis: THREE.Mesh;
  turrets: TurretMesh[];
  mirrors?: MirrorMesh;
  ringMat?: THREE.MeshBasicMaterial;
  ring?: THREE.Mesh;
};

export class Render3DEntities {
  private world: THREE.Group;
  private clientViewState: ClientViewState;

  private unitMeshes = new Map<number, EntityMesh>();
  private buildingMeshes = new Map<number, EntityMesh>();
  private projectileMeshes = new Map<number, THREE.Mesh>();

  // Per-unit barrel-spin state (one per unit with any multi-barrel turret).
  // Angle advances by `speed` radians/sec; speed accelerates toward
  // spinConfig.max while any turret on the unit is engaged, decelerates toward
  // spinConfig.idle otherwise. Mirrors the 2D barrel-spin system exactly.
  private barrelSpins = new Map<EntityId, { angle: number; speed: number }>();
  private _lastSpinMs = performance.now();

  // Shared geometries & per-team materials (avoid per-entity allocation)
  private unitGeom = new THREE.CylinderGeometry(1, 1, 1, 20);
  // Turret head: a cylinder (not a box) — matches the unit's circular chassis
  // profile from above so the 3D silhouette looks like a turret, not a brick.
  private turretHeadGeom = new THREE.CylinderGeometry(1, 1, 1, 18);
  private barrelGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  private projectileGeom = new THREE.SphereGeometry(1, 10, 8);
  private buildingGeom = new THREE.BoxGeometry(1, 1, 1);
  private barrelMat = new THREE.MeshLambertMaterial({ color: BARREL_COLOR });
  private mirrorGeom = new THREE.BoxGeometry(1, 1, 1);
  // Thin ring for the selection indicator (flat, sits just above the ground plane)
  private ringGeom = new THREE.RingGeometry(0.9, 1.0, 28);

  private primaryMats = new Map<PlayerId, THREE.MeshLambertMaterial>();
  private secondaryMats = new Map<PlayerId, THREE.MeshLambertMaterial>();
  private neutralMat = new THREE.MeshLambertMaterial({ color: 0x888888 });

  constructor(world: THREE.Group, clientViewState: ClientViewState) {
    this.world = world;
    this.clientViewState = clientViewState;

    for (const [pidStr, colors] of Object.entries(PLAYER_COLORS)) {
      const pid = Number(pidStr) as PlayerId;
      this.primaryMats.set(
        pid,
        new THREE.MeshLambertMaterial({ color: colors.primary }),
      );
      this.secondaryMats.set(
        pid,
        new THREE.MeshLambertMaterial({ color: colors.secondary }),
      );
    }
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
  ): TurretMesh {
    const root = new THREE.Group();
    const barrel = turret.config.barrel;
    const isForceField = barrel?.type === 'complexSingleEmitter';

    // Skip the head cylinder entirely for:
    //  - force-field turrets: the ForceFieldRenderer3D's glowing sphere is
    //    the whole visual; a cylinder just sits inside it and clips through.
    //  - the mirror-host turret on mirror units (Loris index 0): the mirror
    //    panels already represent that turret's body. Other turrets on the
    //    same unit (e.g. Loris's lightTurret) still get their cylinder.
    const hideHead = isForceField || isMirrorHost;

    let head: THREE.Mesh | undefined;
    if (!hideHead) {
      head = new THREE.Mesh(this.turretHeadGeom, this.getSecondaryMat(pid));
      const headRadius = unitRadius * TURRET_HEAD_FOOTPRINT;
      // CylinderGeometry has radius 1 → scale x/z become the actual radius.
      // Keep x and z equal so the head is a round turret top, not an ellipse.
      head.scale.set(headRadius, TURRET_HEIGHT, headRadius);
      head.position.set(0, TURRET_HEIGHT / 2, 0);
      root.add(head);
    }

    const barrels: THREE.Mesh[] = [];
    if (!barrel || isForceField) {
      // Force-field turrets don't have a physical barrel.
      parent.add(root);
      return { root, head, barrels, barrelGroup: undefined };
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

    // Multi-barrel types get a dedicated sub-group so the whole cluster can
    // rotate around the firing axis (+X) to produce the gatling spin effect.
    // The group is positioned at (0, barrelCenterY, 0) so its local X axis
    // passes through the center of the barrel cluster — i.e. exactly where a
    // single barrel would sit. Barrels added to the group use zero Y/Z offset
    // from that center, so `rotation.x` orbits each barrel around the firing
    // axis at the correct radius.
    // Single barrels don't spin, so they're parented to the turret root
    // directly and positioned with the raw barrelCenterY offset.
    const isMultiBarrel =
      barrel.type === 'simpleMultiBarrel' || barrel.type === 'coneMultiBarrel';
    let barrelGroup: THREE.Group | undefined;
    if (isMultiBarrel) {
      barrelGroup = new THREE.Group();
      barrelGroup.position.set(0, barrelCenterY, 0);
      root.add(barrelGroup);
    }
    const barrelParent: THREE.Object3D = barrelGroup ?? root;
    // When inside barrelGroup the parent is already elevated to barrelCenterY,
    // so barrel coords should omit that offset. Single-barrel cylinders (no
    // group) still need to include it.
    const parentBaseY = barrelGroup ? 0 : barrelCenterY;

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
      return { root, head, barrels, barrelGroup };
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
      // rotation center as the parallel case.
      const baseOrbitR = Math.min(
        barrel.baseOrbit * unitRadius,
        TURRET_HEIGHT * 0.35,
      );
      const spreadHalf = (turret.config.spread?.angle ?? Math.PI / 5) / 2;
      const tipOrbitR = Math.min(
        baseOrbitR + length * Math.tan(spreadHalf),
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
    return { root, head, barrels, barrelGroup };
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
  ): MirrorMesh {
    const root = new THREE.Group();
    parent.add(root);
    const meshes: THREE.Mesh[] = [];
    const mat = this.getSecondaryMat(pid);
    for (const p of panels) {
      const m = new THREE.Mesh(this.mirrorGeom, mat);
      // Default box +X runs along the "edge" (length); +Z runs along the
      // panel normal (thickness). Set local rotation.y = -(panel.angle + π/2)
      // so the combined chassis → mirrorRoot → panel transforms put the
      // edge in world direction (turret.rotation + panel.angle + π/2).
      m.rotation.y = -(p.angle + Math.PI / 2);
      m.scale.set(p.halfWidth * 2, MIRROR_HEIGHT, p.halfHeight * 2);
      m.position.set(p.offsetX, MIRROR_BASE_Y + MIRROR_HEIGHT / 2, p.offsetY);
      root.add(m);
      meshes.push(m);
    }
    return { root, panels: meshes };
  }

  private getPrimaryMat(pid: PlayerId | undefined): THREE.MeshLambertMaterial {
    if (pid === undefined) return this.neutralMat;
    return this.primaryMats.get(pid) ?? this.neutralMat;
  }

  private getSecondaryMat(pid: PlayerId | undefined): THREE.MeshLambertMaterial {
    if (pid === undefined) return this.neutralMat;
    return this.secondaryMats.get(pid) ?? this.neutralMat;
  }

  update(): void {
    // Time step for continuous-rotation effects (barrel spin). Clamp in case
    // the tab was backgrounded.
    const now = performance.now();
    const spinDt = Math.min((now - this._lastSpinMs) / 1000, 0.1);
    this._lastSpinMs = now;

    this.updateBarrelSpins(spinDt);
    this.updateUnits();
    this.updateBuildings();
    this.updateProjectiles();
  }

  /**
   * Advance each unit's barrel-spin state (angle, speed). Mirrors the 2D
   * updateBarrelSpins loop exactly: pick the first multi-barrel turret on
   * each unit for its spin config, accelerate toward max while any turret
   * is engaged, decelerate toward idle otherwise.
   */
  private updateBarrelSpins(dt: number): void {
    const units = this.clientViewState.getUnits();
    const seen = new Set<EntityId>();

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
    const seen = new Set<number>();

    for (const e of units) {
      seen.add(e.id);
      // Use `scale` (visual) rather than `shot` (collider) for horizontal
      // footprint, matching the 2D renderer. Vertical sizing is fixed —
      // every unit chassis uses CHASSIS_HEIGHT, every turret TURRET_HEIGHT —
      // so all barrel tips (and therefore projectile spawns) align at
      // SHOT_HEIGHT in world Y.
      const radius = e.unit?.unitRadiusCollider.scale
        ?? e.unit?.unitRadiusCollider.shot
        ?? 15;
      const pid = e.ownership?.playerId;
      const turrets = e.turrets ?? [];

      let m = this.unitMeshes.get(e.id);
      if (!m) {
        const group = new THREE.Group();
        const chassis = new THREE.Mesh(this.unitGeom, this.getPrimaryMat(pid));
        // Tag for raycast picking — maps mesh back to entity id
        chassis.userData.entityId = e.id;
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
          const tm = this.buildTurretMesh(group, t, radius, pid, isMirrorHost);
          if (tm.head) tm.head.userData.entityId = e.id;
          for (const b of tm.barrels) b.userData.entityId = e.id;
          turretMeshes.push(tm);
        }

        this.world.add(group);
        m = { group, chassis, turrets: turretMeshes };

        // Mirror panels (e.g. Loris): standing slabs that track the turret.
        const mirrorPanels = e.unit?.mirrorPanels;
        if (mirrorPanels && mirrorPanels.length > 0) {
          m.mirrors = this.buildMirrorMesh(group, mirrorPanels, pid);
          for (const panel of m.mirrors.panels) {
            panel.userData.entityId = e.id;
          }
        }

        this.unitMeshes.set(e.id, m);
      } else {
        m.chassis.material = this.getPrimaryMat(pid);
        for (const tm of m.turrets) {
          if (tm.head) tm.head.material = this.getSecondaryMat(pid);
        }
      }

      // Position group at the ground; children position themselves relative
      // to it. (Previously the group was offset to the chassis center; moving
      // it to the ground simplifies ring/HP-bar/turret Y calcs.)
      m.group.position.set(e.transform.x, 0, e.transform.y);
      m.group.rotation.y = -e.transform.rotation;

      // Chassis sits on the ground: center at CHASSIS_HEIGHT/2, scaled to
      // (radius, CHASSIS_HEIGHT, radius) so footprint varies but height is
      // fixed across all units.
      m.chassis.position.set(0, CHASSIS_HEIGHT / 2, 0);
      m.chassis.scale.set(radius, CHASSIS_HEIGHT, radius);

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

      // Per-turret placement. Turret offset is chassis-local in sim coords
      // (x, y) which map to (x, z) in three. Root Y sits at the top of the
      // chassis; the head + barrels extend upward from there inside the root.
      const spinState = this.barrelSpins.get(e.id);
      for (let i = 0; i < m.turrets.length && i < turrets.length; i++) {
        const tm = m.turrets[i];
        const t = turrets[i];
        tm.root.position.set(t.offset.x, CHASSIS_HEIGHT, t.offset.y);
        // Turret's world firing direction = t.rotation. Parent group is already
        // rotated by -chassis.rotation, so we compensate: child local Y rot =
        // -(t.rotation - chassis.rotation), which makes local +X point in the
        // correct world firing direction after both rotations compose.
        tm.root.rotation.y = -(t.rotation - e.transform.rotation);
        // Gatling-style barrel spin: rotate the whole barrel cluster around
        // its local +X axis (the firing direction). Barrel positions orbit
        // around the axis; their orientations stay pointing forward.
        if (tm.barrelGroup) {
          tm.barrelGroup.rotation.x = spinState?.angle ?? 0;
        }
      }

      // Mirror panels: track the first turret's rotation (same rule the 2D
      // LorisRenderer uses — `mirrorRot = turret?.rotation ?? bodyRot`).
      if (m.mirrors) {
        const mirrorRot = turrets[0]?.rotation ?? e.transform.rotation;
        m.mirrors.root.rotation.y = -(mirrorRot - e.transform.rotation);
      }

      // Health bar handled by the shared HealthBarOverlay (SVG layer).
    }

    // Remove meshes for units no longer present
    for (const [id, m] of this.unitMeshes) {
      if (!seen.has(id)) {
        this.world.remove(m.group);
        this.unitMeshes.delete(id);
      }
    }
  }

  private updateBuildings(): void {
    const buildings = this.clientViewState.getBuildings();
    const seen = new Set<number>();

    for (const e of buildings) {
      seen.add(e.id);
      const w = e.building?.width ?? 100;
      const d = e.building?.height ?? 100;
      const h = BUILDING_HEIGHT;
      const pid = e.ownership?.playerId;

      let m = this.buildingMeshes.get(e.id);
      if (!m) {
        const group = new THREE.Group();
        const box = new THREE.Mesh(this.buildingGeom, this.getPrimaryMat(pid));
        box.userData.entityId = e.id;
        group.add(box);
        this.world.add(group);
        m = { group, chassis: box, turrets: [] };
        this.buildingMeshes.set(e.id, m);
      } else {
        m.chassis.material = this.getPrimaryMat(pid);
      }

      // Group at ground; box elevated inside so it sits on the ground plane.
      m.group.position.set(e.transform.x, 0, e.transform.y);
      m.group.rotation.y = -e.transform.rotation;
      m.chassis.position.set(0, h / 2, 0);
      m.chassis.scale.set(w, h, d);
      // Health bar handled by the shared HealthBarOverlay.
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
    const seen = new Set<number>();

    for (const e of projectiles) {
      // Skip beams/lasers — handled by BeamRenderer3D as line segments rather
      // than spheres. Without this, long-range beams would render as a single
      // sphere at the wrong position.
      const pt = e.projectile?.projectileType;
      if (pt === 'beam' || pt === 'laser') continue;

      seen.add(e.id);
      const shot = e.projectile?.config.shot;
      // Projectile shots have collision.radius
      let radius = 4;
      if (shot && shot.type === 'projectile') radius = shot.collision.radius;
      const pid = e.projectile?.ownerId;

      let mesh = this.projectileMeshes.get(e.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.projectileGeom, this.getSecondaryMat(pid));
        this.world.add(mesh);
        this.projectileMeshes.set(e.id, mesh);
      } else {
        mesh.material = this.getSecondaryMat(pid);
      }

      mesh.position.set(e.transform.x, SHOT_HEIGHT, e.transform.y);
      // Match 2D: `fillCircle(x, y, radius)` — the sphere's world-space radius
      // equals the sim's shot.collision.radius. SphereGeometry has radius 1,
      // so setScalar(radius) is the correct scale. Barrel diameter (= 2·cylRadius
      // = shotRadius · 2 · BARREL_THICKNESS_MULTIPLIER) then sits naturally
      // inside the projectile, matching the 2D relationship.
      mesh.scale.setScalar(Math.max(radius, PROJECTILE_MIN_RADIUS));
    }

    for (const [id, mesh] of this.projectileMeshes) {
      if (!seen.has(id)) {
        this.world.remove(mesh);
        this.projectileMeshes.delete(id);
      }
    }
  }

  destroy(): void {
    for (const m of this.unitMeshes.values()) this.world.remove(m.group);
    for (const m of this.buildingMeshes.values()) this.world.remove(m.group);
    for (const mesh of this.projectileMeshes.values()) this.world.remove(mesh);
    this.unitMeshes.clear();
    this.buildingMeshes.clear();
    this.projectileMeshes.clear();
    this.unitGeom.dispose();
    this.turretHeadGeom.dispose();
    this.barrelGeom.dispose();
    this.projectileGeom.dispose();
    this.buildingGeom.dispose();
    this.ringGeom.dispose();
    this.mirrorGeom.dispose();
    this.barrelMat.dispose();
    for (const m of this.primaryMats.values()) m.dispose();
    for (const m of this.secondaryMats.values()) m.dispose();
    this.neutralMat.dispose();
  }
}
