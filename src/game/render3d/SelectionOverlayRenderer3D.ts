import * as THREE from 'three';
import { getRangeToggle, getUnitRadiusToggle } from '@/clientBarConfig';
import { LAND_CELL_SIZE } from '../../config';
import type { Entity } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';
import { getUnitBodyCenterHeight, getUnitGroundZ } from '../sim/unitGeometry';
import { getTurretWorldMount } from '../math/MountGeometry';
import { getTurretMountHeight } from '../sim/combat/combatUtils';
import type { TurretMesh } from './TurretMesh3D';
import type { EntityMesh, RadiusRingMeshes } from './EntityMesh3D';

const RANGE_CIRCLE_SEGMENTS = 96;
const RANGE_CIRCLE_GROUND_LIFT = 6;
const RANGE_CIRCLE_RENDER_ORDER = 20;
const FLAT_SURFACE_NORMAL = { nx: 0, ny: 0, nz: 1 };

export type OverlayEntityMesh = Pick<
  EntityMesh,
  | 'group'
  | 'turrets'
  | 'ring'
  | 'radiusRings'
  | 'radiusRingsVisible'
  | 'buildRing'
  | 'rangeRingsVisible'
>;

function makeRangeCircleGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(RANGE_CIRCLE_SEGMENTS * 2 * 3);
  let offset = 0;
  for (let i = 0; i < RANGE_CIRCLE_SEGMENTS; i++) {
    const a0 = (i / RANGE_CIRCLE_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / RANGE_CIRCLE_SEGMENTS) * Math.PI * 2;
    positions[offset++] = Math.cos(a0);
    positions[offset++] = 0;
    positions[offset++] = Math.sin(a0);
    positions[offset++] = Math.cos(a1);
    positions[offset++] = 0;
    positions[offset++] = Math.sin(a1);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geom;
}

function makeRangeCircleMaterial(color: number, opacity: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
  });
}

export class SelectionOverlayRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly radiusSphereGeom: THREE.BufferGeometry;

  private readonly ringGeom = new THREE.TorusGeometry(1.0, 0.06, 8, 36);
  private readonly rangeCircleGeom = makeRangeCircleGeometry();
  private readonly radiusMatScale = new THREE.LineBasicMaterial({
    color: 0x44ffff, transparent: true, opacity: 0.7, depthWrite: false,
  });
  private readonly radiusMatShot = new THREE.LineBasicMaterial({
    color: 0xff44ff, transparent: true, opacity: 0.7, depthWrite: false,
  });
  private readonly radiusMatPush = new THREE.LineBasicMaterial({
    color: 0x44ff44, transparent: true, opacity: 0.7, depthWrite: false,
  });
  private readonly ringMatTrackAcquire = makeRangeCircleMaterial(0xffff88, 0.55);
  private readonly ringMatTrackRelease = makeRangeCircleMaterial(0xffff88, 0.35);
  private readonly ringMatEngageAcquire = makeRangeCircleMaterial(0xff4444, 0.65);
  private readonly ringMatEngageRelease = makeRangeCircleMaterial(0x44aaff, 0.55);
  private readonly ringMatEngageMinAcquire = makeRangeCircleMaterial(0xff8800, 0.65);
  private readonly ringMatEngageMinRelease = makeRangeCircleMaterial(0xaa44ff, 0.55);
  private readonly ringMatBuild = makeRangeCircleMaterial(0x44ff44, 0.65);
  private readonly selectionRingMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: 0x333333,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });

  constructor(options: {
    world: THREE.Group;
    clientViewState: ClientViewState;
    radiusSphereGeom: THREE.BufferGeometry;
  }) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.radiusSphereGeom = options.radiusSphereGeom;
  }

  updateSelectionRing(m: OverlayEntityMesh, selected: boolean, radius: number): void {
    if (selected && !m.ring) {
      const ring = new THREE.Mesh(this.ringGeom, this.selectionRingMat);
      ring.rotation.x = Math.PI / 2;
      m.group.add(ring);
      m.ring = ring;
    } else if (!selected && m.ring) {
      m.group.remove(m.ring);
      m.ring = undefined;
    }
    if (!m.ring) return;
    m.ring.scale.setScalar(radius);
    m.ring.position.set(0, radius * 0.06 + 0.8, 0);
  }

  updateUnitRadiusRings(m: OverlayEntityMesh, entity: Entity): void {
    const showScale = getUnitRadiusToggle('visual');
    const showShot = getUnitRadiusToggle('shot');
    const showPush = getUnitRadiusToggle('push');
    if (!showScale && !showShot && !showPush) {
      if (m.radiusRingsVisible && m.radiusRings) {
        if (m.radiusRings.scale) m.radiusRings.scale.visible = false;
        if (m.radiusRings.shot) m.radiusRings.shot.visible = false;
        if (m.radiusRings.push) m.radiusRings.push.visible = false;
      }
      m.radiusRingsVisible = false;
      return;
    }

    const collider = entity.unit?.radius;
    if (!entity.unit || !collider) return;

    const rings = m.radiusRings ?? (m.radiusRings = {});
    const centerY = getUnitBodyCenterHeight(entity.unit);

    this.setUnitRadiusSphere(
      rings, 'scale', showScale, m.group,
      centerY, entity.unit.radius.body, this.radiusMatScale,
    );
    this.setUnitRadiusSphere(
      rings, 'shot', showShot, m.group,
      centerY, collider.shot, this.radiusMatShot,
    );
    this.setUnitRadiusSphere(
      rings, 'push', showPush, m.group,
      centerY, collider.push, this.radiusMatPush,
    );
    m.radiusRingsVisible = true;
  }

  updateRangeRings(m: OverlayEntityMesh, entity: Entity): void {
    if (!entity.unit && !entity.building) return;

    const showTrackAcquire = getRangeToggle('trackAcquire');
    const showTrackRelease = getRangeToggle('trackRelease');
    const showEngageAcquire = getRangeToggle('engageAcquire');
    const showEngageRelease = getRangeToggle('engageRelease');
    const showEngageMinAcquire = getRangeToggle('engageMinAcquire');
    const showEngageMinRelease = getRangeToggle('engageMinRelease');
    const showBuild = getRangeToggle('build');
    const showAnyTurretRange =
      showTrackAcquire || showTrackRelease
      || showEngageAcquire || showEngageRelease
      || showEngageMinAcquire || showEngageMinRelease;
    if (!showAnyTurretRange && !showBuild) {
      if (m.rangeRingsVisible) this.hideRangeRings(m);
      m.rangeRingsVisible = false;
      return;
    }

    const ux = entity.transform.x;
    const uy = entity.transform.y;
    const mapWidth = this.clientViewState.getMapWidth();
    const mapHeight = this.clientViewState.getMapHeight();
    const unitGroundZ = getSurfaceHeight(ux, uy, mapWidth, mapHeight, LAND_CELL_SIZE)
      + RANGE_CIRCLE_GROUND_LIFT;

    if (showAnyTurretRange && entity.combat) {
      const cos = Math.cos(entity.transform.rotation);
      const sin = Math.sin(entity.transform.rotation);
      const turrets = entity.combat.turrets;
      for (let i = 0; i < turrets.length; i++) {
        const weapon = turrets[i];
        if (weapon.config.visualOnly) continue;
        const tm = m.turrets[i];
        if (!tm) continue;
        const mountSurfaceNormal = entity.unit
          ? entity.unit.surfaceNormal ?? getSurfaceNormal(
              ux, uy,
              mapWidth,
              mapHeight,
              LAND_CELL_SIZE,
            )
          : FLAT_SURFACE_NORMAL;
        const mount = getTurretWorldMount(
          ux, uy, getUnitGroundZ(entity),
          cos, sin,
          weapon.mount.x, weapon.mount.y, getTurretMountHeight(entity, i),
          mountSurfaceNormal,
        );
        const mountX = mount.x;
        const mountY = mount.y;
        const mountGroundZ = getSurfaceHeight(mountX, mountY, mapWidth, mapHeight, LAND_CELL_SIZE)
          + RANGE_CIRCLE_GROUND_LIFT;

        this.setRangeCircle(
          tm, 'trackAcquire', showTrackAcquire, mountX, mountY, mountGroundZ,
          weapon.ranges.tracking?.acquire ?? null, this.ringMatTrackAcquire,
        );
        this.setRangeCircle(
          tm, 'trackRelease', showTrackRelease, mountX, mountY, mountGroundZ,
          weapon.ranges.tracking?.release ?? null, this.ringMatTrackRelease,
        );
        this.setRangeCircle(
          tm, 'engageAcquire', showEngageAcquire, mountX, mountY, mountGroundZ,
          weapon.ranges.fire.max.acquire, this.ringMatEngageAcquire,
        );
        this.setRangeCircle(
          tm, 'engageRelease', showEngageRelease, mountX, mountY, mountGroundZ,
          weapon.ranges.fire.max.release, this.ringMatEngageRelease,
        );
        this.setRangeCircle(
          tm, 'engageMinAcquire', showEngageMinAcquire, mountX, mountY, mountGroundZ,
          weapon.ranges.fire.min?.acquire ?? null, this.ringMatEngageMinAcquire,
        );
        this.setRangeCircle(
          tm, 'engageMinRelease', showEngageMinRelease, mountX, mountY, mountGroundZ,
          weapon.ranges.fire.min?.release ?? null, this.ringMatEngageMinRelease,
        );
      }
    } else if (m.rangeRingsVisible) {
      this.hideTurretRangeRings(m);
    }

    const builder = entity.builder;
    if (showBuild && builder) {
      if (!m.buildRing) {
        m.buildRing = new THREE.LineSegments(this.rangeCircleGeom, this.ringMatBuild);
        m.buildRing.renderOrder = RANGE_CIRCLE_RENDER_ORDER;
        this.world.add(m.buildRing);
      }
      m.buildRing.visible = true;
      m.buildRing.position.set(ux, unitGroundZ, uy);
      m.buildRing.scale.setScalar(builder.buildRange);
    } else if (m.buildRing) {
      m.buildRing.visible = false;
    }
    m.rangeRingsVisible = showAnyTurretRange || (showBuild && builder !== undefined);
  }

  removeWorldParentedOverlays(m: OverlayEntityMesh): void {
    if (m.buildRing) this.world.remove(m.buildRing);
    for (const tm of m.turrets) {
      if (!tm.rangeRings) continue;
      if (tm.rangeRings.trackAcquire)     this.world.remove(tm.rangeRings.trackAcquire);
      if (tm.rangeRings.trackRelease)     this.world.remove(tm.rangeRings.trackRelease);
      if (tm.rangeRings.engageAcquire)    this.world.remove(tm.rangeRings.engageAcquire);
      if (tm.rangeRings.engageRelease)    this.world.remove(tm.rangeRings.engageRelease);
      if (tm.rangeRings.engageMinAcquire) this.world.remove(tm.rangeRings.engageMinAcquire);
      if (tm.rangeRings.engageMinRelease) this.world.remove(tm.rangeRings.engageMinRelease);
    }
    m.ring = undefined;
  }

  dispose(): void {
    this.ringGeom.dispose();
    this.rangeCircleGeom.dispose();
    this.radiusMatScale.dispose();
    this.radiusMatShot.dispose();
    this.radiusMatPush.dispose();
    this.ringMatTrackAcquire.dispose();
    this.ringMatTrackRelease.dispose();
    this.ringMatEngageAcquire.dispose();
    this.ringMatEngageRelease.dispose();
    this.ringMatEngageMinAcquire.dispose();
    this.ringMatEngageMinRelease.dispose();
    this.ringMatBuild.dispose();
    this.selectionRingMat.dispose();
  }

  private setUnitRadiusSphere(
    rings: RadiusRingMeshes,
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

  private hideRangeRings(m: OverlayEntityMesh): void {
    this.hideTurretRangeRings(m);
    if (m.buildRing) m.buildRing.visible = false;
  }

  private hideTurretRangeRings(m: OverlayEntityMesh): void {
    for (const tm of m.turrets) {
      const rings = tm.rangeRings;
      if (!rings) continue;
      if (rings.trackAcquire)     rings.trackAcquire.visible = false;
      if (rings.trackRelease)     rings.trackRelease.visible = false;
      if (rings.engageAcquire)    rings.engageAcquire.visible = false;
      if (rings.engageRelease)    rings.engageRelease.visible = false;
      if (rings.engageMinAcquire) rings.engageMinAcquire.visible = false;
      if (rings.engageMinRelease) rings.engageMinRelease.visible = false;
    }
  }

  private setRangeCircle(
    tm: TurretMesh,
    key:
      | 'trackAcquire'
      | 'trackRelease'
      | 'engageAcquire'
      | 'engageRelease'
      | 'engageMinAcquire'
      | 'engageMinRelease',
    want: boolean,
    cx: number, cy: number, cz: number,
    radius: number | null,
    mat: THREE.LineBasicMaterial,
  ): void {
    const rings = tm.rangeRings ?? (tm.rangeRings = {});
    let ring = rings[key];
    if (want && radius !== null) {
      if (!ring) {
        ring = new THREE.LineSegments(this.rangeCircleGeom, mat);
        ring.renderOrder = RANGE_CIRCLE_RENDER_ORDER;
        this.world.add(ring);
        rings[key] = ring;
      }
      ring.visible = true;
      ring.position.set(cx, cz, cy);
      ring.scale.setScalar(radius);
    } else if (ring) {
      ring.visible = false;
    }
  }
}
