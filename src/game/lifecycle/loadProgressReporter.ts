// Shared clamp-and-forward wrapper for load-progress callbacks.
//
// ServerBootstrap, GameServer.create and the background-battle loader
// all report startup progress through an optional async callback. The
// reporter clamps progress to [0, 1] (non-finite values become 0) and
// awaits the callback; when no callback was provided the reporter is a
// no-op that never touches the progress value.

import { clamp01 } from '../math';

export type LoadProgressCallback = (
  progress: number,
  phase: string | undefined,
) => void | Promise<void>;

export type LoadProgressReporter = (
  progress: number,
  phase?: string,
) => Promise<void>;

export function createLoadProgressReporter(
  onProgress: LoadProgressCallback | undefined,
): LoadProgressReporter {
  return async (progress, phase) => {
    if (onProgress === undefined) return;
    const clamped = Number.isFinite(progress) ? clamp01(progress) : 0;
    await onProgress(clamped, phase);
  };
}
