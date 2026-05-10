import { getAudioSmoothing } from '@/clientBarConfig';
import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';
import { AudioEventScheduler } from './AudioEventScheduler';
import type { RtsScene3DSnapshotAudioOptions } from './RtsScene3DSnapshotIntake';

export type RtsScene3DAudioEventHandler = (
  event: NetworkServerSnapshotSimEvent,
) => void;

export class RtsScene3DAudioSystem {
  private readonly scheduler = new AudioEventScheduler();

  drainReady(
    enabled: boolean,
    play: RtsScene3DAudioEventHandler,
    now = performance.now(),
  ): void {
    if (!enabled) return;
    this.scheduler.drain(now, play);
  }

  snapshotAudioOptions(
    enabled: boolean,
    play: RtsScene3DAudioEventHandler,
  ): RtsScene3DSnapshotAudioOptions | undefined {
    if (!enabled) return undefined;
    return {
      scheduler: this.scheduler,
      smoothingEnabled: getAudioSmoothing(),
      play,
    };
  }

  clear(): void {
    this.scheduler.clear();
  }
}
