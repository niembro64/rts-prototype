/** Recorded flight path behind one projectile, and the resampler every
 *  plasma detail rung draws its tail from.
 *
 *  Trail stamps record the projectile's recent path as a polyline of
 *  positions frozen in render space the moment they were laid down, so
 *  MOVE POS / VEL EMAs only ever affect the live head — old stamps don't
 *  drift around behind the projectile. The drawn tail is resampled from
 *  this history every frame instead of mapping stamps to rings
 *  one-to-one, so the buffer is deeper than any rung's ring count: the
 *  resample horizon is 7/6 of the tail length (kink pin + relax window),
 *  ordinary stamps land one drawn-segment-length apart, and forced
 *  reflection stamps can land arbitrarily close together. The extra slots
 *  keep the recorded polyline longer than the horizon, so evicting the
 *  oldest stamp never moves drawn geometry.
 *
 *  Every rung resamples the same history, down to the single-segment LOW
 *  tail. A tail always ends at the drawn span whatever its ring count, so
 *  the rung swap moves no vertex. Aiming a tail down the head's
 *  instantaneous velocity instead would pivot its far tip about a whole
 *  tail-length lever arm and whip it off the flight path — worst on
 *  high-arc mortars and on the frame a shield reverses a shot. */

/** Ring count of the deepest plasma tail, which also sets the stamp
 *  spacing every rung records at. */
export const TRAIL_HIGH_CURVE_SEGMENTS = 6;

/** Recorded polyline depth: the deepest tail's rings plus the slack that
 *  keeps the path longer than the resample horizon. */
export const TRAIL_STAMP_CAP = TRAIL_HIGH_CURVE_SEGMENTS + 4;

export type TrailStampBuffer = {
  // Length TRAIL_STAMP_CAP * 3, indexed newest-first. Slot 0 is the most
  // recent stamp; slot count-1 is the oldest. The oldest stamp is
  // evicted when stamping past the cap.
  points: Float32Array;
  // 1 where the matching slot is a forced reflection stamp (the exact
  // shield contact point), 0 for ordinary distance stamps. Kept in
  // lockstep with points so the resampler can pin a ring onto the kink.
  flags: Uint8Array;
  // legLengths[k] is the distance from slot k-1 back to slot k, measured
  // once when slot k's stamp was laid. Both endpoints are frozen the
  // moment a stamp exists, so the value can never go stale; only the leg
  // from the live head to slot 0 has to be measured each frame. Slot 0 is
  // unused. Kept in lockstep with points.
  legLengths: Float32Array;
  count: number;
};

/** Reused per-frame working set for the resampler. One instance serves
 *  every projectile in a frame, sized for the deepest rung it will run. */
export type TrailResampleScratch = {
  /** Ring centers, sim axis order, ring 0 being the live head. */
  centerline: Float32Array;
  /** Each ring's arc distance behind the head. */
  ringDist: Float32Array;
  /** Cumulative arc length along [head, stamp0, stamp1, ...]. */
  arc: Float32Array;
};

export function createTrailStampBuffer(): TrailStampBuffer {
  return {
    points: new Float32Array(TRAIL_STAMP_CAP * 3),
    flags: new Uint8Array(TRAIL_STAMP_CAP),
    legLengths: new Float32Array(TRAIL_STAMP_CAP),
    count: 0,
  };
}

export function createTrailResampleScratch(
  maxCurveSegments: number,
): TrailResampleScratch {
  return {
    centerline: new Float32Array((maxCurveSegments + 1) * 3),
    ringDist: new Float32Array(maxCurveSegments + 1),
    arc: new Float32Array(TRAIL_STAMP_CAP + 1),
  };
}

/** Shifts older stamps one slot deeper (dropping the oldest if at cap)
 *  and writes the new stamp into slot 0. */
export function insertTrailStamp(
  stamps: TrailStampBuffer,
  x: number,
  y: number,
  z: number,
  isReflection: boolean,
): void {
  const pts = stamps.points;
  const flags = stamps.flags;
  const legLengths = stamps.legLengths;
  const newCount = Math.min(TRAIL_STAMP_CAP, stamps.count + 1);
  for (let i = newCount - 1; i >= 1; i--) {
    const dst = i * 3;
    const src = (i - 1) * 3;
    pts[dst] = pts[src];
    pts[dst + 1] = pts[src + 1];
    pts[dst + 2] = pts[src + 2];
    flags[i] = flags[i - 1];
    // A leg belongs to the stamp behind it, so it rides the same shift.
    // The evicted slot takes its own leg with it.
    legLengths[i] = legLengths[i - 1];
  }
  if (newCount > 1) {
    const dx = x - pts[3];
    const dy = y - pts[4];
    const dz = z - pts[5];
    legLengths[1] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  pts[0] = x;
  pts[1] = y;
  pts[2] = z;
  flags[0] = isReflection ? 1 : 0;
  stamps.count = newCount;
}

/** Lays an ordinary stamp once the head has travelled far enough from the
 *  last one. Step size is one deepest-rung segment of tail, so a fully
 *  populated polyline naturally spans the resample horizon. */
export function stampTrailHeadIfMoved(
  stamps: TrailStampBuffer,
  headX: number,
  headY: number,
  headZ: number,
  tailLength: number,
): void {
  if (stamps.count === 0) {
    insertTrailStamp(stamps, headX, headY, headZ, false);
    return;
  }
  const stampStep = Math.max(0.25, tailLength / TRAIL_HIGH_CURVE_SEGMENTS);
  const pts = stamps.points;
  const dx = headX - pts[0];
  const dy = headY - pts[1];
  const dz = headZ - pts[2];
  if (dx * dx + dy * dy + dz * dz >= stampStep * stampStep) {
    insertTrailStamp(stamps, headX, headY, headZ, false);
  }
}

/** Rebuilds `scratch.centerline` + `scratch.ringDist` by resampling the
 *  stamp polyline [head, stamp0, stamp1, ...] at uniform arc-length
 *  spacing over the drawn span. This decouples the drawn rings from the
 *  raw stamps: every ring position is a continuous function of head
 *  motion, so laying or evicting a stamp never moves tail geometry (the
 *  old one-stamp-per-ring centerline popped the tail tip forward a whole
 *  segment every time the oldest stamp dropped off). Returns the drawn
 *  span — the arc length the emitted tail actually covers, which is
 *  shorter than tailLength while a young projectile accumulates path.
 *
 *  Ring `curveSegments` always lands at exactly the drawn span (the kink
 *  pin below only ever moves interior rings), so every rung agrees on
 *  where the tail ends however many rings it spends getting there.
 *
 *  Reflection kinks stay exact: the newest reflection stamp inside the
 *  horizon gets a ring pinned onto it, because the kink is the player's
 *  evidence that a shot bounced and uniform resampling alone would cut
 *  the corner. The pin slides continuously: while the kink's arc distance
 *  sits between ring slots j and j+1 (tau in [j, j+1)), ring j holds the
 *  kink and ring j-1 walks linearly back to its uniform spot from the
 *  kink duty it just finished. At every handoff the affected rings
 *  coincide, so no ring ever teleports. */
export function resampleTrailCenterline(
  scratch: TrailResampleScratch,
  headX: number,
  headY: number,
  headZ: number,
  stamps: TrailStampBuffer,
  tailLength: number,
  curveSegments: number,
): number {
  const pts = stamps.points;
  const flags = stamps.flags;
  const legLengths = stamps.legLengths;
  const count = stamps.count;
  const cum = scratch.arc;
  cum[0] = 0;
  // Stamp-to-stamp legs were measured when they were laid and can never
  // change, so the whole arc table costs one square root — the live head
  // leg — however deep the buffer is. The newest reflection kink falls out
  // of the same walk instead of needing a second pass.
  //
  // The walk also stops as soon as the table covers the authored tail
  // length. Rings only ever land inside the drawn span, which never exceeds
  // that length, so deeper stamps cannot move one and a kink out there is
  // already off the end of the tail. `tableCount` records how far cum[] was
  // actually filled; reading past it would pick up another projectile's
  // leftovers.
  let total = 0;
  let kinkDist = -1;
  let tableCount = 0;
  if (count > 0) {
    const dx = pts[0] - headX;
    const dy = pts[1] - headY;
    const dz = pts[2] - headZ;
    total = Math.sqrt(dx * dx + dy * dy + dz * dz);
    cum[1] = total;
    tableCount = 1;
    if (flags[0]) kinkDist = total;
    for (let k = 1; k < count && total < tailLength; k++) {
      total += legLengths[k];
      cum[k + 1] = total;
      tableCount = k + 1;
      if (kinkDist < 0 && flags[k]) kinkDist = total;
    }
  }

  const centerline = scratch.centerline;
  const dists = scratch.ringDist;
  centerline[0] = headX;
  centerline[1] = headY;
  centerline[2] = headZ;
  dists[0] = 0;

  let drawnSpan = Math.min(tailLength, total);
  // A kink needs an interior ring to hold it, and a single-segment tail
  // has none: head and tip are the whole thing. Rather than draw a chord
  // straight through the shield the shot just bounced off, end the tail at
  // the contact point and let it grow back out along the outgoing arc —
  // the same way it grows in from a fresh spawn.
  if (curveSegments < 2 && kinkDist >= 0 && kinkDist < drawnSpan) {
    drawnSpan = kinkDist;
  }
  if (drawnSpan < 1e-4) {
    // No usable path yet (fresh spawn, or cut back to a just-touched
    // shield) — collapse every ring onto the head. The plasma writers
    // collapse the drawn tail onto that point.
    for (let i = 1; i <= curveSegments; i++) {
      const dst = i * 3;
      centerline[dst] = headX;
      centerline[dst + 1] = headY;
      centerline[dst + 2] = headZ;
      dists[i] = 0;
    }
    return 0;
  }

  const step = drawnSpan / curveSegments;
  for (let i = 1; i <= curveSegments; i++) dists[i] = i * step;

  // Pin the newest reflection kink onto a ring (holder), and let the ring
  // that held it during the previous slot window relax home.
  if (kinkDist >= 0) {
    const tau = kinkDist / step;
    const j = Math.floor(tau);
    // Ring 0 is the live head and the tip must stay at the span end, so
    // only interior rings hold the kink; once tau passes the last segment,
    // the kink and its relax window have left the drawn tail.
    if (j >= 1 && j < curveSegments) dists[j] = kinkDist;
    if (j >= 2 && j <= curveSegments) {
      dists[j - 1] = (2 * j - tau) * step;
    }
  }

  // Single forward walk emitting ring centers at each target distance
  // (dists is monotone by construction).
  let seg = 0;
  for (let i = 1; i <= curveSegments; i++) {
    let d = dists[i];
    if (d > total) d = total;
    while (seg < tableCount - 1 && cum[seg + 1] < d) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    let t = segLen > 1e-6 ? (d - cum[seg]) / segLen : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const ao = (seg - 1) * 3;
    const ax = seg === 0 ? headX : pts[ao];
    const ay = seg === 0 ? headY : pts[ao + 1];
    const az = seg === 0 ? headZ : pts[ao + 2];
    const bo = seg * 3;
    const dst = i * 3;
    centerline[dst] = ax + (pts[bo] - ax) * t;
    centerline[dst + 1] = ay + (pts[bo + 1] - ay) * t;
    centerline[dst + 2] = az + (pts[bo + 2] - az) * t;
  }
  return drawnSpan;
}
