import { computeAvoidanceSteer, type AvoidanceNeighbor } from './localAvoidance';
import {
  PATHFINDING_AVOIDANCE_LOOKAHEAD_WU,
  PATHFINDING_AVOIDANCE_STRENGTH,
} from './pathfindingTuning';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[local avoidance contract] ${message}`);
}

function body(id: number, x: number, y: number, vx = 0, vy = 0): AvoidanceNeighbor {
  return { id, x, y, radius: 20, velocityX: vx, velocityY: vy };
}

export function runLocalAvoidanceContractTest(): void {
  const far = PATHFINDING_AVOIDANCE_LOOKAHEAD_WU * 4;
  const me = body(1, 0, 0, 30, 0);

  // Head-on: the two bodies pick opposite sides, reciprocally.
  const other = body(2, 60, 0, -30, 0);
  const mine = computeAvoidanceSteer(me, 1, 0, far, [other]);
  const theirs = computeAvoidanceSteer({ ...other }, -1, 0, far, [me]);
  assertContract(mine !== 0 && theirs !== 0, 'a head-on body ahead must produce a steer');
  // In world terms: I (lower id) go left of my direction (+y), they go left
  // of theirs (-y): opposite world sides.
  assertContract(mine > 0 && theirs > 0, `exactly-on-line tie breaks by id: ${mine}, ${theirs}`);
  assertContract(
    Math.abs(mine) <= PATHFINDING_AVOIDANCE_STRENGTH + 1e-9,
    'steer is bounded by the authored strength',
  );

  // A body offset to my left sends me right; one on my right sends me left.
  const left = computeAvoidanceSteer(me, 1, 0, far, [body(3, 60, 15)]);
  const right = computeAvoidanceSteer(me, 1, 0, far, [body(3, 60, -15)]);
  assertContract(left < 0 && right > 0, `offset bodies steer away: ${left}, ${right}`);

  // Behind, beside-and-clear, or far ahead: no steer.
  assertContract(computeAvoidanceSteer(me, 1, 0, far, [body(4, -60, 0)]) === 0, 'behind');
  assertContract(computeAvoidanceSteer(me, 1, 0, far, [body(5, 60, 80)]) === 0, 'clear beside');
  assertContract(
    computeAvoidanceSteer(me, 1, 0, far, [body(6, PATHFINDING_AVOIDANCE_LOOKAHEAD_WU + 200, 0)]) === 0,
    'beyond lookahead',
  );
  // A body ahead pulling away faster than we close is ignored once clear.
  assertContract(
    computeAvoidanceSteer(me, 1, 0, far, [body(7, 120, 0, 90, 0)]) === 0,
    'a faster body ahead is not an obstacle',
  );
  // Arrival fade: the same obstacle produces a smaller nudge when the
  // waypoint is close.
  const near = computeAvoidanceSteer(me, 1, 0, PATHFINDING_AVOIDANCE_LOOKAHEAD_WU * 0.25, [body(8, 60, 15)]);
  assertContract(Math.abs(near) < Math.abs(left), 'braking into the waypoint fades the nudge');
  // Determinism: same inputs, same output, bit for bit.
  assertContract(
    Object.is(computeAvoidanceSteer(me, 1, 0, far, [body(3, 60, 15)]), left),
    'pure and repeatable',
  );
}
