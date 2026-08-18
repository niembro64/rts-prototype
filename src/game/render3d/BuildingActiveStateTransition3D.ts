// The one open/close transition every ON/OFF building shares.
//
// "Producer Buildings Are ON/OFF" in budget_design_philosophy.html makes the
// authoritative `open` flag the single input for the renderer's open/closed
// pose, so the renderer owes that flag one uniform travel time rather than a
// per-rig rate: a solar collector, a wind turbine, a metal extractor, a radar,
// a sonar, the converter and the three tech labs all take exactly as long to
// deploy as they do to fortify, and closing is the exact reverse of opening.
//
// This is deliberately a fixed DURATION rather than the per-frame alpha and
// exponential half-lives that used to live in the individual animators. A
// half-life blend has no finish line — it only ever gets close — and a raw
// per-frame alpha with no delta term folds the same building at different
// speeds on different machines. Both were live here before this module.
//
// These are decorative client-side rigs (see "Decorative locomotion rigs,
// wheel spin, tread phase, smoke, recoil enrichment, and building open/close
// animations remain client-side"), so this duration is presentation only: it
// never gates production, damage resistance, or any other simulation outcome.

/** Wall-clock seconds for one full 0↔1 ON/OFF pose transition, both directions. */
export const BUILDING_ACTIVE_STATE_TRANSITION_SEC = 2;

/** Below this distance from its target an animator stops asking for frames and
 *  the host is dequeued until its state changes again. */
export const BUILDING_RIG_IDLE_EPSILON = 0.001;

/** Distance from the target at which the progress ramp lands exactly on it, so
 *  a rig settles on its authored pose instead of approaching it forever. */
const BUILDING_ACTIVE_STATE_SNAP_EPSILON = 0.002;

/** Advance one 0↔1 open (or close) amount toward its target at the shared rate.
 *  Progress is linear in time; the shape of the motion comes from
 *  {@link easeBuildingActiveStateAmount}, applied where the pose is written. */
export function advanceBuildingActiveStateAmount(
  current: number,
  target: number,
  deltaSec: number,
): number {
  const safeDeltaSec = Number.isFinite(deltaSec) ? Math.max(0, deltaSec) : 0;
  const step = safeDeltaSec / BUILDING_ACTIVE_STATE_TRANSITION_SEC;
  const next = target > current
    ? Math.min(target, current + step)
    : Math.max(target, current - step);
  return Math.abs(target - next) < BUILDING_ACTIVE_STATE_SNAP_EPSILON ? target : next;
}

/** The shared ease every ON/OFF rig writes its pose through. Symmetric, so the
 *  closing curve is the opening curve reversed, and zero-derivative at both
 *  ends, so panels leave and arrive at their authored poses without a snap. */
export function easeBuildingActiveStateAmount(amount: number): number {
  const clamped = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 1;
  return clamped * clamped * (3 - 2 * clamped);
}
