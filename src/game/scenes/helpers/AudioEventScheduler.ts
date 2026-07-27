// Audio event scheduler with smoothing.
// Spreads one-shot audio events across the snapshot interval to avoid
// bursts of simultaneous sounds. Continuous sound events (laser/shield
// start/stop) are always played immediately.

import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';
import {
  copySimEventInto,
  createSimEventDto,
} from '../../network/simEventDto';

type QueuedAudioEvent = {
  event: NetworkServerSnapshotSimEvent;
  playAt: number;
};

function isContinuousAudioEvent(event: NetworkServerSnapshotSimEvent): boolean {
  return event.type === 'laserStart' || event.type === 'laserStop' ||
    event.type === 'shieldStart' || event.type === 'shieldStop';
}

export class AudioEventScheduler {
  private queue: QueuedAudioEvent[] = [];
  private queuePool: QueuedAudioEvent[] = [];
  private eventPool: NetworkServerSnapshotSimEvent[] = [];
  private lastSnapshotTime = 0;
  private snapshotInterval = 100; // EMA of snapshot interval (ms)

  private acquireQueuedEvent(
    event: NetworkServerSnapshotSimEvent,
    playAt: number,
  ): QueuedAudioEvent {
    const ownedEvent = this.eventPool.pop() ?? createSimEventDto();
    copySimEventInto(event, ownedEvent);
    const queued = this.queuePool.pop();
    if (queued !== undefined) {
      queued.event = ownedEvent;
      queued.playAt = playAt;
      return queued;
    }
    return { event: ownedEvent, playAt };
  }

  private releaseQueuedEvent(queued: QueuedAudioEvent): void {
    this.eventPool.push(queued.event);
    queued.playAt = 0;
    this.queuePool.push(queued);
  }

  /**
   * Drain queued events whose scheduled time has arrived.
   * Returns nothing — calls `play` for each ready event.
   */
  drain(now: number, play: (event: NetworkServerSnapshotSimEvent) => void): void {
    const q = this.queue;
    for (let i = q.length - 1; i >= 0; i--) {
      const queued = q[i];
      if (now >= queued.playAt) {
        play(queued.event);
        const last = q.pop();
        if (last !== undefined && i < q.length) q[i] = last;
        this.releaseQueuedEvent(queued);
      }
    }
  }

  /**
   * Schedule audio events from a new snapshot.
   * Continuous events (laser/shield start/stop) bypass smoothing.
   * Returns nothing — calls `play` for immediate events, queues the rest.
   */
  schedule(
    events: NetworkServerSnapshotSimEvent[],
    now: number,
    smoothingEnabled: boolean,
    play: (event: NetworkServerSnapshotSimEvent) => void,
  ): void {
    for (const event of events) {
      if (!smoothingEnabled || isContinuousAudioEvent(event)) {
        play(event);
      } else {
        this.queue.push(this.acquireQueuedEvent(
          event,
          now + Math.random() * this.snapshotInterval,
        ));
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
    for (let i = 0; i < this.queue.length; i++) {
      this.releaseQueuedEvent(this.queue[i]);
    }
    this.queue.length = 0;
    this.lastSnapshotTime = 0;
    this.snapshotInterval = 100;
  }
}
