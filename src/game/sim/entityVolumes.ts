/**
 * Entity volumes — the single description of every spatial volume an
 * entity carries.
 *
 * Four consumers used to derive these shapes independently: the mouse
 * picker, screen-rect box selection, the debug volume overlay, and the
 * projectile overlay. They drifted, and the worst drift was selection:
 * buildings were picked with a sphere whose radius was their footprint
 * HALF-DIAGONAL, so a 60x60x52 solar panel answered clicks 50 units out
 * in every direction — including 50 units of empty air above and below
 * it. Looking across a field at a flat structure, the cursor turned into
 * a selection cursor over a vertical slab twice the building's height.
 *
 * Everything now goes through the writers below. A volume is one of four
 * shapes in SIM coordinates (x/y horizontal, z up), which is also exactly
 * what the debug overlay draws, so what you click is what you see:
 *
 *   sphere   — units (body-centered; unit bodies really are round)
 *   box      — grounded buildings (footprint x visual height)
 *   cylinder — upright bodies (vegetation props; radius + half-height)
 *   annulus  — the hovering fabricator torus (open center hole and all)
 *
 * The writers fill a caller-owned EntityVolume so the picker's per-entity
 * loop stays allocation-free.
 */

import type { Entity } from './types';
import {
  fabricatorTorusHoverHeight,
  fabricatorTorusOuterRadius,
  fabricatorTorusRingRadius,
} from './blueprints';
import { getBuildingVisualTopZ } from './buildingAnchors';
import { getUnitGroundZ } from './unitGeometry';
import { getHostShotArmingRadius } from './combat/shotArming';

export type VolumeShape = 'sphere' | 'box' | 'cylinder' | 'annulus';

/** One volume in sim coordinates. `halfX`/`halfY` carry the radius for
 *  round shapes so every consumer can read a bounding half-extent
 *  without branching on the shape first. */
export type EntityVolume = {
  shape: VolumeShape;
  x: number;
  y: number;
  z: number;
  halfX: number;
  halfY: number;
  halfZ: number;
  /** Annulus only: inner radius of the ring. Zero for every other shape. */
  innerRadius: number;
};

export function createEntityVolume(): EntityVolume {
  return { shape: 'sphere', x: 0, y: 0, z: 0, halfX: 0, halfY: 0, halfZ: 0, innerRadius: 0 };
}

function writeSphere(out: EntityVolume, x: number, y: number, z: number, radius: number): boolean {
  out.shape = 'sphere';
  out.x = x; out.y = y; out.z = z;
  out.halfX = radius; out.halfY = radius; out.halfZ = radius;
  out.innerRadius = 0;
  return radius > 0;
}

function writeBox(
  out: EntityVolume,
  x: number, y: number, z: number,
  halfX: number, halfY: number, halfZ: number,
): boolean {
  out.shape = 'box';
  out.x = x; out.y = y; out.z = z;
  out.halfX = halfX; out.halfY = halfY; out.halfZ = halfZ;
  out.innerRadius = 0;
  return halfX > 0 && halfY > 0 && halfZ > 0;
}

function writeCylinder(
  out: EntityVolume,
  x: number, y: number, z: number,
  radius: number, halfHeight: number,
): boolean {
  out.shape = 'cylinder';
  out.x = x; out.y = y; out.z = z;
  out.halfX = radius; out.halfY = radius; out.halfZ = halfHeight;
  out.innerRadius = 0;
  return radius > 0 && halfHeight > 0;
}

function writeAnnulus(
  out: EntityVolume,
  x: number, y: number, z: number,
  outerRadius: number, innerRadius: number, halfHeight: number,
): boolean {
  out.shape = 'annulus';
  out.x = x; out.y = y; out.z = z;
  out.halfX = outerRadius; out.halfY = outerRadius; out.halfZ = halfHeight;
  out.innerRadius = Math.max(0, innerRadius);
  return outerRadius > 0 && halfHeight > 0;
}

// ── Selection (mouse pick) ──────────────────────────────────────────────

/** Enlarge the pick volume past the drawn body so clicks near an edge
 *  still land — BAR enlarges selection volumes by a similar factor. Unit
 *  bodies are round and small, so they can afford the generous factor;
 *  buildings are large and often flat, and the same factor there is what
 *  made them answer clicks from a body-length away. */
export const UNIT_SELECTION_VOLUME_SCALE = 1.18;
export const BUILDING_SELECTION_VOLUME_SCALE = 1.05;
/** Floor (world units) so tiny units — and units drawn only as LOD
 *  proxy points at distance — stay easy to click at any zoom. */
export const MIN_UNIT_SELECTION_RADIUS = 12;
/** Floor on each building half-extent so a razor-thin slab (a landing
 *  pad, a low wall) still has something to click. */
export const MIN_BUILDING_SELECTION_HALF_EXTENT = 8;

function isHoveringFabricator(entity: Entity): boolean {
  return entity.building?.hoveringType === 'fabricator';
}

/** The fabricator torus body: a ring floating at hover height. Its tube
 *  half-height is the gap between the ring circle and the outer radius,
 *  the same numbers the collision annulus and its wireframe use. */
function writeFabricatorTorusVolume(
  entity: Entity,
  out: EntityVolume,
  pad: number,
): boolean {
  const building = entity.building;
  if (building === null) return false;
  const ringRadius = fabricatorTorusRingRadius(building.width, building.height);
  const outerRadius = fabricatorTorusOuterRadius(building.width, building.height);
  const tubeHalfHeight = outerRadius - ringRadius;
  return writeAnnulus(
    out,
    entity.transform.x,
    entity.transform.y,
    getUnitGroundZ(entity) + fabricatorTorusHoverHeight(),
    outerRadius + pad,
    ringRadius - tubeHalfHeight - pad,
    tubeHalfHeight + pad,
  );
}

/**
 * The volume the mouse picker tests, and the volume the SEL debug overlay
 * draws. Units keep a body sphere; grounded buildings get an upright box
 * spanning their footprint and their real drawn height; the hovering
 * fabricator gets its torus ring so the wide-open middle stays clickable
 * through to whatever is under it.
 *
 * Returns false when the entity has no pick volume at all.
 */
export function writeSelectionVolume(entity: Entity, out: EntityVolume): boolean {
  const unit = entity.unit;
  if (unit !== null) {
    return writeSphere(
      out,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
      Math.max(MIN_UNIT_SELECTION_RADIUS, unit.radius.other * UNIT_SELECTION_VOLUME_SCALE),
    );
  }
  const building = entity.building;
  if (building !== null) {
    if (isHoveringFabricator(entity)) {
      return writeFabricatorTorusVolume(entity, out, 0);
    }
    const baseZ = getUnitGroundZ(entity);
    const topZ = getBuildingVisualTopZ(entity);
    const halfZ = Math.max(
      MIN_BUILDING_SELECTION_HALF_EXTENT,
      (topZ - baseZ) * 0.5 * BUILDING_SELECTION_VOLUME_SCALE,
    );
    return writeBox(
      out,
      entity.transform.x,
      entity.transform.y,
      (baseZ + topZ) * 0.5,
      Math.max(
        MIN_BUILDING_SELECTION_HALF_EXTENT,
        building.width * 0.5 * BUILDING_SELECTION_VOLUME_SCALE,
      ),
      Math.max(
        MIN_BUILDING_SELECTION_HALF_EXTENT,
        building.height * 0.5 * BUILDING_SELECTION_VOLUME_SCALE,
      ),
      halfZ,
    );
  }
  return false;
}

/** A vegetation prop's pick volume: the upright capped cylinder Rust's
 *  `vegetation_raycast` tests. Props are not entities — thousands of trees
 *  stay out of the entity map — so they get their own writer, but they get
 *  the SAME volume model, and the SEL overlay draws exactly this. */
export function writeVegetationPropVolume(
  prop: { x: number; y: number; z: number; radius: number; height: number },
  out: EntityVolume,
): boolean {
  const halfHeight = prop.height * 0.5;
  return writeCylinder(out, prop.x, prop.y, prop.z + halfHeight, prop.radius, halfHeight);
}

/** World z the selection volume is centered on. Screen-rect box selection
 *  projects this one point, so it must agree with the volume the ray test
 *  uses or a unit could be rubber-band selected where it cannot be
 *  clicked. */
export function selectionVolumeCenterZ(entity: Entity): number {
  if (writeSelectionVolume(entity, _centerScratch)) return _centerScratch.z;
  return entity.transform.z;
}

const _centerScratch = createEntityVolume();

// ── Hit / damage volumes ────────────────────────────────────────────────

/** The volume projectiles, beams, and splash test. Units are spheres at
 *  the body center; buildings are the width x height x depth combat box
 *  the sim stamps into targeting (floating for the hovering torus). */
export function writeHitVolume(entity: Entity, out: EntityVolume): boolean {
  const unit = entity.unit;
  if (unit !== null) {
    return writeSphere(
      out, entity.transform.x, entity.transform.y, entity.transform.z, unit.radius.hitbox,
    );
  }
  const building = entity.building;
  if (building !== null) {
    return writeBox(
      out,
      entity.transform.x,
      entity.transform.y,
      buildingCombatCenterZ(entity),
      building.width * 0.5,
      building.height * 0.5,
      building.depth * 0.5,
    );
  }
  const projectile = entity.projectile;
  if (projectile !== null) {
    return writeSphere(
      out,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
      projectile.config.shotProfile.runtime.radius.collision,
    );
  }
  return false;
}

// ── Physics collision volumes ───────────────────────────────────────────

/** The physics volume. Units are collision spheres; grounded buildings
 *  are their static ground-seated cuboid; the fabricator is its floating
 *  annular ring, which units walk under and through the middle of. */
export function writeCollisionVolume(entity: Entity, out: EntityVolume): boolean {
  const unit = entity.unit;
  if (unit !== null) {
    return writeSphere(
      out, entity.transform.x, entity.transform.y, entity.transform.z, unit.radius.collision,
    );
  }
  const building = entity.building;
  if (building !== null) {
    if (isHoveringFabricator(entity)) return writeFabricatorTorusVolume(entity, out, 0);
    return writeBox(
      out,
      entity.transform.x,
      entity.transform.y,
      buildingCombatCenterZ(entity),
      building.width * 0.5,
      building.height * 0.5,
      building.depth * 0.5,
    );
  }
  return false;
}

/** The host-centered safety sphere a shot must fully clear before it
 *  arms. Hosts only — the projectile carries a copy of the number, not a
 *  volume of its own. */
export function writeArmingVolume(entity: Entity, out: EntityVolume): boolean {
  if (entity.unit === null && entity.building === null) return false;
  return writeSphere(
    out,
    entity.transform.x,
    entity.transform.y,
    entity.unit !== null ? entity.transform.z : buildingCombatCenterZ(entity),
    getHostShotArmingRadius(entity),
  );
}

/** The splash volume a shot detonates with. Projectiles only. */
export function writeExplosionVolume(entity: Entity, out: EntityVolume): boolean {
  const projectile = entity.projectile;
  if (projectile === null || projectile.hasExploded) return false;
  return writeSphere(
    out,
    entity.transform.x,
    entity.transform.y,
    entity.transform.z,
    projectile.config.shotProfile.runtime.deathExplosionRadius,
  );
}

/** Combat/physics box center. Grounded buildings keep transform.z (their
 *  box is ground-centered); the hovering torus engages in the air. */
function buildingCombatCenterZ(entity: Entity): number {
  if (isHoveringFabricator(entity)) {
    return getUnitGroundZ(entity) + fabricatorTorusHoverHeight();
  }
  return entity.transform.z;
}

// ── Ray tests ───────────────────────────────────────────────────────────

/**
 * Nearest positive distance along a UNIT-LENGTH sim-space ray at which it
 * enters `volume`, or -1 for a miss. A ray starting inside the volume
 * returns 0, so a click from inside a structure still picks it.
 */
export function rayVolumeT(
  volume: EntityVolume,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number {
  switch (volume.shape) {
    case 'sphere':
      return raySphereT(volume, ox, oy, oz, dx, dy, dz);
    case 'box':
      return rayBoxT(volume, ox, oy, oz, dx, dy, dz);
    case 'cylinder':
      return rayCylinderT(volume, ox, oy, oz, dx, dy, dz, volume.halfX);
    case 'annulus':
      return rayAnnulusT(volume, ox, oy, oz, dx, dy, dz);
  }
}

function raySphereT(
  volume: EntityVolume,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number {
  const radius = volume.halfX;
  if (radius <= 0) return -1;
  const mx = volume.x - ox;
  const my = volume.y - oy;
  const mz = volume.z - oz;
  const t = mx * dx + my * dy + mz * dz;
  const distSq = mx * mx + my * my + mz * mz;
  const radiusSq = radius * radius;
  if (distSq <= radiusSq) return 0; // origin inside
  if (t < 0) return -1; // behind the ray
  const perpSq = distSq - t * t;
  if (perpSq > radiusSq) return -1;
  return t - Math.sqrt(radiusSq - perpSq);
}

/** Slab test on all three axes. */
function rayBoxT(
  volume: EntityVolume,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number {
  let tEnter = 0;
  let tExit = Infinity;
  const axes = 3;
  for (let axis = 0; axis < axes; axis++) {
    const origin = axis === 0 ? ox : axis === 1 ? oy : oz;
    const dir = axis === 0 ? dx : axis === 1 ? dy : dz;
    const center = axis === 0 ? volume.x : axis === 1 ? volume.y : volume.z;
    const half = axis === 0 ? volume.halfX : axis === 1 ? volume.halfY : volume.halfZ;
    const lo = center - half;
    const hi = center + half;
    if (Math.abs(dir) < 1e-9) {
      if (origin < lo || origin > hi) return -1;
      continue;
    }
    const t0 = (lo - origin) / dir;
    const t1 = (hi - origin) / dir;
    const near = t0 <= t1 ? t0 : t1;
    const far = t0 <= t1 ? t1 : t0;
    if (near > tEnter) tEnter = near;
    if (far < tExit) tExit = far;
    if (tEnter > tExit) return -1;
  }
  return tExit < 0 ? -1 : tEnter;
}

/**
 * The [enter, exit] range over which the ray lies between the two z caps.
 * Written into `out`; returns false when the ray never lies inside them.
 */
function slabRange(
  lo: number, hi: number, origin: number, dir: number, out: number[],
): boolean {
  if (Math.abs(dir) < 1e-9) {
    if (origin < lo || origin > hi) return false;
    out[0] = -Infinity;
    out[1] = Infinity;
    return true;
  }
  const t0 = (lo - origin) / dir;
  const t1 = (hi - origin) / dir;
  out[0] = t0 <= t1 ? t0 : t1;
  out[1] = t0 <= t1 ? t1 : t0;
  return true;
}

/**
 * The [enter, exit] range over which the ray lies inside an INFINITE
 * vertical cylinder of `radius` around the volume's axis. A ray running
 * exactly parallel to the axis is either inside forever or never — which
 * is precisely what makes the annulus hole work: straight down the middle
 * of the ring, the exclusion range is unbounded, so nothing is hit.
 */
function axisRange(
  volume: EntityVolume,
  ox: number, oy: number,
  dx: number, dy: number,
  radius: number,
  out: number[],
): boolean {
  const mx = ox - volume.x;
  const my = oy - volume.y;
  const a = dx * dx + dy * dy;
  const c = mx * mx + my * my - radius * radius;
  if (a < 1e-12) {
    if (c > 0) return false;
    out[0] = -Infinity;
    out[1] = Infinity;
    return true;
  }
  const b = 2 * (mx * dx + my * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sqrtDisc = Math.sqrt(disc);
  out[0] = (-b - sqrtDisc) / (2 * a);
  out[1] = (-b + sqrtDisc) / (2 * a);
  return true;
}

const _slabScratch = [0, 0];
const _outerScratch = [0, 0];
const _innerScratch = [0, 0];

/** Ray vs. upright capped cylinder. */
function rayCylinderT(
  volume: EntityVolume,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  radius: number,
): number {
  if (radius <= 0 || volume.halfZ <= 0) return -1;
  if (!slabRange(volume.z - volume.halfZ, volume.z + volume.halfZ, oz, dz, _slabScratch)) {
    return -1;
  }
  if (!axisRange(volume, ox, oy, dx, dy, radius, _outerScratch)) return -1;
  const enter = Math.max(0, _slabScratch[0], _outerScratch[0]);
  const exit = Math.min(_slabScratch[1], _outerScratch[1]);
  return enter > exit ? -1 : enter;
}

/**
 * Annular cylinder: inside the outer wall, outside the inner hole. The
 * hole is excluded as an interval on the ray, NOT as a second capped
 * cylinder — a ray leaving the hole through a z cap has left the whole
 * volume, not entered its solid ring.
 */
function rayAnnulusT(
  volume: EntityVolume,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number {
  if (volume.halfX <= 0 || volume.halfZ <= 0) return -1;
  if (!slabRange(volume.z - volume.halfZ, volume.z + volume.halfZ, oz, dz, _slabScratch)) {
    return -1;
  }
  if (!axisRange(volume, ox, oy, dx, dy, volume.halfX, _outerScratch)) return -1;
  const enter = Math.max(0, _slabScratch[0], _outerScratch[0]);
  const exit = Math.min(_slabScratch[1], _outerScratch[1]);
  if (enter > exit) return -1;
  if (volume.innerRadius <= 0) return enter;
  if (!axisRange(volume, ox, oy, dx, dy, volume.innerRadius, _innerScratch)) return enter;
  // Inside the hole at `enter`: the first solid surface is where the ray
  // leaves the hole's side wall, and only if it is still inside the ring.
  if (enter > _innerScratch[0] && enter < _innerScratch[1]) {
    const holeExit = _innerScratch[1];
    return holeExit <= exit ? holeExit : -1;
  }
  return enter;
}
