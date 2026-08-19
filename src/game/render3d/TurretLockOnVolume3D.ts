import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { TurretRangeVolume } from '@/types/blueprints';
import type { TurretRanges } from '@/types/combatTypes';
import type { Vec3 } from '@/types/vec2';
import { WATER_LEVEL } from '../sim/Terrain';

export const TURRET_LOCK_ON_BOUNDARY_KEYS = [
  'trackAcquire',
  'trackRelease',
  'engageAcquire',
  'engageRelease',
  'engageMinAcquire',
  'engageMinRelease',
] as const;

export type TurretLockOnBoundaryKey =
  (typeof TURRET_LOCK_ON_BOUNDARY_KEYS)[number];

type TurretLockOnVolumeOwner = object;
type TurretLockOnVolumeMeshes = Partial<
  Record<TurretLockOnBoundaryKey, THREE.LineSegments>
>;

type VolumePose = {
  geometry: 'sphere' | 'cylinder' | 'bottomUnbounded' | 'fullyUnbounded';
  centerZ: number;
  radius: number;
  halfHeight: number;
  bottomZ: number;
  topZ: number;
  bottomUnbounded: boolean;
  topUnbounded: boolean;
};

const CYLINDER_SEGMENTS = 48;
const CYLINDER_RIBS = 8;
const VOLUME_RENDER_ORDER = 22;

/** Build a radius-1, altitude ±1 cylinder outline. Unbounded ends retain a
 * finite display cut but terminate every rib in an outward arrowhead, so the
 * debug mesh never mistakes a viewport-friendly clipping plane for a real
 * targeting boundary. */
function buildCylinderGeometry(
  bottomUnbounded: boolean,
  topUnbounded: boolean,
): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const y of [1, -1]) {
    for (let i = 0; i < CYLINDER_SEGMENTS; i++) {
      const a0 = (i / CYLINDER_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / CYLINDER_SEGMENTS) * Math.PI * 2;
      positions.push(
        Math.cos(a0), y, Math.sin(a0),
        Math.cos(a1), y, Math.sin(a1),
      );
    }
  }
  const addArrow = (cx: number, sz: number, y: -1 | 1): void => {
    const shoulderY = y * 0.8;
    positions.push(
      cx, y, sz, cx * 0.84, shoulderY, sz * 0.84,
      cx, y, sz, cx * 1.16, shoulderY, sz * 1.16,
    );
  };
  for (let i = 0; i < CYLINDER_RIBS; i++) {
    const a = (i / CYLINDER_RIBS) * Math.PI * 2;
    const cx = Math.cos(a);
    const sz = Math.sin(a);
    positions.push(cx, 1, sz, cx, -1, sz);
    if (bottomUnbounded) addArrow(cx, sz, -1);
    if (topUnbounded) addArrow(cx, sz, 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

const BOUNDARY_STYLES = {
  trackAcquire: COLORS.effects.selectionOverlay.trackAcquire,
  trackRelease: COLORS.effects.selectionOverlay.trackRelease,
  engageAcquire: COLORS.effects.selectionOverlay.engageAcquire,
  engageRelease: COLORS.effects.selectionOverlay.engageRelease,
  engageMinAcquire: COLORS.effects.selectionOverlay.engageMinAcquire,
  engageMinRelease: COLORS.effects.selectionOverlay.engageMinRelease,
} as const;

function makeBoundaryMaterial(key: TurretLockOnBoundaryKey): THREE.LineBasicMaterial {
  const style = BOUNDARY_STYLES[key];
  return new THREE.LineBasicMaterial({
    color: style.colorHex,
    transparent: true,
    opacity: style.opacity,
    depthWrite: false,
    depthTest: false,
  });
}

function volumePose(
  rangeVolume: TurretRangeVolume,
  mountZ: number,
  range: number,
): VolumePose {
  switch (rangeVolume) {
    case 'turret-range-sphere':
      return {
        geometry: 'sphere',
        centerZ: mountZ,
        radius: range,
        halfHeight: range,
        bottomZ: mountZ - range,
        topZ: mountZ + range,
        bottomUnbounded: false,
        topUnbounded: false,
      };
    case 'turret-range-bottom-unbounded':
      return {
        geometry: 'bottomUnbounded',
        centerZ: mountZ,
        radius: range,
        halfHeight: range,
        bottomZ: Number.NEGATIVE_INFINITY,
        topZ: mountZ + range,
        bottomUnbounded: true,
        topUnbounded: false,
      };
    case 'turret-range-top-water-and-bottom-unbounded': {
      // The real lower end is infinite. Show at least two radii beneath the
      // water ceiling, and include a deeply submerged mount when necessary.
      const displayBottomZ = Math.min(WATER_LEVEL - range * 2, mountZ - range);
      return {
        geometry: 'bottomUnbounded',
        centerZ: (displayBottomZ + WATER_LEVEL) * 0.5,
        radius: range,
        halfHeight: (WATER_LEVEL - displayBottomZ) * 0.5,
        bottomZ: Number.NEGATIVE_INFINITY,
        topZ: WATER_LEVEL,
        bottomUnbounded: true,
        topUnbounded: false,
      };
    }
    case 'turret-range-top-and-bottom-unbounded':
      return {
        geometry: 'fullyUnbounded',
        centerZ: mountZ,
        radius: range,
        halfHeight: range,
        bottomZ: Number.NEGATIVE_INFINITY,
        topZ: Number.POSITIVE_INFINITY,
        bottomUnbounded: true,
        topUnbounded: true,
      };
    case 'turret-range-cylinder-normal':
      return {
        geometry: 'cylinder',
        centerZ: mountZ,
        radius: range,
        halfHeight: range,
        bottomZ: mountZ - range,
        topZ: mountZ + range,
        bottomUnbounded: false,
        topUnbounded: false,
      };
  }
}

function boundaryRanges(ranges: TurretRanges): Record<TurretLockOnBoundaryKey, number> {
  return {
    trackAcquire: ranges.tracking?.acquire ?? 0,
    trackRelease: ranges.tracking?.release ?? 0,
    engageAcquire: ranges.fire.max.acquire,
    engageRelease: ranges.fire.max.release,
    engageMinAcquire: ranges.fire.min?.acquire ?? 0,
    engageMinRelease: ranges.fire.min?.release ?? 0,
  };
}

/** World-parented wireframes for every range edge a turret's targeting FSM
 * checks. The meshes use the same hysteresis colors as TURR CIR, but render
 * the blueprint's real 3D rangeVolume around the authoritative AimFrom mount. */
export class TurretLockOnVolumeRenderer3D {
  private readonly world: THREE.Group;
  private readonly sphereGeometry: THREE.BufferGeometry;
  private readonly cylinderGeometry = buildCylinderGeometry(false, false);
  private readonly bottomUnboundedGeometry = buildCylinderGeometry(true, false);
  private readonly fullyUnboundedGeometry = buildCylinderGeometry(true, true);
  private readonly materials = Object.fromEntries(
    TURRET_LOCK_ON_BOUNDARY_KEYS.map((key) => [key, makeBoundaryMaterial(key)]),
  ) as Record<TurretLockOnBoundaryKey, THREE.LineBasicMaterial>;
  private readonly meshes = new Map<TurretLockOnVolumeOwner, TurretLockOnVolumeMeshes>();

  constructor(world: THREE.Group, sphereGeometry: THREE.BufferGeometry) {
    this.world = world;
    this.sphereGeometry = sphereGeometry;
  }

  update(
    owner: TurretLockOnVolumeOwner,
    mount: Vec3,
    ranges: TurretRanges,
    rangeVolume: TurretRangeVolume,
  ): void {
    const values = boundaryRanges(ranges);
    let ownerMeshes = this.meshes.get(owner);
    if (ownerMeshes === undefined) {
      ownerMeshes = {};
      this.meshes.set(owner, ownerMeshes);
    }
    for (const key of TURRET_LOCK_ON_BOUNDARY_KEYS) {
      this.setBoundary(ownerMeshes, key, mount, values[key], rangeVolume);
    }
  }

  hide(owner: TurretLockOnVolumeOwner): void {
    const ownerMeshes = this.meshes.get(owner);
    if (ownerMeshes === undefined) return;
    for (const key of TURRET_LOCK_ON_BOUNDARY_KEYS) {
      if (ownerMeshes[key] !== undefined) ownerMeshes[key]!.visible = false;
    }
  }

  remove(owner: TurretLockOnVolumeOwner): void {
    const ownerMeshes = this.meshes.get(owner);
    if (ownerMeshes === undefined) return;
    for (const key of TURRET_LOCK_ON_BOUNDARY_KEYS) {
      const mesh = ownerMeshes[key];
      if (mesh !== undefined) this.world.remove(mesh);
    }
    this.meshes.delete(owner);
  }

  dispose(): void {
    for (const owner of [...this.meshes.keys()]) this.remove(owner);
    this.cylinderGeometry.dispose();
    this.bottomUnboundedGeometry.dispose();
    this.fullyUnboundedGeometry.dispose();
    for (const key of TURRET_LOCK_ON_BOUNDARY_KEYS) this.materials[key].dispose();
  }

  private geometryFor(pose: VolumePose): THREE.BufferGeometry {
    switch (pose.geometry) {
      case 'sphere': return this.sphereGeometry;
      case 'cylinder': return this.cylinderGeometry;
      case 'bottomUnbounded': return this.bottomUnboundedGeometry;
      case 'fullyUnbounded': return this.fullyUnboundedGeometry;
    }
  }

  private setBoundary(
    ownerMeshes: TurretLockOnVolumeMeshes,
    key: TurretLockOnBoundaryKey,
    mount: Vec3,
    range: number,
    rangeVolume: TurretRangeVolume,
  ): void {
    if (!Number.isFinite(range) || range <= 0) {
      if (ownerMeshes[key] !== undefined) ownerMeshes[key]!.visible = false;
      return;
    }
    const pose = volumePose(rangeVolume, mount.z, range);
    const geometry = this.geometryFor(pose);
    let mesh = ownerMeshes[key];
    if (mesh !== undefined && mesh.geometry !== geometry) {
      this.world.remove(mesh);
      mesh = undefined;
    }
    if (mesh === undefined) {
      mesh = new THREE.LineSegments(geometry, this.materials[key]);
      mesh.name = `turretLockOnVolume:${key}`;
      mesh.renderOrder = VOLUME_RENDER_ORDER;
      mesh.frustumCulled = false;
      this.world.add(mesh);
      ownerMeshes[key] = mesh;
    }
    mesh.visible = true;
    mesh.position.set(mount.x, pose.centerZ, mount.y);
    if (pose.geometry === 'sphere') {
      mesh.scale.setScalar(range);
    } else {
      mesh.scale.set(range, pose.halfHeight, range);
    }
    mesh.userData.turretLockOnBoundary = key;
    mesh.userData.turretRangeVolume = rangeVolume;
    mesh.userData.range = range;
    mesh.userData.mountZ = mount.z;
    mesh.userData.bottomZ = pose.bottomZ;
    mesh.userData.topZ = pose.topZ;
    mesh.userData.bottomUnbounded = pose.bottomUnbounded;
    mesh.userData.topUnbounded = pose.topUnbounded;
  }
}
