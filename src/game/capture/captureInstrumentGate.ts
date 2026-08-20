// The one level-triggered gate behind "clean" (no-HUD) capture.
//
// While hidden, the render phase suppresses every in-canvas instrument —
// health/build bars, name labels, all shared-material ground overlay
// lines/rings, waypoint markers, and lift probes — leaving only the world.
// Contact blips and the fog terrain shade deliberately stay: they are the
// player's sensor truth, not instruments, and a clean clip that revealed
// unseen enemies would misrepresent the battle.
//
// Consumers read the gate every frame (RtsScene3DRenderPhase), so restoring
// is automatic the moment the flag drops; there is no imperative show/hide
// pass that a teardown path could miss. One writer: CaptureController.

let captureInstrumentsHidden = false;

export function setCaptureInstrumentsHidden(hidden: boolean): void {
  captureInstrumentsHidden = hidden;
}

export function areCaptureInstrumentsHidden(): boolean {
  return captureInstrumentsHidden;
}
