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
 *  rebuild if the global LOD flips. `legLod` is cached so the animator knows
 *  which articulation to use when updating per-frame. */
export type Locomotion3DMesh =
  | ({ type: 'treads'; group: THREE.Group; wheels: THREE.Mesh[] } & LocomotionBase)
  | ({ type: 'wheels'; group: THREE.Group; wheels: THREE.Mesh[] } & LocomotionBase)
  | ({ type: 'legs';
       group: THREE.Group;
       legs: LegSegment[];
       style: LegStyle;
       config: LegConfig;
       legLod: LegLod;
       /** Walk-cycle phase in radians. Advances with the unit's velocity
        *  each frame, so legs oscillate faster as the unit moves faster. */
       walkPhase: number;
    } & LocomotionBase)
  | undefined;

type LocomotionBase = {
  /** Snapshot of the GraphicsConfig values this geometry was built for. */
  lodKey: string;
};

/** One simplified or articulated leg. Present only at `'simple'`+ LOD. */
type LegSegment = {
  upper: THREE.Mesh;
  /** Knee + lower segment only built at 'full' LOD. */
  lower?: THREE.Mesh;
  /** Hip / knee / foot joint spheres — 'full' LOD only. */
  hipJoint?: THREE.Mesh;
  kneeJoint?: THREE.Mesh;
  footJoint?: THREE.Mesh;
  /** Chassis-local rest-pose points. Animation offsets the foot from these. */
  hipX: number;
  hipY: number;
  hipZ: number;
  footX: number;
  footY: number;
  footZ: number;
  /** Unit thickness for rebuilding cylinder scale each frame. */
  upperThick: number;
  lowerThick: number;
  /** Per-leg phase offset — staggers legs so they don't all lift in unison. */
  phaseOffset: number;
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
  const hipY = r * 0.6;
  const footY = 1;
  const legs: LegSegment[] = [];

  for (let i = 0; i < n; i++) {
    // Distribute legs evenly around the FULL circle of the body (not half).
    // Half-step offset so no leg lies exactly on the forward axis.
    const a = ((i + 0.5) / n) * Math.PI * 2;
    const dirX = Math.cos(a);
    const dirZ = Math.sin(a);

    const hipX = dirX * r * 0.9;
    const hipZ = dirZ * r * 0.9;
    const footX = hipX + dirX * legReach;
    const footZ = hipZ + dirZ * legReach;

    // Alternating gait: legs 0,2,4,… are in-phase, legs 1,3,5,… are π out of
    // phase. Two groups alternating produces a spider-like tetrapod look.
    const phaseOffset = (i % 2) * Math.PI;

    if (legLod === 'simple' || legLod === 'animated') {
      // Single cylinder from hip to foot. 'animated' LOD drives the foot
      // up/down per frame (see updateLocomotion); 'simple' leaves it static.
      const upper = buildStraightCylinder(
        legGeom, legMat,
        hipX, hipY, hipZ,
        footX, footY, footZ,
        upperThick,
      );
      group.add(upper);
      legs.push({
        upper,
        hipX, hipY, hipZ,
        footX, footY, footZ,
        upperThick,
        lowerThick,
        phaseOffset,
      });
    } else {
      // 'full': two-segment leg with a knee joint. Joint spheres at each
      // articulation.
      const kneeX = (hipX + footX) / 2;
      const kneeZ = (hipZ + footZ) / 2;
      const kneeY = hipY * 0.55; // bent down for walker silhouette
      const upper = buildStraightCylinder(
        legGeom, legMat,
        hipX, hipY, hipZ,
        kneeX, kneeY, kneeZ,
        upperThick,
      );
      const lower = buildStraightCylinder(
        legGeom, legMat,
        kneeX, kneeY, kneeZ,
        footX, footY, footZ,
        lowerThick,
      );
      const hipJoint = buildJoint(jointGeom, legMat, hipX, hipY, hipZ, cfg.hipRadius);
      const kneeJoint = buildJoint(jointGeom, legMat, kneeX, kneeY, kneeZ, cfg.kneeRadius);
      const footJoint = buildJoint(jointGeom, legMat, footX, footY, footZ, cfg.footRadius);
      group.add(upper, lower, hipJoint, kneeJoint, footJoint);
      legs.push({
        upper,
        lower,
        hipJoint,
        kneeJoint,
        footJoint,
        hipX, hipY, hipZ,
        footX, footY, footZ,
        upperThick,
        lowerThick,
        phaseOffset,
      });
    }
  }
  unitGroup.add(group);
  return {
    type: 'legs',
    group,
    legs,
    style,
    config: cfg,
    legLod,
    walkPhase: 0,
    lodKey: '',
  };
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

const LEG_WALK_CYCLE_UNITS = 120;  // world units of travel per full gait cycle
const LEG_IDLE_RATE = 1.5;         // rad/s of phase advance even when standing still
const LEG_LIFT = 6;                // world-unit foot bounce at peak lift
const LEG_SWING_WORLD = 5;         // small tangential swing added to foot position

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

/**
 * Per-frame update — treads spin their wheel cylinders at ω = v / r to match
 * the unit's linear speed; legs (at LOD 'animated' and 'full') advance a
 * walk-cycle phase that bobs each foot up-and-down with a tangential swing.
 * LOD 'simple' keeps legs rigid (geometry built, never animated).
 */
export function updateLocomotion(
  mesh: Locomotion3DMesh,
  entity: Entity,
  dtMs: number,
): void {
  if (!mesh) return;
  const vx = entity.unit?.velocityX ?? 0;
  const vy = entity.unit?.velocityY ?? 0;
  const speed = Math.hypot(vx, vy);
  const dt = dtMs / 1000;

  if (mesh.type === 'treads' && mesh.wheels.length > 0) {
    if (speed <= 0.1) return;
    const wheelR = Math.max(1, mesh.wheels[0].scale.x);
    const omega = speed / wheelR;
    const rotDelta = omega * dt;
    for (const w of mesh.wheels) w.rotation.y += rotDelta;
    return;
  }

  if (mesh.type === 'legs' && mesh.legLod !== 'simple') {
    // Advance the walk-cycle phase. Faster movement → faster gait. A small
    // idle rate keeps legs ticking gently even when standing still so units
    // don't look completely rigid.
    const cycleRate = (speed / LEG_WALK_CYCLE_UNITS) * Math.PI * 2 + LEG_IDLE_RATE;
    mesh.walkPhase = (mesh.walkPhase + cycleRate * dt) % (Math.PI * 2);

    // `swingStrength` scales the forward-back swing with movement speed so
    // stationary units bob subtly but moving units visibly step.
    const swingStrength = Math.min(1, speed / 60);

    for (const leg of mesh.legs) {
      const phase = mesh.walkPhase + leg.phaseOffset;
      const liftT = Math.max(0, Math.sin(phase));                  // 0..1
      const swingT = Math.cos(phase) * swingStrength;              // -1..1

      // Animate foot: lift up by `liftT · LEG_LIFT`, swing along the
      // outward direction by `swingT · LEG_SWING_WORLD` so legs look like
      // they step forward/back during the gait.
      const dirX = leg.footX - leg.hipX;
      const dirZ = leg.footZ - leg.hipZ;
      const legLen = Math.max(1e-3, Math.hypot(dirX, dirZ));
      const nx = dirX / legLen;
      const nz = dirZ / legLen;

      const footX = leg.footX + swingT * LEG_SWING_WORLD * nx;
      const footY = leg.footY + liftT * LEG_LIFT;
      const footZ = leg.footZ + swingT * LEG_SWING_WORLD * nz;

      if (mesh.legLod === 'animated') {
        // Single cylinder — rebuild its transform between hip and animated foot.
        setCylinderBetween(
          leg.upper,
          leg.hipX, leg.hipY, leg.hipZ,
          footX, footY, footZ,
          leg.upperThick,
        );
      } else {
        // 'full' — update both segments and the three joint spheres.
        const kneeX = (leg.hipX + footX) / 2;
        const kneeZ = (leg.hipZ + footZ) / 2;
        // Bend the knee a bit higher during the lift phase so the leg
        // visibly flexes as the foot lifts.
        const kneeY = leg.hipY * 0.55 + liftT * LEG_LIFT * 0.6;
        setCylinderBetween(
          leg.upper,
          leg.hipX, leg.hipY, leg.hipZ,
          kneeX, kneeY, kneeZ,
          leg.upperThick,
        );
        if (leg.lower) {
          setCylinderBetween(
            leg.lower,
            kneeX, kneeY, kneeZ,
            footX, footY, footZ,
            leg.lowerThick,
          );
        }
        if (leg.kneeJoint) leg.kneeJoint.position.set(kneeX, kneeY, kneeZ);
        if (leg.footJoint) leg.footJoint.position.set(footX, footY, footZ);
        // hipJoint is fixed; no update needed.
      }
    }
  }
}

function setCylinderBetween(
  mesh: THREE.Mesh,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  thickness: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.max(1e-3, Math.hypot(dx, dy, dz));
  mesh.scale.set(thickness, len, thickness);
  mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  _dir.set(dx / len, dy / len, dz / len);
  mesh.quaternion.setFromUnitVectors(_up, _dir);
}

export function destroyLocomotion(mesh: Locomotion3DMesh): void {
  if (!mesh) return;
  mesh.group.parent?.remove(mesh.group);
}
