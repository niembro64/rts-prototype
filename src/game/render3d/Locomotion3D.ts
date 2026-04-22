// Locomotion3D — 3D geometry for the unit's "legs": tank treads, vehicle
// wheels, or arachnid legs. One-time geometry construction per unit, with a
// cheap per-frame update for wheel/tread spin speed (driven by the unit's
// velocity so motion reads on screen).
//
// Designed to match the 2D LocomotionManager shape-wise, not walk-cycle wise.
// Proper gait animation (arachnid foot-snapping, etc.) can layer on top later.

import * as THREE from 'three';
import type { Entity, PlayerId } from '../sim/types';
import { getUnitBlueprint } from '../sim/blueprints';
import type {
  TreadConfig,
  WheelConfig,
  LegConfig,
  LegStyle,
} from '@/types/blueprints';

const TREAD_COLOR = 0x1a1d22;
const TREAD_HEIGHT = 10;        // how tall the tread slab is (world units)
const TREAD_Y = TREAD_HEIGHT / 2;
const WHEEL_COLOR = 0x2a2f36;
const LEG_COLOR = 0x2a2f36;

// Static leg counts per style. Matches the shape of each animal in the 2D
// renderer without replicating each leg's exact attach-angle/phase data.
const LEG_COUNT_BY_STYLE: Record<LegStyle, number> = {
  daddy: 8,
  widow: 6,
  tarantula: 8,
  tick: 6,
  commander: 2,
};

export type Locomotion3DMesh =
  | { type: 'treads'; group: THREE.Group; wheels: THREE.Mesh[] }
  | { type: 'wheels'; group: THREE.Group; wheels: THREE.Mesh[] }
  | { type: 'legs'; group: THREE.Group }
  | undefined;

const treadBoxGeom = new THREE.BoxGeometry(1, 1, 1);
const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
const legUpperGeom = new THREE.CylinderGeometry(1, 1, 1, 8);

// Two cached materials per locomotion part — cheap to allocate, safe to share
// across all units since the colors don't vary per player.
const treadMat = new THREE.MeshLambertMaterial({ color: TREAD_COLOR });
const wheelMat = new THREE.MeshLambertMaterial({ color: WHEEL_COLOR });
const legMat = new THREE.MeshLambertMaterial({ color: LEG_COLOR });

export function buildLocomotion(
  unitGroup: THREE.Group,
  entity: Entity,
  unitRadius: number,
  _pid: PlayerId | undefined,
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

  switch (loc.type) {
    case 'treads': return buildTreads(unitGroup, unitRadius, loc.config);
    case 'wheels': return buildWheels(unitGroup, unitRadius, loc.config);
    case 'legs':   return buildLegs(unitGroup, unitRadius, loc.style, loc.config);
  }
}

function buildTreads(
  unitGroup: THREE.Group,
  r: number,
  cfg: TreadConfig,
): Locomotion3DMesh {
  const group = new THREE.Group();
  const length = r * cfg.treadLength;
  const width = r * cfg.treadWidth;
  // Tread slabs run along the unit's forward axis (local +X). Two slabs, one
  // on each side of the chassis, offset perpendicular by ± treadOffset · r.
  const offset = r * cfg.treadOffset;
  for (const side of [-1, 1]) {
    const slab = new THREE.Mesh(treadBoxGeom, treadMat);
    slab.scale.set(length, TREAD_HEIGHT, width);
    slab.position.set(0, TREAD_Y, side * offset);
    group.add(slab);
  }
  // Small wheel rings on top of the tread surface so the treads have visible
  // articulation. Count is derived from tread length so big units get more.
  const wheels: THREE.Mesh[] = [];
  const wheelCount = Math.max(2, Math.round(cfg.treadLength * 2));
  const wheelR = Math.max(1, r * cfg.wheelRadius);
  for (const side of [-1, 1]) {
    for (let i = 0; i < wheelCount; i++) {
      const t = (i + 0.5) / wheelCount;
      const x = -length / 2 + t * length;
      const w = new THREE.Mesh(wheelGeom, wheelMat);
      // Cylinder default +Y axis → rotate so its axis runs along Z (across the
      // chassis) so the wheel "faces forward".
      w.rotation.x = Math.PI / 2;
      w.scale.set(wheelR, width * 1.05, wheelR);
      w.position.set(x, TREAD_Y, side * offset);
      group.add(w);
      wheels.push(w);
    }
  }
  unitGroup.add(group);
  return { type: 'treads', group, wheels };
}

function buildWheels(
  unitGroup: THREE.Group,
  r: number,
  cfg: WheelConfig,
): Locomotion3DMesh {
  // "Wheels" locomotion = two pairs of short tread slabs (front-left,
  // front-right, back-left, back-right). Conceptually: normal `treads` but
  // split into front/back pairs instead of one long slab per side.
  const group = new THREE.Group();
  const slabLength = r * cfg.treadLength;
  const slabWidth = r * cfg.treadWidth;
  // Offsets from chassis center to each slab's center.
  const fx = r * cfg.wheelDistX;   // forward/back distance from center
  const fz = r * cfg.wheelDistY;   // side-to-side distance from center
  const wheels: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const slab = new THREE.Mesh(treadBoxGeom, treadMat);
      slab.scale.set(slabLength, TREAD_HEIGHT, slabWidth);
      slab.position.set(sx * fx, TREAD_Y, sz * fz);
      group.add(slab);
      // Track slab as a "wheel" for later spin — but since it's a slab, spin
      // rotates the texture pattern conceptually. For now we leave them
      // static, since there's no tread texture.
      wheels.push(slab);
    }
  }
  unitGroup.add(group);
  return { type: 'wheels', group, wheels };
}

function buildLegs(
  unitGroup: THREE.Group,
  r: number,
  style: LegStyle,
  cfg: LegConfig,
): Locomotion3DMesh {
  const group = new THREE.Group();
  const n = LEG_COUNT_BY_STYLE[style] ?? 6;
  // Simplified 3D legs: each leg is a single tapered cylinder angled outward
  // and downward from the chassis. Bend (upper vs lower) is approximated by
  // the cylinder's tilt, not by a real knee joint — the 2D walk-cycle
  // articulation is a follow-up.
  const legLength = r * 2.4;
  const legThickness = Math.max(cfg.upperThickness, 1) * 0.6;
  const attachY = r * 0.6; // legs start at chassis mid-height
  for (let i = 0; i < n; i++) {
    // Spread legs around the body, favouring the sides (avoid pure forward/back).
    const a = -Math.PI / 2 + Math.PI * ((i + 0.5) / n); // spans [-π/2, π/2]
    const side = i < n / 2 ? -1 : 1;
    const dirX = Math.cos(a);
    const dirZ = Math.sin(a) * side;
    // Upper leg — one cylinder angling from the chassis out toward the foot.
    const baseX = dirX * r * 0.9;
    const baseZ = dirZ * r * 0.9;
    const baseY = attachY;
    const tipX = baseX + dirX * legLength;
    const tipZ = baseZ + dirZ * legLength;
    const tipY = 1; // foot just above the ground
    const leg = new THREE.Mesh(legUpperGeom, legMat);
    const dx = tipX - baseX;
    const dy = tipY - baseY;
    const dz = tipZ - baseZ;
    const len = Math.hypot(dx, dy, dz);
    leg.scale.set(legThickness, len, legThickness);
    leg.position.set((baseX + tipX) / 2, (baseY + tipY) / 2, (baseZ + tipZ) / 2);
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
    leg.quaternion.setFromUnitVectors(up, dir);
    group.add(leg);
  }
  unitGroup.add(group);
  return { type: 'legs', group };
}

/**
 * Per-frame update — for treads, spin the wheel cylinders inside the tread
 * slabs to match the unit's current linear speed. Wheels/legs are static.
 */
export function updateLocomotion(
  mesh: Locomotion3DMesh,
  entity: Entity,
  dtMs: number,
): void {
  if (!mesh || mesh.type !== 'treads') return;
  const vx = entity.unit?.velocityX ?? 0;
  const vy = entity.unit?.velocityY ?? 0;
  const speed = Math.hypot(vx, vy);
  if (speed <= 0.1) return;

  const w0 = mesh.wheels[0];
  if (!w0) return;
  const wheelR = Math.max(1, w0.scale.x);
  // For a wheel rolling without slip, ω = v / r.
  const omega = speed / wheelR;
  const rotDelta = omega * (dtMs / 1000);
  for (const w of mesh.wheels) {
    // Cylinder's local +Y was rotated to +Z at build time; spinning around
    // local +Y makes the wheel roll around its actual rolling axis.
    w.rotation.y += rotDelta;
  }
}

export function destroyLocomotion(mesh: Locomotion3DMesh): void {
  if (!mesh) return;
  mesh.group.parent?.remove(mesh.group);
}
