import { deterministicMath as DMath } from './deterministicMath';
import type { Entity } from './types';
import { spatialGrid } from './SpatialGrid';
import {
  PATHFINDING_AVOIDANCE_LATERAL_MARGIN_WU,
  PATHFINDING_AVOIDANCE_LOOKAHEAD_WU,
  PATHFINDING_AVOIDANCE_STRENGTH,
} from './pathfindingTuning';

// Local avoidance — deterministic reciprocal side-step.
//
// The planner routes around terrain and structures; it knows nothing about
// other units, and until now neither did the controller: two bodies heading
// for the same gap simply drove into each other and let the contact solver
// sort it out, which is how chokepoints jammed. This layer nudges the DRIVE
// DIRECTION (never the waypoint, never the plan) sideways around bodies
// ahead, the way a person walking down a corridor drifts past someone coming
// the other way.
//
// Reciprocal: both bodies apply the same rule and pick opposite sides, so
// each only has to move half the clearance. Deterministic: the neighbour
// query order is the spatial grid's canonical order on every peer, the
// arithmetic is plain f64, and a body exactly on the line is sent by entity
// id order — never a random or wall-clock tie-break.
//
// Scope: ground movers only. Air bodies overfly; naval hulls have a lot of
// water and few neighbours. A body braking for its final waypoint fades the
// nudge out so arrival cannot oscillate.

export type AvoidanceNeighbor = Readonly<{
  id: number;
  x: number;
  y: number;
  radius: number;
  velocityX: number;
  velocityY: number;
}>;

export type AvoidanceSelf = Readonly<{
  id: number;
  x: number;
  y: number;
  radius: number;
  velocityX: number;
  velocityY: number;
}>;

/** Scalar lateral steer in [-strength, +strength] along the LEFT normal of
 *  the drive direction (-dirY, dirX): positive = drift left. Pure. */
export function computeAvoidanceSteer(
  self: AvoidanceSelf,
  dirX: number,
  dirY: number,
  distanceToWaypoint: number,
  neighbors: readonly AvoidanceNeighbor[],
): number {
  const leftX = -dirY;
  const leftY = dirX;
  let steer = 0;
  for (let i = 0; i < neighbors.length; i++) {
    const n = neighbors[i];
    if (n.id === self.id) continue;
    const px = n.x - self.x;
    const py = n.y - self.y;
    const forward = px * dirX + py * dirY;
    if (forward <= 0) continue; // behind us
    const clearance = self.radius + n.radius + PATHFINDING_AVOIDANCE_LATERAL_MARGIN_WU;
    const lookahead = PATHFINDING_AVOIDANCE_LOOKAHEAD_WU + self.radius + n.radius;
    const dist = DMath.sqrt(px * px + py * py);
    if (dist >= lookahead) continue;
    const lateral = px * leftX + py * leftY;
    const absLateral = Math.abs(lateral);
    if (absLateral >= clearance) continue; // passes clear already
    // A neighbour pulling away along our direction faster than we close on
    // it will never be reached; ignore it once it is out of contact range.
    const relForward = (n.velocityX - self.velocityX) * dirX + (n.velocityY - self.velocityY) * dirY;
    if (relForward >= 0 && forward > clearance) continue;
    const proximity = 1 - dist / lookahead;
    const overlap = 1 - absLateral / clearance;
    const weight = proximity * overlap;
    // Neighbour on our left (lateral > 0) → we go right (negative), and
    // reciprocally it sees us on its right and goes left. Exactly on the
    // line: the lower entity id goes left.
    const side = lateral > 1e-6 ? -1 : lateral < -1e-6 ? 1 : self.id < n.id ? 1 : -1;
    steer += side * weight;
  }
  if (steer === 0) return 0;
  // Fade the nudge as the body brakes into its waypoint so arrival is clean.
  const arrivalFade = Math.min(1, distanceToWaypoint / PATHFINDING_AVOIDANCE_LOOKAHEAD_WU);
  const clamped = Math.max(-1, Math.min(1, steer));
  return clamped * PATHFINDING_AVOIDANCE_STRENGTH * arrivalFade;
}

const selfScratch = { id: 0, x: 0, y: 0, radius: 0, velocityX: 0, velocityY: 0 };
const neighborScratch: AvoidanceNeighbor[] = [];
const neighborPool: { id: number; x: number; y: number; radius: number; velocityX: number; velocityY: number }[] = [];
const steered = { x: 0, y: 0 };

/** Rotate a ground mover's drive vector (dx, dy — pointing at its waypoint,
 *  length = distance) sideways around bodies ahead. Returns the SAME length
 *  so braking distances are unchanged. Air and water bodies pass through. */
export function applyLocalAvoidance(
  entity: Entity,
  dx: number,
  dy: number,
  distance: number,
): { x: number; y: number } {
  steered.x = dx;
  steered.y = dy;
  const unit = entity.unit;
  if (unit === null || distance <= 1e-6) return steered;
  const move = unit.locomotion.navigation.move;
  if (!move.allowOnGround || move.allowInAir) return steered;
  const radius = unit.radius.collision;
  const lookahead = PATHFINDING_AVOIDANCE_LOOKAHEAD_WU + radius * 3;
  const candidates = spatialGrid.queryUnitsInRadius(
    entity.transform.x,
    entity.transform.y,
    entity.transform.z,
    lookahead,
  );
  let count = 0;
  for (let i = 0; i < candidates.length; i++) {
    const other = candidates[i];
    if (other === entity) continue;
    const ou = other.unit;
    if (ou === null || ou.hp <= 0 || other.body === null) continue;
    const om = ou.locomotion.navigation.move;
    if (!om.allowOnGround || om.allowInAir) continue;
    if (count >= neighborPool.length) {
      neighborPool.push({ id: 0, x: 0, y: 0, radius: 0, velocityX: 0, velocityY: 0 });
    }
    const slot = neighborPool[count];
    slot.id = other.id;
    slot.x = other.transform.x;
    slot.y = other.transform.y;
    slot.radius = ou.radius.collision;
    slot.velocityX = ou.velocityX;
    slot.velocityY = ou.velocityY;
    neighborScratch[count] = slot;
    count++;
  }
  if (count === 0) return steered;
  neighborScratch.length = count;
  selfScratch.id = entity.id;
  selfScratch.x = entity.transform.x;
  selfScratch.y = entity.transform.y;
  selfScratch.radius = radius;
  selfScratch.velocityX = unit.velocityX;
  selfScratch.velocityY = unit.velocityY;
  const invDistance = 1 / distance;
  const dirX = dx * invDistance;
  const dirY = dy * invDistance;
  const steer = computeAvoidanceSteer(selfScratch, dirX, dirY, distance, neighborScratch);
  neighborScratch.length = 0;
  if (steer === 0) return steered;
  const nx = dirX - dirY * steer;
  const ny = dirY + dirX * steer;
  const len = DMath.sqrt(nx * nx + ny * ny);
  if (len <= 1e-9) return steered;
  const scale = distance / len;
  steered.x = nx * scale;
  steered.y = ny * scale;
  return steered;
}
