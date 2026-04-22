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

const UNIT_HEIGHT_MULT = 2.5;       // height = radius * this
const BUILDING_HEIGHT = 120;        // flat box depth for buildings
const PROJECTILE_Y_OFFSET = 40;     // projectiles float above ground
const PROJECTILE_SCALE = 2.5;       // exaggerate projectile visuals (tiny otherwise)
const TURRET_HEAD_SCALE = 0.55;     // turret head cube as fraction of chassis radius
const BARREL_THICKNESS_MULT = 0.18; // barrel radius as fraction of unit radius
const BARREL_COLOR = 0xffffff;

// Health bar sizing (world units)
const HP_BAR_WIDTH_MULT = 2.4;      // bar width ≈ radius · this
const HP_BAR_HEIGHT = 6;            // bar height in world units
const HP_BAR_Y_OFFSET = 12;         // gap above unit top

type HpBar = {
  root: THREE.Group;
  bg: THREE.Mesh;
  fg: THREE.Mesh;
};

type TurretMesh = {
  root: THREE.Group;       // positioned at turret.offset, rotated to turret rotation
  head: THREE.Mesh;
  barrels: THREE.Mesh[];
};

type EntityMesh = {
  group: THREE.Group;
  chassis: THREE.Mesh;
  turrets: TurretMesh[];
  ringMat?: THREE.MeshBasicMaterial;
  ring?: THREE.Mesh;
  hp?: HpBar;
};

export class Render3DEntities {
  private world: THREE.Group;
  private clientViewState: ClientViewState;
  private camera: THREE.Camera | null = null;

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
  // Thin ring for the selection indicator (flat, sits just above the ground plane)
  private ringGeom = new THREE.RingGeometry(0.9, 1.0, 28);
  // Health bar quads (shared geometry, per-instance materials colored by HP%)
  private hpBarGeom = new THREE.PlaneGeometry(1, 1);
  private hpBgMat = new THREE.MeshBasicMaterial({
    color: 0x1a1a1a,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
  });

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

  /** Set the camera used for billboarding HP bars. */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  /**
   * Build a turret mesh matching a single Turret's barrel configuration.
   * The turret's local +X is its firing direction; barrels point along +X.
   */
  private buildTurretMesh(
    parent: THREE.Group,
    turret: Turret,
    unitRadius: number,
    pid: PlayerId | undefined,
  ): TurretMesh {
    const root = new THREE.Group();
    const head = new THREE.Mesh(this.turretHeadGeom, this.getSecondaryMat(pid));
    head.userData.entityId = undefined; // will be set by caller
    const headSize = unitRadius * TURRET_HEAD_SCALE;
    head.scale.set(headSize * 2, headSize, headSize * 2);
    root.add(head);

    const barrels: THREE.Mesh[] = [];
    const barrel = turret.config.barrel;
    const thickness = unitRadius * BARREL_THICKNESS_MULT;

    const pushBarrel = (length: number, offsetY: number, offsetZ: number, radius = thickness): void => {
      const m = new THREE.Mesh(this.barrelGeom, this.barrelMat);
      // Cylinder default axis is +Y; rotate to align with +X (firing direction)
      m.rotation.z = -Math.PI / 2;
      m.scale.set(radius, length, radius);
      // Place so the barrel's base sits at local x=0 and tip at x=length
      m.position.set(length / 2, offsetY, offsetZ);
      root.add(m);
      barrels.push(m);
    };

    if (barrel) {
      if (barrel.type === 'simpleSingleBarrel') {
        const length = unitRadius * barrel.barrelLength;
        pushBarrel(length, 0, 0);
      } else if (
        barrel.type === 'simpleMultiBarrel' ||
        barrel.type === 'coneMultiBarrel'
      ) {
        const length = unitRadius * barrel.barrelLength;
        const orbitR =
          ('orbitRadius' in barrel ? barrel.orbitRadius : barrel.baseOrbit) *
          unitRadius;
        const n = barrel.barrelCount;
        // Offset by half-step so even counts are symmetric (no barrel stacked directly above another).
        const phase = Math.PI / 2;
        for (let i = 0; i < n; i++) {
          const a = phase + (i / n) * Math.PI * 2;
          const oy = Math.cos(a) * orbitR;
          const oz = Math.sin(a) * orbitR;
          pushBarrel(length, oy, oz);
        }
      }
      // complexSingleEmitter (force fields) has no physical barrel — skip
    }

    parent.add(root);
    return { root, head, barrels };
  }

  private buildHpBar(parent: THREE.Group): HpBar {
    const root = new THREE.Group();
    const bg = new THREE.Mesh(this.hpBarGeom, this.hpBgMat);
    bg.renderOrder = 10;
    root.add(bg);
    // Foreground uses a per-instance material so we can recolor (green→red) as
    // HP drops. Anchored to geometry center; scale.x drives bar fill, with
    // position.x offset to keep the left edge pinned to the bar's left side.
    const fgMat = new THREE.MeshBasicMaterial({
      color: 0x4cd964,
      depthTest: false,
      depthWrite: false,
    });
    const fg = new THREE.Mesh(this.hpBarGeom, fgMat);
    fg.renderOrder = 11;
    root.add(fg);
    parent.add(root);
    return { root, bg, fg };
  }

  private updateHpBar(
    m: EntityMesh,
    yTop: number,
    width: number,
    pct: number,
    parent: THREE.Group,
  ): void {
    if (pct >= 0.999 || pct <= 0) {
      // Full health or dead → hide bar
      if (m.hp) m.hp.root.visible = false;
      return;
    }
    if (!m.hp) m.hp = this.buildHpBar(parent);
    m.hp.root.visible = true;
    m.hp.root.position.set(0, yTop + HP_BAR_Y_OFFSET, 0);
    // Billboard to face the camera
    if (this.camera) m.hp.root.quaternion.copy(this.camera.quaternion);

    const h = HP_BAR_HEIGHT;
    m.hp.bg.scale.set(width, h, 1);
    m.hp.bg.position.set(0, 0, 0);

    // Foreground: scale x by percent; shift left so the left edge stays fixed
    const fgWidth = width * pct;
    m.hp.fg.scale.set(fgWidth, h * 0.85, 1);
    m.hp.fg.position.set(-(width - fgWidth) / 2, 0, 0.1);

    // Color fade: green → yellow → red as HP drops
    const mat = m.hp.fg.material as THREE.MeshBasicMaterial;
    if (pct > 0.5) mat.color.setRGB(0.3 + (1 - pct) * 1.4, 0.85, 0.25);
    else mat.color.setRGB(0.92, 0.25 + pct * 1.2, 0.2);
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
      // Use `scale` (visual) rather than `shot` (collider) for sizing, matching
      // what the 2D renderer uses. Fall back to `shot` if scale is missing.
      const radius = e.unit?.unitRadiusCollider.scale
        ?? e.unit?.unitRadiusCollider.shot
        ?? 15;
      const height = radius * UNIT_HEIGHT_MULT;
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
        this.unitMeshes.set(e.id, m);
      } else {
        m.chassis.material = this.getPrimaryMat(pid);
        for (const tm of m.turrets) tm.head.material = this.getSecondaryMat(pid);
      }

      // Position (sim Y → three Z)
      m.group.position.set(e.transform.x, height / 2, e.transform.y);
      m.group.rotation.y = -e.transform.rotation;

      // Chassis scale
      m.chassis.scale.set(radius, height, radius);

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
        // RingGeometry lies in XY plane by default → rotate flat onto the ground
        ring.rotation.x = -Math.PI / 2;
        // Relative to the unit group, ground is at -height/2
        ring.position.y = -height / 2 + 1;
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
      // (x, y) which map to (x, z) in three; positioned on top of the chassis.
      const turretBaseY = height / 2;
      for (let i = 0; i < m.turrets.length && i < turrets.length; i++) {
        const tm = m.turrets[i];
        const t = turrets[i];
        tm.root.position.set(t.offset.x, turretBaseY, t.offset.y);
        // Turret rotation in world = t.rotation. Expressed in the parent group
        // (which is rotated by -chassis.rotation around Y), the local Y rotation
        // needs to be negated(diff) so the local +X points in the world firing
        // direction. See derivation in comment above buildTurretMesh.
        tm.root.rotation.y = -(t.rotation - e.transform.rotation);
      }

      // Health bar billboarded above the unit
      const hp = e.unit?.hp ?? 0;
      const maxHp = e.unit?.maxHp ?? 1;
      this.updateHpBar(
        m,
        height / 2,
        radius * HP_BAR_WIDTH_MULT,
        maxHp > 0 ? hp / maxHp : 0,
        m.group,
      );
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

      m.group.position.set(e.transform.x, h / 2, e.transform.y);
      m.group.rotation.y = -e.transform.rotation;
      m.chassis.scale.set(w, h, d);

      const bhp = e.building?.hp ?? 0;
      const bmaxHp = e.building?.maxHp ?? 1;
      this.updateHpBar(
        m,
        h / 2,
        Math.max(w, d) * 1.2,
        bmaxHp > 0 ? bhp / bmaxHp : 0,
        m.group,
      );
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
      seen.add(e.id);
      const shot = e.projectile?.config.shot;
      // Projectile shots have collision.radius; beam/laser shots have radius directly
      let radius = 4;
      if (shot) {
        if (shot.type === 'projectile') radius = shot.collision.radius;
        else if (shot.type === 'beam' || shot.type === 'laser') radius = shot.radius;
      }
      const pid = e.projectile?.ownerId;

      let mesh = this.projectileMeshes.get(e.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.projectileGeom, this.getSecondaryMat(pid));
        this.world.add(mesh);
        this.projectileMeshes.set(e.id, mesh);
      } else {
        mesh.material = this.getSecondaryMat(pid);
      }

      mesh.position.set(e.transform.x, PROJECTILE_Y_OFFSET, e.transform.y);
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
    for (const m of this.unitMeshes.values()) {
      if (m.hp) (m.hp.fg.material as THREE.MeshBasicMaterial).dispose();
      this.world.remove(m.group);
    }
    for (const m of this.buildingMeshes.values()) {
      if (m.hp) (m.hp.fg.material as THREE.MeshBasicMaterial).dispose();
      this.world.remove(m.group);
    }
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
    this.hpBarGeom.dispose();
    this.hpBgMat.dispose();
    this.barrelMat.dispose();
    for (const m of this.primaryMats.values()) m.dispose();
    for (const m of this.secondaryMats.values()) m.dispose();
    this.neutralMat.dispose();
  }
}
