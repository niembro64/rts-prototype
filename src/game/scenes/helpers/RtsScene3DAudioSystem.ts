import { getAudioSmoothing } from '@/clientBarConfig';
import { audioManager } from '../../audio/AudioManager';
import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';
import { AudioEventScheduler } from './AudioEventScheduler';
import type { RtsScene3DSnapshotAudioOptions } from './RtsScene3DSnapshotIntake';

export type RtsScene3DAudioEventHandler = (
  event: NetworkServerSnapshotSimEvent,
) => void;

export class RtsScene3DAudioSystem {
  private readonly scheduler = new AudioEventScheduler();
  private readonly snapshotOptions: RtsScene3DSnapshotAudioOptions = {
    scheduler: this.scheduler,
    smoothingEnabled: false,
    play: () => {},
  };

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
    this.snapshotOptions.smoothingEnabled = getAudioSmoothing();
    this.snapshotOptions.play = play;
    return this.snapshotOptions;
  }

  clear(): void {
    this.scheduler.clear();
    audioManager.stopAllContinuousSoundsNow();
  }
}
