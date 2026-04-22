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
import type { PlayerId, Turret } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';

// All units share the same chassis and turret *heights*; only the horizontal
// footprint (radius) varies with the unit's collider scale. That lets projectile
// Y be a single constant aligned with the barrel tips — so shots visibly
// originate from the ends of the turret barrels instead of the chassis center.
const CHASSIS_HEIGHT = 28;           // Y extent of every unit chassis
const TURRET_HEIGHT = 16;            // Y extent of every turret head
const SHOT_HEIGHT = CHASSIS_HEIGHT + TURRET_HEIGHT / 2; // world Y of projectiles/barrel tips

const BUILDING_HEIGHT = 120;
const PROJECTILE_SCALE = 2.5;
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
  head: THREE.Mesh;
  barrels: THREE.Mesh[];
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

  // Shared geometries & per-team materials (avoid per-entity allocation)
  private unitGeom = new THREE.CylinderGeometry(1, 1, 1, 20);
  private turretHeadGeom = new THREE.BoxGeometry(1, 1, 1);
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
  ): TurretMesh {
    const root = new THREE.Group();
    // Turret root is placed at the top of the chassis. The head sits ON the
    // root (extends upward by TURRET_HEIGHT), and barrels emerge from the
    // head's vertical center — so barrel tips line up with SHOT_HEIGHT.
    const head = new THREE.Mesh(this.turretHeadGeom, this.getSecondaryMat(pid));
    const headFootprint = unitRadius * TURRET_HEAD_FOOTPRINT;
    head.scale.set(headFootprint * 2, TURRET_HEIGHT, headFootprint * 2.5);
    head.position.set(0, TURRET_HEIGHT / 2, 0);
    root.add(head);

    const barrels: THREE.Mesh[] = [];
    const barrel = turret.config.barrel;
    if (!barrel || barrel.type === 'complexSingleEmitter') {
      // Force-field turrets don't have a physical barrel.
      parent.add(root);
      return { root, head, barrels };
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
      root.add(m);
      barrels.push(m);
    };

    const length = unitRadius * barrel.barrelLength;
    // barrelLength=0 (e.g. commander's d-gun "emitter") → no visible barrel.
    if (length < 1e-4) {
      parent.add(root);
      return { root, head, barrels };
    }

    if (barrel.type === 'simpleSingleBarrel') {
      pushSegment(0, barrelCenterY, 0, length, barrelCenterY, 0);
    } else if (barrel.type === 'simpleMultiBarrel') {
      // Parallel barrels arranged in a YZ circle around the firing axis.
      const orbitR = Math.min(
        barrel.orbitRadius * unitRadius,
        TURRET_HEIGHT * 0.45,
      );
      const n = barrel.barrelCount;
      for (let i = 0; i < n; i++) {
        const a = (i + 0.5) / n * Math.PI * 2;
        const oy = Math.cos(a) * orbitR;
        const oz = Math.sin(a) * orbitR;
        pushSegment(0, barrelCenterY + oy, oz, length, barrelCenterY + oy, oz);
      }
    } else if (barrel.type === 'coneMultiBarrel') {
      // Barrels diverge from base orbit to a wider tip orbit — a 3D cone
      // analogue of the 2D shotgun's perpendicular spread.
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
          0, barrelCenterY + cosA * baseOrbitR, sinA * baseOrbitR,
          length, barrelCenterY + cosA * tipOrbitR, sinA * tipOrbitR,
        );
      }
    }

    parent.add(root);
    return { root, head, barrels };
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
    this.updateUnits();
    this.updateBuildings();
    this.updateProjectiles();
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
        // has a head box + barrel cylinders matching its barrel config.
        const turretMeshes: TurretMesh[] = [];
        for (const t of turrets) {
          const tm = this.buildTurretMesh(group, t, radius, pid);
          tm.head.userData.entityId = e.id;
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
        for (const tm of m.turrets) tm.head.material = this.getSecondaryMat(pid);
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
      for (let i = 0; i < m.turrets.length && i < turrets.length; i++) {
        const tm = m.turrets[i];
        const t = turrets[i];
        tm.root.position.set(t.offset.x, CHASSIS_HEIGHT, t.offset.y);
        // Turret's world firing direction = t.rotation. Parent group is already
        // rotated by -chassis.rotation, so we compensate: child local Y rot =
        // -(t.rotation - chassis.rotation), which makes local +X point in the
        // correct world firing direction after both rotations compose.
        tm.root.rotation.y = -(t.rotation - e.transform.rotation);
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
      mesh.scale.setScalar(Math.max(radius, 2) * PROJECTILE_SCALE);
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
