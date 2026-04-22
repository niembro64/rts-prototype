// Locomotion3D — 3D geometry for each unit's "legs": tank treads, vehicle
// wheels, or arachnid legs. LOD-aware: the geometry we build depends on the
// `GraphicsConfig` supplied at build time, and the caller rebuilds the unit
// mesh wholesale when the global LOD changes so the scene stays consistent.
//
// LOD axes this module responds to (from GraphicsConfig):
//   - legs           : 'none' | 'simple' | 'animated' | 'full'
//   - treadsAnimated : when true, tread slabs get rolling wheel cylinders
//                      inside them; otherwise they're flat slabs.
// Stylistic knobs like chassisDetail are handled by the caller.

import * as THREE from 'three';
import type { Entity, PlayerId } from '../sim/types';
import { getUnitBlueprint } from '../sim/blueprints';
import type {
  TreadConfig,
  WheelConfig,
  LegConfig,
  LegStyle,
} from '@/types/blueprints';
import type { GraphicsConfig, LegStyle as LegLod } from '@/types/graphics';

const TREAD_COLOR = 0x1a1d22;
const TREAD_HEIGHT = 10;
const TREAD_Y = TREAD_HEIGHT / 2;
const WHEEL_COLOR = 0x2a2f36;
const LEG_COLOR = 0x2a2f36;

const LEG_COUNT_BY_STYLE: Record<LegStyle, number> = {
  daddy: 8,
  widow: 6,
  tarantula: 8,
  tick: 6,
  commander: 2,
};

/** Per-unit locomotion state. `type` reflects the blueprint's locomotion type;
 *  `lodKey` records the LOD it was built at so the caller knows when to
 *  rebuild if the global LOD flips. */
export type Locomotion3DMesh =
  | ({ type: 'treads'; group: THREE.Group; wheels: THREE.Mesh[] } & LocomotionBase)
  | ({ type: 'wheels'; group: THREE.Group; wheels: THREE.Mesh[] } & LocomotionBase)
  | ({ type: 'legs';   group: THREE.Group; legs: LegSegment[]; style: LegStyle; config: LegConfig } & LocomotionBase)
  | undefined;

type LocomotionBase = {
  /** Snapshot of the GraphicsConfig values this geometry was built for. */
  lodKey: string;
};

/** One simplified or articulated leg. Present only at `'simple'`+ LOD. */
type LegSegment = {
  upper: THREE.Mesh;
  /** Knee+lower only built at 'full' LOD. */
  lower?: THREE.Mesh;
  /** Hip/knee/foot joint spheres — 'full' LOD only. */
  joints?: THREE.Mesh[];
  /** Chassis-local attach point (before rotation is applied). */
  attachX: number;
  attachY: number;
  /** Static foot offset (no walk-cycle yet — 'animated' flag reserved for future). */
  footX: number;
  footY: number;
};

const treadBoxGeom = new THREE.BoxGeometry(1, 1, 1);
const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
const legGeom = new THREE.CylinderGeometry(1, 1, 1, 8);
const jointGeom = new THREE.SphereGeometry(1, 8, 6);

const treadMat = new THREE.MeshLambertMaterial({ color: TREAD_COLOR });
const wheelMat = new THREE.MeshLambertMaterial({ color: WHEEL_COLOR });
const legMat = new THREE.MeshLambertMaterial({ color: LEG_COLOR });

/** Encodes exactly the GraphicsConfig bits that affect our geometry. Unit
 *  meshes compare this key to decide whether their locomotion is stale. */
export function lodKeyFor(gfx: GraphicsConfig): string {
  return `${gfx.legs}|${gfx.treadsAnimated ? 1 : 0}`;
}

export function buildLocomotion(
  unitGroup: THREE.Group,
  entity: Entity,
  unitRadius: number,
  _pid: PlayerId | undefined,
  gfx: GraphicsConfig,
): Locomotion3DMesh {
  if (!entity.unit) return undefined;
  let bp;
  try {
    bp = getUnitBlueprint(entity.unit.unitType);
  } catch {
    return undefined;
  }
  const loc = bp.locomotion;
  if (!loc) return undefined;

  const lodKey = lodKeyFor(gfx);

  switch (loc.type) {
    case 'treads': {
      const mesh = buildTreads(unitGroup, unitRadius, loc.config, gfx.treadsAnimated);
      if (mesh) mesh.lodKey = lodKey;
      return mesh;
    }
    case 'wheels': {
      const mesh = buildWheels(unitGroup, unitRadius, loc.config);
      if (mesh) mesh.lodKey = lodKey;
      return mesh;
    }
    case 'legs': {
      const mesh = buildLegs(unitGroup, unitRadius, loc.style, loc.config, gfx.legs);
      if (mesh) mesh.lodKey = lodKey;
      return mesh;
    }
  }
}

function buildTreads(
  unitGroup: THREE.Group,
  r: number,
  cfg: TreadConfig,
  animatedWheels: boolean,
): Locomotion3DMesh {
  const group = new THREE.Group();
  const length = r * cfg.treadLength;
  const width = r * cfg.treadWidth;
  const offset = r * cfg.treadOffset;
  for (const side of [-1, 1]) {
    const slab = new THREE.Mesh(treadBoxGeom, treadMat);
    slab.scale.set(length, TREAD_HEIGHT, width);
    slab.position.set(0, TREAD_Y, side * offset);
    group.add(slab);
  }
  const wheels: THREE.Mesh[] = [];
  if (animatedWheels) {
    // Rolling wheel cylinders inside each tread slab. Only built at LOD where
    // GraphicsConfig.treadsAnimated is true; at lower LOD treads are flat
    // slabs with nothing moving.
    const wheelCount = Math.max(2, Math.round(cfg.treadLength * 2));
    const wheelR = Math.max(1, r * cfg.wheelRadius);
    for (const side of [-1, 1]) {
      for (let i = 0; i < wheelCount; i++) {
        const t = (i + 0.5) / wheelCount;
        const x = -length / 2 + t * length;
        const w = new THREE.Mesh(wheelGeom, wheelMat);
        w.rotation.x = Math.PI / 2;
        w.scale.set(wheelR, width * 1.05, wheelR);
        w.position.set(x, TREAD_Y, side * offset);
        group.add(w);
        wheels.push(w);
      }
    }
  }
  unitGroup.add(group);
  return { type: 'treads', group, wheels, lodKey: '' };
}

function buildWheels(
  unitGroup: THREE.Group,
  r: number,
  cfg: WheelConfig,
): Locomotion3DMesh {
  // "Wheels" = two pairs of short tread slabs (front-left, front-right,
  // back-left, back-right). Treated identically at all LODs today.
  const group = new THREE.Group();
  const slabLength = r * cfg.treadLength;
  const slabWidth = r * cfg.treadWidth;
  const fx = r * cfg.wheelDistX;
  const fz = r * cfg.wheelDistY;
  const wheels: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const slab = new THREE.Mesh(treadBoxGeom, treadMat);
      slab.scale.set(slabLength, TREAD_HEIGHT, slabWidth);
      slab.position.set(sx * fx, TREAD_Y, sz * fz);
      group.add(slab);
      wheels.push(slab);
    }
  }
  unitGroup.add(group);
  return { type: 'wheels', group, wheels, lodKey: '' };
}

function buildLegs(
  unitGroup: THREE.Group,
  r: number,
  style: LegStyle,
  cfg: LegConfig,
  legLod: LegLod,
): Locomotion3DMesh {
  // LOD 'none' → no geometry at all. The rest vary in articulation.
  if (legLod === 'none') return undefined;

  const group = new THREE.Group();
  const n = LEG_COUNT_BY_STYLE[style] ?? 6;
  const legReach = r * 2.4;
  const upperThick = Math.max(cfg.upperThickness, 1) * 0.6;
  const lowerThick = Math.max(cfg.lowerThickness, 1) * 0.6;
  const attachY = r * 0.6;
  const legs: LegSegment[] = [];

  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + Math.PI * ((i + 0.5) / n);
    const side = i < n / 2 ? -1 : 1;
    const dirX = Math.cos(a);
    const dirZ = Math.sin(a) * side;
    const baseX = dirX * r * 0.9;
    const baseZ = dirZ * r * 0.9;
    const baseY = attachY;
    const footX = baseX + dirX * legReach;
    const footZ = baseZ + dirZ * legReach;
    const footY = 1;

    if (legLod === 'simple' || legLod === 'animated') {
      // One straight cylinder from hip to foot. 'animated' is reserved for a
      // future walk-cycle; geometry is identical for now.
      const upper = buildStraightCylinder(
        legGeom, legMat,
        baseX, baseY, baseZ,
        footX, footY, footZ,
        upperThick,
      );
      group.add(upper);
      legs.push({
        upper,
        attachX: baseX,
        attachY: baseZ,
        footX,
        footY: footZ,
      });
    } else {
      // 'full': two-segment leg with a knee joint roughly halfway between
      // hip and foot, raised slightly so the knee looks articulated. Joint
      // spheres at hip/knee/foot.
      const kneeX = (baseX + footX) / 2;
      const kneeZ = (baseZ + footZ) / 2;
      const kneeY = baseY * 0.55; // pull the knee down a bit for a walker silhouette
      const upper = buildStraightCylinder(
        legGeom, legMat,
        baseX, baseY, baseZ,
        kneeX, kneeY, kneeZ,
        upperThick,
      );
      const lower = buildStraightCylinder(
        legGeom, legMat,
        kneeX, kneeY, kneeZ,
        footX, footY, footZ,
        lowerThick,
      );
      const hipJoint = buildJoint(jointGeom, legMat, baseX, baseY, baseZ, cfg.hipRadius);
      const kneeJoint = buildJoint(jointGeom, legMat, kneeX, kneeY, kneeZ, cfg.kneeRadius);
      const footJoint = buildJoint(jointGeom, legMat, footX, footY, footZ, cfg.footRadius);
      group.add(upper);
      group.add(lower);
      group.add(hipJoint);
      group.add(kneeJoint);
      group.add(footJoint);
      legs.push({
        upper,
        lower,
        joints: [hipJoint, kneeJoint, footJoint],
        attachX: baseX,
        attachY: baseZ,
        footX,
        footY: footZ,
      });
    }
  }
  unitGroup.add(group);
  return { type: 'legs', group, legs, style, config: cfg, lodKey: '' };
}

function buildStraightCylinder(
  geom: THREE.CylinderGeometry,
  mat: THREE.Material,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  thickness: number,
): THREE.Mesh {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.max(1e-3, Math.hypot(dx, dy, dz));
  const mesh = new THREE.Mesh(geom, mat);
  mesh.scale.set(thickness, len, thickness);
  mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  return mesh;
}

function buildJoint(
  geom: THREE.SphereGeometry,
  mat: THREE.Material,
  x: number, y: number, z: number,
  radius: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geom, mat);
  mesh.scale.setScalar(Math.max(1, radius));
  mesh.position.set(x, y, z);
  return mesh;
}

/**
 * Per-frame update — for treads with animated wheels, spin the wheel
 * cylinders at ω = v / r to match the unit's linear speed. Wheels (slab
 * pairs) and legs are static today.
 */
export function updateLocomotion(
  mesh: Locomotion3DMesh,
  entity: Entity,
  dtMs: number,
): void {
  if (!mesh || mesh.type !== 'treads' || mesh.wheels.length === 0) return;
  const vx = entity.unit?.velocityX ?? 0;
  const vy = entity.unit?.velocityY ?? 0;
  const speed = Math.hypot(vx, vy);
  if (speed <= 0.1) return;
  const wheelR = Math.max(1, mesh.wheels[0].scale.x);
  const omega = speed / wheelR;
  const rotDelta = omega * (dtMs / 1000);
  for (const w of mesh.wheels) w.rotation.y += rotDelta;
}

export function destroyLocomotion(mesh: Locomotion3DMesh): void {
  if (!mesh) return;
  mesh.group.parent?.remove(mesh.group);
}
