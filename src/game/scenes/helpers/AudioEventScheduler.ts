// Audio event scheduler with smoothing.
// Spreads one-shot audio events across the snapshot interval to avoid
// bursts of simultaneous sounds. Continuous sound events (laser/forceField
// start/stop) are always played immediately.

import type { NetworkSimEvent } from '../../network/NetworkTypes';

export class AudioEventScheduler {
  private queue: { event: NetworkSimEvent; playAt: number }[] = [];
  private lastSnapshotTime = 0;
  private snapshotInterval = 100; // EMA of snapshot interval (ms)

  /**
   * Drain queued events whose scheduled time has arrived.
   * Returns nothing — calls `play` for each ready event.
   */
  drain(now: number, play: (event: NetworkSimEvent) => void): void {
    const q = this.queue;
    for (let i = q.length - 1; i >= 0; i--) {
      if (now >= q[i].playAt) {
        play(q[i].event);
        // Swap-remove for efficiency
        q[i] = q[q.length - 1];
        q.length--;
      }
    }
  }

  /**
   * Schedule audio events from a new snapshot.
   * Continuous events (laser/forceField start/stop) bypass smoothing.
   * Returns nothing — calls `play` for immediate events, queues the rest.
   */
  schedule(
    events: NetworkSimEvent[],
    now: number,
    smoothingEnabled: boolean,
    play: (event: NetworkSimEvent) => void,
  ): void {
    for (const event of events) {
      const isContinuous =
        event.type === 'laserStart' || event.type === 'laserStop' ||
        event.type === 'forceFieldStart' || event.type === 'forceFieldStop';

      if (!smoothingEnabled || isContinuous) {
        play(event);
      } else {
        this.queue.push({
          event,
          playAt: now + Math.random() * this.snapshotInterval,
        });
      }
    }
  }

  /**
   * Record a snapshot arrival. Updates the EMA-smoothed interval.
   * Returns the raw delta (ms) since last snapshot, or -1 if first.
   */
  recordSnapshot(now: number): number {
    let delta = -1;
    if (this.lastSnapshotTime > 0) {
      delta = now - this.lastSnapshotTime;
      this.snapshotInterval = 0.8 * this.snapshotInterval + 0.2 * delta;
    }
    this.lastSnapshotTime = now;
    return delta;
  }

  clear(): void {
    this.queue.length = 0;
    this.lastSnapshotTime = 0;
    this.snapshotInterval = 100;
  }
}
