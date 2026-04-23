// Escape-key behavior shared by both renderers. The convention
// (mirrored across every RTS that supports modes): Escape first
// cancels the most recently entered mode; only if no mode is
// active does it fall through to clearing the player's selection.
// 2D has two modes (build + D-gun), 3D currently has only build,
// but the call site passes any number of cancel callbacks.

import type { CommandQueue } from '../../sim/commands';

export type ModeCancel = {
  /** Is this mode currently active? */
  isActive: () => boolean;
  /** Cancel it. Called at most once per Escape press. */
  cancel: () => void;
};

/** Run the Escape convention against a list of mode-cancel callbacks.
 *  Returns the action taken so callers can log / telemetry-track.
 *
 *  Priority: the first `isActive()` mode wins. If none are active,
 *  enqueue a `clearSelection` command. */
export function handleEscape(
  modes: readonly ModeCancel[],
  commandQueue: CommandQueue,
  tick: number,
): 'mode-cancelled' | 'selection-cleared' {
  for (const mode of modes) {
    if (mode.isActive()) {
      mode.cancel();
      return 'mode-cancelled';
    }
  }
  commandQueue.enqueue({ type: 'clearSelection', tick });
  return 'selection-cleared';
}
