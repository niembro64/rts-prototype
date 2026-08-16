// Pure camera-input and transition math, independent of Three.js and the DOM.

import type {
  CameraWheelInputMode,
  CameraZoomDistanceAggregation,
} from '../../types/camera';

const WHEEL_PIXELS_PER_TICK = 100;
const WHEEL_LINES_PER_TICK = 3;
const BAR_CARDINAL_LOCK_WIDTH = 0.2;
export const DEFAULT_ZOOM_TRAVEL_CLAMP_FRACTION = 0.5;
const LEGACY_NOTCHED_WHEEL_DELTA_UNIT = 120;

/** Sample count for the average-of-shortest family; 1 for every other mode
 * (making it degenerate to `min`). */
export function zoomAggregationShortestCount(
  aggregation: CameraZoomDistanceAggregation,
): number {
  switch (aggregation) {
    case 'average-of-shortest-3': return 3;
    case 'average-of-shortest-5': return 5;
    case 'average-of-shortest-8': return 8;
    default: return 1;
  }
}

/** Mean of the `k` smallest of the first `count` distances — the robust
 * near-surface depth estimator behind `average-of-shortest-N`. `min` is
 * hijacked by any single spurious near sample, while the full mean of a
 * bimodal silhouette neighborhood lands mid-air between peak and valley;
 * averaging only the near tail keeps the estimate on the near surface with
 * no single sample dictating it. Non-finite entries never contribute.
 * `outFlags` doubles as the selection state and the result: entries must
 * arrive 0 over the first `count` indices, and contributing indices are
 * marked 1. Allocation-free: k·count comparisons on the caller's buffers. */
export function averageOfShortestDistances(
  distances: ArrayLike<number>,
  count: number,
  k: number,
  outFlags: Uint8Array,
): number {
  const usable = Math.max(0, Math.min(count, distances.length, outFlags.length));
  if (usable === 0) return Number.NaN;
  const take = Math.max(1, Math.min(usable, Math.floor(k)));
  let sum = 0;
  let taken = 0;
  for (let pass = 0; pass < take; pass++) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < usable; i++) {
      if (outFlags[i] === 1) continue;
      const distance = distances[i];
      if (!Number.isFinite(distance)) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    outFlags[bestIndex] = 1;
    sum += bestDistance;
    taken += 1;
  }
  return taken > 0 ? sum / taken : Number.NaN;
}

/** Classify a wheel event as a notched-wheel click or a continuous-device
 * stream (trackpad two-finger scroll, Magic Mouse surface, free-spin wheel).
 *
 * Line/page delta modes only come from real wheels. In pixel mode the only
 * portable signal is the legacy `wheelDelta`, which WebKit/Blink emit in
 * exact multiples of 120 for notched clicks and in arbitrary values for
 * touch streams. Browsers without the legacy field (Firefox) report real
 * wheels in line mode, so their pixel events are continuous streams too. */
export function barCameraWheelEventIsNotched(
  deltaMode: number,
  legacyWheelDelta: number | undefined,
): boolean {
  if (deltaMode !== 0) return true;
  if (legacyWheelDelta === undefined || !Number.isFinite(legacyWheelDelta)) {
    return false;
  }
  if (legacyWheelDelta === 0) return false;
  return legacyWheelDelta % LEGACY_NOTCHED_WHEEL_DELTA_UNIT === 0;
}

/** Convert a DOM wheel delta into the platform-independent wheel unit used by
 * BAR/Recoil. Exported so the browser-input edge cases have a small, pure
 * contract surface independent of Three.js and the DOM event dispatcher.
 *
 * `notchedDevice` matters only to `bar-discrete-event`: a notched click is
 * exactly one signed BAR unit regardless of OS-accelerated magnitude, while a
 * continuous stream keeps fractional pixel conversion — a trackpad fling is
 * dozens of small events and must not become dozens of full notches. */
export function barCameraWheelTicks(
  delta: number,
  deltaMode: number,
  inputMode: CameraWheelInputMode = 'dom-continuous-delta',
  notchedDevice = true,
): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  // SDL hands BAR one signed wheel unit for an ordinary notched-wheel event.
  // Browser pixel deltas can grow when the OS accelerates rapid scrolling;
  // magnitude must not turn one physical click into several controller units.
  if (inputMode === 'bar-discrete-event' && notchedDevice) return Math.sign(delta);
  // WheelEvent.DOM_DELTA_LINE/PAGE are specified as 1 and 2. Use the numeric
  // values so this pure helper is also safe in Node-based contract tests.
  if (deltaMode === 1) return delta / WHEEL_LINES_PER_TICK;
  if (deltaMode === 2) return delta;
  // DOM_DELTA_PIXEL is zero. Unknown modes are safest treated as pixels too.
  return delta / WHEEL_PIXELS_PER_TICK;
}

export type CameraMouseDragMode = 'orbit' | 'pan' | 'height-pan';

/** Modifier contract for held middle-mouse camera control. Alt deliberately
 * wins when both modifiers are held. */
export function cameraMouseDragModeForModifiers(
  altKey: boolean,
  ctrlKey: boolean,
): CameraMouseDragMode {
  if (altKey) return 'orbit';
  return ctrlKey ? 'height-pan' : 'pan';
}

/** Recoil SpringController's default relative zoom law. It is intentionally
 * asymmetric: one notch in is x0.825 and one notch out is x1.175. */
export function barCameraRelativeZoomFactor(
  signedTicks: number,
  stepFraction: number,
): number {
  if (!Number.isFinite(signedTicks) || signedTicks === 0) return 1;
  const fraction = Math.max(0, Number.isFinite(stepFraction) ? stepFraction : 0);
  return Math.max(1e-6, 1 + signedTicks * fraction);
}

/** Bound an anchor-relative zoom factor so the eye's travel cannot exceed
 * `clampFraction` of the current orbit distance.
 *
 * Anchor-relative zoom moves the eye by |1 − factor| · anchorDistance, and
 * anchorDistance is a raycast depth that is discontinuous at terrain
 * silhouettes: the pixel on a peak and the pixel beside it can differ by two
 * orders of magnitude, and a fallback hit can be quasi-infinite. Clamping the
 * factor — never the anchor point — keeps the gesture aimed at the same
 * world point while making per-tick motion proportional to the camera's own
 * scale. Ordinary zooms (anchorDistance ≈ orbitDistance) are unaffected. */
export function barCameraTravelClampedZoomFactor(
  wantFactor: number,
  anchorDistance: number,
  orbitDistance: number,
  clampFraction: number,
): number {
  if (!Number.isFinite(wantFactor) || wantFactor <= 0) return 1;
  if (
    !Number.isFinite(anchorDistance)
    || !(anchorDistance > 0)
    || !Number.isFinite(orbitDistance)
    || !(orbitDistance > 0)
  ) {
    return wantFactor;
  }
  // Zero or negative disables the clamp entirely.
  const fraction = Number.isFinite(clampFraction)
    ? clampFraction
    : DEFAULT_ZOOM_TRAVEL_CLAMP_FRACTION;
  if (!(fraction > 0)) return wantFactor;
  const maxFactorDelta = (fraction * orbitDistance) / anchorDistance;
  if (wantFactor < 1) {
    return Math.max(wantFactor, Math.max(1e-6, 1 - maxFactorDelta));
  }
  return Math.min(wantFactor, 1 + maxFactorDelta);
}

/** Ctrl-height pan and persistent terrain clearance both become the same
 * ordinary focus-height offset. Explicit zoom-in scales that offset toward
 * the terrain together with orbit distance; zoom-out leaves it unchanged. */
export function barCameraZoomElevationOffset(
  elevationOffset: number,
  oldDistance: number,
  nextDistance: number,
  zoomingIn: boolean,
): number {
  if (!Number.isFinite(elevationOffset)) return 0;
  if (!zoomingIn || !(oldDistance > 0) || !Number.isFinite(nextDistance)) {
    return elevationOffset;
  }
  return elevationOffset * Math.min(1, Math.max(0, nextDistance / oldDistance));
}

/** Recoil's GetRotationWithCardinalLock, translated literally. The raw yaw is
 * retained separately; only the rendered/controller yaw passes through this
 * dead-zone mapping. */
export function barCameraLockedYaw(rawYaw: number): number {
  if (!Number.isFinite(rawYaw)) return 0;
  const quarterTurn = Math.PI * 0.5;
  const scaled = rawYaw / quarterTurn;
  const moved = Math.abs(scaled) - BAR_CARDINAL_LOCK_WIDTH * 0.5;
  const whole = Math.trunc(moved);
  const fraction = moved - whole;
  const b = 1 / (1 - BAR_CARDINAL_LOCK_WIDTH);
  const c = 1 - b;
  const eased = fraction > BAR_CARDINAL_LOCK_WIDTH ? fraction * b + c : 0;
  const sign = scaled < 0 || Object.is(scaled, -0) ? -1 : 1;
  return sign * (whole + eased) * quarterTurn;
}

/** Resolve BAR-mode yaw while keeping its cardinal dead zones independently
 * configurable from the rest of the SpringController movement contract. */
export function barCameraYaw(rawYaw: number, cardinalLockEnabled: boolean): number {
  if (!Number.isFinite(rawYaw)) return 0;
  return cardinalLockEnabled ? barCameraLockedYaw(rawYaw) : rawYaw;
}

/** Permanent terrain response requested for Budget Annihilation. Returning
 * only the missing vertical clearance makes the resolved pose canonical: the
 * caller adds it to rendered and destination focus state exactly once. */
export function persistentTerrainRaise(
  eyeY: number,
  terrainY: number,
  clearance: number,
): number {
  if (!Number.isFinite(eyeY) || !Number.isFinite(terrainY)) return 0;
  return Math.max(0, terrainY + Math.max(0, clearance) - eyeY);
}

export type BarSpringDamperStep = {
  value: number;
  velocity: number;
};

/** Literal scalar port of Recoil SpringDampers.cpp. `halfLifeSeconds` and
 * `dtSeconds` use seconds instead of the engine's milliseconds; their ratio,
 * and therefore the result, is identical. Pass `out` on hot paths. */
export function barSpringDamperStep(
  value: number,
  velocity: number,
  goal: number,
  halfLifeSeconds: number,
  dtSeconds: number,
  out: BarSpringDamperStep = { value: 0, velocity: 0 },
): BarSpringDamperStep {
  const halfLife = Math.max(0, halfLifeSeconds);
  const dt = Math.max(0, dtSeconds);
  if (halfLife <= 0 || dt <= 0) {
    out.value = halfLife <= 0 ? goal : value;
    out.velocity = halfLife <= 0 ? 0 : velocity;
    return out;
  }
  // Recoil: damping = (4*ln(2)/(halflife+eps))/2. Scale its 1e-5ms
  // epsilon into seconds so the browser port follows the same edge behavior.
  const damping = (2 * Math.LN2) / (halfLife + 1e-8);
  const x = damping * dt;
  const eydt = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const j0 = value - goal;
  const j1 = velocity + j0 * damping;
  out.value = eydt * (j0 + j1 * dt) + goal;
  out.velocity = eydt * (velocity - j1 * damping * dt);
  return out;
}
