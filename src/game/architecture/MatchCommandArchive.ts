/**
 * Every command the match has ever executed, kept by the coordinator so a peer
 * arriving late can replay the game from frame 0.
 *
 * This plus the `BattleHandoff` IS the "full command history and map
 * parameters" a joiner needs. There is no simulation state serializer, so
 * replay from genesis is not one option among several — it is the mechanism,
 * and it is the same one `CanonicalCheckpoint` already validates end to end:
 * a config, a list of command frames, and a state hash to check the result
 * against.
 *
 * Two decisions worth stating, because both are load-bearing:
 *
 * ONLY NON-EMPTY FRAMES ARE STORED. At 20 Hz a twenty-minute match is 24,000
 * frames but only a few thousand carry a command; the rest are empty by
 * definition and a receiver reconstructs them from `throughFrame`. Storing the
 * empties would multiply both memory and wire size by an order of magnitude
 * for no information.
 *
 * THIS IS NOT THE SCHEDULER'S RECENT-FRAME BUFFER. `LockstepFrameScheduler`
 * keeps a short tail for desync reports and is bounded to stay small. The
 * archive is the whole match and has a different lifetime, so widening that
 * buffer to serve this would have quietly changed what a desync report means.
 */

import type { LockstepCommandEnvelope } from './LockstepCommandProtocol';

export type ArchivedCommandFrame = {
  readonly frame: number;
  readonly frameSequence: number;
  readonly commands: readonly LockstepCommandEnvelope[];
};

export type MatchCommandArchiveDiagnostics = {
  /** Frames actually stored — the ones that carried a command. */
  readonly storedFrameCount: number;
  /** Highest frame the coordinator has minted. Frames up to here that are not
   *  stored were empty, which is information, not a gap. */
  readonly throughFrame: number;
  readonly commandCount: number;
  /** Rough live size, so the cost is visible in diagnostics rather than
   *  discovered as a memory problem in a long match. */
  readonly estimatedBytes: number;
};

/** What one envelope costs to keep, near enough to be useful in a diagnostics
 *  readout. Commands are small objects with a handful of numeric fields; this
 *  is deliberately generous rather than precise. */
const ESTIMATED_BYTES_PER_COMMAND = 220;
const ESTIMATED_BYTES_PER_FRAME = 48;

export class MatchCommandArchive {
  private readonly frames: ArchivedCommandFrame[] = [];
  private throughFrame = -1;
  private commandCount = 0;

  /**
   * Record a frame the coordinator just minted.
   *
   * Every frame moves `throughFrame`; only the ones carrying commands are
   * kept. Frames must arrive in order, which they do — the coordinator mints
   * them in a counting loop — so this appends rather than sorting.
   */
  append(frame: number, frameSequence: number, commands: readonly LockstepCommandEnvelope[]): void {
    if (!Number.isInteger(frame) || frame < 0) {
      throw new Error(`[match archive] frame must be a non-negative integer, got ${frame}`);
    }
    if (frame > this.throughFrame) this.throughFrame = frame;
    if (commands.length === 0) return;
    this.frames.push({ frame, frameSequence, commands: [...commands] });
    this.commandCount += commands.length;
  }

  /** The highest frame minted so far. A joiner replays up to it and then joins
   *  the live stream. */
  getThroughFrame(): number {
    return this.throughFrame;
  }

  /**
   * Non-empty frames in `[fromFrame, toFrame]`, for chunked delivery.
   *
   * The receiver needs `toFrame` alongside this to know that everything not
   * listed inside the range was empty rather than lost.
   */
  slice(fromFrame: number, toFrame: number): readonly ArchivedCommandFrame[] {
    if (toFrame < fromFrame) return [];
    const out: ArchivedCommandFrame[] = [];
    for (const entry of this.frames) {
      if (entry.frame < fromFrame) continue;
      if (entry.frame > toFrame) break;
      out.push(entry);
    }
    return out;
  }

  /** The first stored frame at or after `fromFrame`, so a sender can walk the
   *  archive in bounded chunks without scanning empty stretches. */
  nextStoredFrameAtOrAfter(fromFrame: number): number | null {
    for (const entry of this.frames) {
      if (entry.frame >= fromFrame) return entry.frame;
    }
    return null;
  }

  clear(): void {
    this.frames.length = 0;
    this.throughFrame = -1;
    this.commandCount = 0;
  }

  getDiagnostics(): MatchCommandArchiveDiagnostics {
    return {
      storedFrameCount: this.frames.length,
      throughFrame: this.throughFrame,
      commandCount: this.commandCount,
      estimatedBytes:
        this.frames.length * ESTIMATED_BYTES_PER_FRAME +
        this.commandCount * ESTIMATED_BYTES_PER_COMMAND,
    };
  }
}
