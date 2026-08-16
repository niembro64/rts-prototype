import * as THREE from 'three';
import { getVolumeToggle } from '@/clientBarConfig';
import { COLORS } from '@/colorsConfig';
import {
  getVegetationProps,
  getVegetationRemovedCount,
  isVegetationAlive,
  queryVegetationInCircle,
} from '../sim/vegetation';
import {
  createEntityVolume,
  writeVegetationPropVolume,
  type EntityVolume,
} from '../sim/entityVolumes';

/**
 * SEL volumes for vegetation props.
 *
 * A prop is not an entity — thousands of trees stay out of the entity map
 * — but it IS pickable, and it is picked with an upright capped cylinder
 * in Rust (`vegetation_raycast`). The unified VOLUMES bar group promises
 * that every pickable thing shows the volume the cursor actually tests,
 * so props answer the SEL button with that exact cylinder.
 *
 * Props are static and numerous, so this draws them as ONE merged
 * LineSegments rebuilt only when the camera has moved a meaningful
 * distance, a prop has been reclaimed, or the toggle flipped. Only props
 * near the camera are drawn: a whole map's forest of wireframes would be
 * unreadable as well as expensive.
 */

/** Horizontal reach around the camera, in world units. */
const PROP_VOLUME_DRAW_RADIUS = 1600;
/** Rebuild once the camera has moved this far from the last build. */
const REBUILD_MOVE_DISTANCE = 200;
/** Hard cap on drawn props, so a dense forest cannot stall a debug view. */
const MAX_DRAWN_PROPS = 900;
/** Coarser than the host wireframes — these are small and there are many. */
const CYLINDER_SEGMENTS = 12;
const CYLINDER_RIBS = 4;
const RENDER_ORDER = 22;

export class VegetationVolumeOverlay3D {
  private readonly mesh: THREE.LineSegments;
  private readonly material: THREE.LineBasicMaterial;
  private readonly queryScratch = new Uint32Array(MAX_DRAWN_PROPS * 4);
  /** Reused per prop; the shared writer owns the cylinder's dimensions. */
  private readonly propVolume = createEntityVolume();
  private geometry: THREE.BufferGeometry;
  private built = false;
  private lastCameraX = NaN;
  private lastCameraY = NaN;
  private lastRemovedCount = -1;

  constructor(private readonly parent: THREE.Group) {
    this.material = new THREE.LineBasicMaterial({
      color: COLORS.effects.selectionOverlay.radiusOther.colorHex,
      transparent: true,
      opacity: COLORS.effects.selectionOverlay.radiusOther.opacity,
      depthWrite: false,
      depthTest: false,
    });
    this.geometry = new THREE.BufferGeometry();
    this.mesh = new THREE.LineSegments(this.geometry, this.material);
    this.mesh.name = 'VegetationVolumeOverlay3D';
    this.mesh.renderOrder = RENDER_ORDER;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** `cameraX`/`cameraY` are SIM horizontal coordinates. */
  update(cameraX: number, cameraY: number): void {
    if (!getVolumeToggle('selection')) {
      if (this.mesh.visible) this.mesh.visible = false;
      this.built = false;
      return;
    }
    const removedCount = getVegetationRemovedCount();
    const moved = !this.built ||
      Math.hypot(cameraX - this.lastCameraX, cameraY - this.lastCameraY)
        > REBUILD_MOVE_DISTANCE;
    if (!moved && removedCount === this.lastRemovedCount) {
      if (!this.mesh.visible) this.mesh.visible = true;
      return;
    }
    this.lastCameraX = cameraX;
    this.lastCameraY = cameraY;
    this.lastRemovedCount = removedCount;
    this.rebuild(cameraX, cameraY);
    this.built = true;
  }

  private rebuild(cameraX: number, cameraY: number): void {
    const props = getVegetationProps();
    const positions: number[] = [];
    if (props.length > 0) {
      const found = queryVegetationInCircle(
        cameraX, cameraY, PROP_VOLUME_DRAW_RADIUS, this.queryScratch,
      );
      const limit = Math.min(found, MAX_DRAWN_PROPS);
      for (let i = 0; i < limit; i++) {
        const prop = props[this.queryScratch[i]];
        if (prop === undefined || !isVegetationAlive(prop.index)) continue;
        if (!writeVegetationPropVolume(prop, this.propVolume)) continue;
        appendPropCylinder(positions, this.propVolume);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const previousGeometry = this.geometry;
    this.geometry = geometry;
    this.mesh.geometry = geometry;
    previousGeometry.dispose();
    this.mesh.visible = positions.length > 0;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** One upright capped-cylinder wireframe in three.js world coords. Sim
 *  (x, y, z) maps to THREE (x, z_altitude, y). */
function appendPropCylinder(out: number[], volume: EntityVolume): void {
  const simX = volume.x;
  const simY = volume.y;
  const radius = volume.halfX;
  const baseZ = volume.z - volume.halfZ;
  const topY = volume.z + volume.halfZ;
  if (radius <= 0 || volume.halfZ <= 0) return;
  for (let i = 0; i < CYLINDER_SEGMENTS; i++) {
    const a0 = (i / CYLINDER_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / CYLINDER_SEGMENTS) * Math.PI * 2;
    const x0 = simX + Math.cos(a0) * radius;
    const z0 = simY + Math.sin(a0) * radius;
    const x1 = simX + Math.cos(a1) * radius;
    const z1 = simY + Math.sin(a1) * radius;
    out.push(x0, baseZ, z0, x1, baseZ, z1);
    out.push(x0, topY, z0, x1, topY, z1);
  }
  for (let i = 0; i < CYLINDER_RIBS; i++) {
    const a = (i / CYLINDER_RIBS) * Math.PI * 2;
    const x = simX + Math.cos(a) * radius;
    const z = simY + Math.sin(a) * radius;
    out.push(x, baseZ, z, x, topY, z);
  }
}
