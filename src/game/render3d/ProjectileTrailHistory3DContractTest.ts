import {
  TRAIL_HIGH_CURVE_SEGMENTS,
  TRAIL_STAMP_CAP,
  createTrailResampleScratch,
  createTrailStampBuffer,
  insertTrailStamp,
  resampleTrailCenterline,
  stampTrailHeadIfMoved,
  type TrailStampBuffer,
} from './ProjectileTrailHistory3D';
import {
  PLASMA_IMPACT_COLLAPSE_DURATION_MS,
  plasmaImpactCollapseTailLength,
} from './PlasmaImpactCollapse3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[projectile trail history contract] ${message}`);
}

function assertClose(
  actual: number,
  expected: number,
  epsilon: number,
  message: string,
): void {
  assertContract(
    Math.abs(actual - expected) <= epsilon,
    `${message} (got ${actual}, expected ${expected})`,
  );
}

type Point = readonly [number, number, number];

function distance(a: Point, b: Point): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function ringAt(scratch: { centerline: Float32Array }, ring: number): Point {
  const base = ring * 3;
  return [
    scratch.centerline[base],
    scratch.centerline[base + 1],
    scratch.centerline[base + 2],
  ];
}

/** Ballistic sample: a real plasma arc, curved enough that a tail aimed at
 *  the head's instantaneous velocity visibly leaves the flight path. */
function ballisticPoint(t: number): Point {
  const speed = 548;
  const gravity = 300;
  const cos45 = Math.SQRT1_2;
  return [speed * cos45 * t, 0, speed * cos45 * t - 0.5 * gravity * t * t];
}

/** Distance from `point` to the polyline [head, stamp0, stamp1, ...] — how
 *  far off the recorded flight path a drawn tail point sits. */
function distanceToRecordedPath(
  point: Point,
  head: Point,
  stamps: TrailStampBuffer,
): number {
  let best = Number.POSITIVE_INFINITY;
  let prev = head;
  for (let k = 0; k < stamps.count; k++) {
    const o = k * 3;
    const next: Point = [stamps.points[o], stamps.points[o + 1], stamps.points[o + 2]];
    const ex = next[0] - prev[0];
    const ey = next[1] - prev[1];
    const ez = next[2] - prev[2];
    const lengthSq = ex * ex + ey * ey + ez * ez;
    let t = lengthSq > 1e-9
      ? ((point[0] - prev[0]) * ex + (point[1] - prev[1]) * ey + (point[2] - prev[2]) * ez) /
        lengthSq
      : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    best = Math.min(
      best,
      distance(point, [prev[0] + ex * t, prev[1] + ey * t, prev[2] + ez * t]),
    );
    prev = next;
  }
  return best;
}

/** Flies a plasma shot along the ballistic sample, stamping exactly the way
 *  the renderer does, and returns the buffer plus the final head. */
function flyBallisticShot(
  tailLength: number,
  frames: number,
): { stamps: TrailStampBuffer; head: Point } {
  const stamps = createTrailStampBuffer();
  let head: Point = ballisticPoint(0);
  for (let frame = 0; frame < frames; frame++) {
    head = ballisticPoint(frame / 60);
    stampTrailHeadIfMoved(stamps, head[0], head[1], head[2], tailLength);
  }
  return { stamps, head };
}

/** Every rung ends its tail at the same world point.
 *
 *  This is what lets the single-segment LOW tail follow the flight path at
 *  all: it draws to the same arc point the deeper rungs reach, so a shot
 *  crossing a rung boundary does not pop. If a future change makes the last
 *  ring's distance depend on the ring count, LOW silently stops matching. */
function assertEveryRungEndsAtTheSamePoint(): void {
  const tailLength = 96;
  const { stamps, head } = flyBallisticShot(tailLength, 90);
  const scratch = createTrailResampleScratch(TRAIL_HIGH_CURVE_SEGMENTS);

  let reference: Point | null = null;
  let referenceSpan = 0;
  for (const curveSegments of [1, 3, TRAIL_HIGH_CURVE_SEGMENTS]) {
    const span = resampleTrailCenterline(
      scratch, head[0], head[1], head[2], stamps, tailLength, curveSegments,
    );
    const tip = ringAt(scratch, curveSegments);
    if (reference === null) {
      reference = tip;
      referenceSpan = span;
      assertClose(
        span, tailLength, 1e-3,
        'a fully grown tail should draw its whole authored length',
      );
      continue;
    }
    assertClose(
      span, referenceSpan, 1e-3,
      `rung with ${curveSegments} segments drew a different span`,
    );
    assertContract(
      distance(tip, reference) <= 1e-3,
      `rung with ${curveSegments} segments ended its tail somewhere else ` +
        `(${distance(tip, reference)} away) — the LOW tail would pop on rung change`,
    );
  }

  // Ring 0 is the live head at every rung.
  assertContract(
    distance(ringAt(scratch, 0), head) <= 1e-4,
    'ring 0 must stay on the live head',
  );
}

/** The drawn tail sits on the recorded path, not on the head's heading.
 *
 *  A single segment aimed down the instantaneous velocity pivots its far tip
 *  about a whole tail-length lever arm; on a curved path that leaves the arc
 *  entirely. The resampled tip must instead lie on the recorded polyline. */
function assertSingleSegmentTailFollowsTheArc(): void {
  const tailLength = 192;
  const { stamps, head } = flyBallisticShot(tailLength, 150);
  const scratch = createTrailResampleScratch(TRAIL_HIGH_CURVE_SEGMENTS);

  const span = resampleTrailCenterline(
    scratch, head[0], head[1], head[2], stamps, tailLength, 1,
  );
  const tip = ringAt(scratch, 1);
  assertContract(
    distanceToRecordedPath(tip, head, stamps) <= 1e-3,
    'the single-segment tail tip must lie on the recorded flight path',
  );

  // The velocity-aimed spike this replaced: head plus one tail length down
  // the current heading. On this arc it must be visibly off the path, or the
  // test is not exercising a curve at all.
  const previous = ballisticPoint(149 / 60 - 1 / 60);
  const heading = [head[0] - previous[0], head[1] - previous[1], head[2] - previous[2]];
  const headingLength = Math.hypot(heading[0], heading[1], heading[2]);
  const spike: Point = [
    head[0] - (heading[0] / headingLength) * span,
    head[1] - (heading[1] / headingLength) * span,
    head[2] - (heading[2] / headingLength) * span,
  ];
  assertContract(
    distanceToRecordedPath(spike, head, stamps) > 1,
    'sample arc is too flat to distinguish a path-aimed tail from a velocity-aimed one',
  );
}

/** Cached stamp-to-stamp legs must equal a from-scratch measurement.
 *
 *  The arc table is rebuilt from legs recorded at insert time so it costs one
 *  square root per projectile instead of one per stamp. A shift, an eviction,
 *  or a forced reflection insert that fails to carry its leg along would skew
 *  every ring behind it. */
function assertCachedLegsMatchMeasuredPath(): void {
  const tailLength = 96;
  const { stamps, head } = flyBallisticShot(tailLength, 200);
  assertContract(
    stamps.count === TRAIL_STAMP_CAP,
    'the sample flight should fill the stamp buffer and exercise eviction',
  );
  // A reflection stamp inserted out of band still has to record its own leg.
  insertTrailStamp(stamps, head[0] - 3, head[1], head[2] + 2, true);

  let measured = 0;
  let prev = head;
  for (let k = 0; k < stamps.count; k++) {
    const o = k * 3;
    const next: Point = [stamps.points[o], stamps.points[o + 1], stamps.points[o + 2]];
    measured += distance(prev, next);
    prev = next;
  }

  // With no length limit the drawn span is the whole recorded polyline, so
  // the return value exposes the arc table's total. Read it through a
  // multi-ring rung: a single-segment tail would clamp at the reflection
  // stamp instead of reporting the full path.
  const scratch = createTrailResampleScratch(TRAIL_HIGH_CURVE_SEGMENTS);
  const cachedTotal = resampleTrailCenterline(
    scratch, head[0], head[1], head[2], stamps,
    Number.MAX_SAFE_INTEGER, TRAIL_HIGH_CURVE_SEGMENTS,
  );
  assertClose(
    cachedTotal, measured, 1e-2,
    'cached leg lengths disagree with the measured polyline',
  );
}

/** Evicting the oldest stamp must not move drawn geometry.
 *
 *  The buffer is deliberately deeper than the resample horizon so the tail
 *  never reaches the slot that drops off. Stamping at the current head makes
 *  the polyline geometrically identical apart from that eviction, so every
 *  ring has to stay exactly where it was. */
function assertEvictionNeverMovesDrawnGeometry(): void {
  const tailLength = 96;
  const { stamps, head } = flyBallisticShot(tailLength, 200);
  assertContract(
    stamps.count === TRAIL_STAMP_CAP,
    'the sample flight should fill the stamp buffer before testing eviction',
  );
  const scratch = createTrailResampleScratch(TRAIL_HIGH_CURVE_SEGMENTS);

  resampleTrailCenterline(
    scratch, head[0], head[1], head[2], stamps, tailLength, TRAIL_HIGH_CURVE_SEGMENTS,
  );
  const before = Array.from(scratch.centerline);

  insertTrailStamp(stamps, head[0], head[1], head[2], false);
  resampleTrailCenterline(
    scratch, head[0], head[1], head[2], stamps, tailLength, TRAIL_HIGH_CURVE_SEGMENTS,
  );

  for (let i = 0; i < before.length; i++) {
    assertClose(
      scratch.centerline[i], before[i], 1e-3,
      `dropping the oldest stamp moved centerline component ${i}`,
    );
  }
}

/** A shield bounce ends a single-segment tail at the contact point, while
 *  deeper rungs keep their full span and pin the kink onto an interior ring.
 *
 *  One segment has no interior ring to hold a bend, so drawing the full span
 *  would run a chord straight through the shield the shot just came off. */
function assertBounceHandling(): void {
  const tailLength = 96;
  const { stamps, head: approach } = flyBallisticShot(tailLength, 90);
  const scratch = createTrailResampleScratch(TRAIL_HIGH_CURVE_SEGMENTS);

  // Reflect: contact point stamped at the surface, then the shot flies back
  // out far enough to have laid new path but not a whole tail's worth.
  const contact: Point = [approach[0] + 4, approach[1], approach[2] + 2];
  insertTrailStamp(stamps, contact[0], contact[1], contact[2], true);
  let head: Point = contact;
  for (let frame = 1; frame <= 3; frame++) {
    head = [contact[0] - frame * 9, contact[1], contact[2] + frame * 3];
    stampTrailHeadIfMoved(stamps, head[0], head[1], head[2], tailLength);
  }
  const contactDistance = distance(head, contact);
  assertContract(
    contactDistance > 1 && contactDistance < tailLength,
    'the bounce sample must leave the contact point inside the drawn tail',
  );

  const lowSpan = resampleTrailCenterline(
    scratch, head[0], head[1], head[2], stamps, tailLength, 1,
  );
  assertClose(
    lowSpan, contactDistance, 1e-2,
    'a single-segment tail should stop at the shield contact point',
  );
  assertContract(
    distance(ringAt(scratch, 1), contact) <= 1e-2,
    'the single-segment tail tip should sit on the contact point, not past it',
  );

  const highSpan = resampleTrailCenterline(
    scratch, head[0], head[1], head[2], stamps, tailLength, TRAIL_HIGH_CURVE_SEGMENTS,
  );
  assertContract(
    highSpan > contactDistance,
    'a multi-ring tail keeps its full span through a bounce and pins the kink',
  );
  let pinnedRing = -1;
  for (let ring = 1; ring < TRAIL_HIGH_CURVE_SEGMENTS; ring++) {
    if (distance(ringAt(scratch, ring), contact) <= 1e-2) pinnedRing = ring;
  }
  assertContract(
    pinnedRing > 0,
    'the deep rung should pin an interior ring onto the reflection kink',
  );
}

/** A shot with no recorded path yet draws no tail at all. */
function assertFreshShotCollapsesOntoTheHead(): void {
  const stamps = createTrailStampBuffer();
  const head: Point = [12, -5, 30];
  stampTrailHeadIfMoved(stamps, head[0], head[1], head[2], 96);
  const scratch = createTrailResampleScratch(TRAIL_HIGH_CURVE_SEGMENTS);

  for (const curveSegments of [1, TRAIL_HIGH_CURVE_SEGMENTS]) {
    const span = resampleTrailCenterline(
      scratch, head[0], head[1], head[2], stamps, 96, curveSegments,
    );
    assertClose(span, 0, 1e-9, 'a shot with no path yet should draw zero span');
    for (let ring = 0; ring <= curveSegments; ring++) {
      assertContract(
        distance(ringAt(scratch, ring), head) <= 1e-4,
        `ring ${ring} should collapse onto the head before any path exists`,
      );
    }
  }
}

/** Terminal presentation reverses tail growth without moving the impact head.
 * The sim entity is already gone; only its frozen path is resampled through a
 * smoothly shrinking horizon, identically at every geometry rung. */
function assertImpactTailCollapsesIntoFixedHead(): void {
  const fullTailLength = 96;
  const { stamps, head: lastLiveHead } = flyBallisticShot(fullTailLength, 120);
  insertTrailStamp(
    stamps,
    lastLiveHead[0],
    lastLiveHead[1],
    lastLiveHead[2],
    false,
  );
  const impactHead: Point = [
    lastLiveHead[0] + 5,
    lastLiveHead[1],
    lastLiveHead[2] - 2,
  ];
  const samples = [0, 45, 90, 135, PLASMA_IMPACT_COLLAPSE_DURATION_MS];
  const scratch = createTrailResampleScratch(TRAIL_HIGH_CURVE_SEGMENTS);

  assertClose(
    plasmaImpactCollapseTailLength(fullTailLength, 0),
    fullTailLength,
    1e-9,
    'impact collapse must begin at the complete visible tail length',
  );
  assertClose(
    plasmaImpactCollapseTailLength(fullTailLength, 90),
    fullTailLength * 0.5,
    1e-9,
    'smooth symmetric collapse must reach half its path horizon at half time',
  );
  assertClose(
    plasmaImpactCollapseTailLength(
      fullTailLength,
      PLASMA_IMPACT_COLLAPSE_DURATION_MS,
    ),
    0,
    1e-9,
    'impact collapse must end with no remaining tail',
  );

  for (const curveSegments of [1, 3, TRAIL_HIGH_CURVE_SEGMENTS]) {
    let previousSpan = Number.POSITIVE_INFINITY;
    for (const elapsedMs of samples) {
      const horizon = plasmaImpactCollapseTailLength(fullTailLength, elapsedMs);
      const span = resampleTrailCenterline(
        scratch,
        impactHead[0],
        impactHead[1],
        impactHead[2],
        stamps,
        horizon,
        curveSegments,
      );
      assertContract(
        distance(ringAt(scratch, 0), impactHead) <= 1e-4,
        `rung ${curveSegments} moved the plasma head during impact collapse`,
      );
      assertContract(
        span <= previousSpan + 1e-4,
        `rung ${curveSegments} moved its tail away from the impact head`,
      );
      previousSpan = span;
      if (elapsedMs === PLASMA_IMPACT_COLLAPSE_DURATION_MS) {
        assertClose(span, 0, 1e-9, `rung ${curveSegments} retained a terminal tail`);
        assertContract(
          distance(ringAt(scratch, curveSegments), impactHead) <= 1e-4,
          `rung ${curveSegments} did not finish with its tail at the head`,
        );
      }
    }
  }
}

export function runProjectileTrailHistory3DContractTest(): void {
  assertEveryRungEndsAtTheSamePoint();
  assertSingleSegmentTailFollowsTheArc();
  assertCachedLegsMatchMeasuredPath();
  assertEvictionNeverMovesDrawnGeometry();
  assertBounceHandling();
  assertFreshShotCollapsesOntoTheHead();
  assertImpactTailCollapsesIntoFixedHead();
}
