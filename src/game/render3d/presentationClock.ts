/**
 * One switch for every frontend-only animation clock.
 *
 * The renderer keeps several independent wall clocks — the effect clock in
 * RtsScene3DRenderPhase, the barrel-spin/build-band clock in
 * UnitBarrelSpinState3D, the beam-wave uniform, the building wind clock —
 * and a paused simulation stops none of them: a "paused" battle kept its
 * smoke drifting, sprays spraying, death disassemblies flying and build
 * bands pulsing. Every one of those clocks now asks this flag, so a pause
 * freezes the WORLD while the camera, the HUD, and alarm blinks (which are
 * signals, not animation) stay live.
 *
 * Module state on purpose: BEAM_WAVE_TIME set the precedent — these are
 * process-wide presentation clocks, only one foreground scene renders at a
 * time, and the scene that owns the pause resets the flag on shutdown.
 */

let presentationAnimationPaused = false;

export function setPresentationAnimationPaused(paused: boolean): void {
  presentationAnimationPaused = paused;
}

export function isPresentationAnimationPaused(): boolean {
  return presentationAnimationPaused;
}
