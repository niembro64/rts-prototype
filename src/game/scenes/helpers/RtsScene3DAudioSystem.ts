import { getAudioSmoothing } from '@/clientBarConfig';
import { audioManager } from '../../audio/AudioManager';
import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';
import { AudioEventScheduler } from './AudioEventScheduler';
import type { RtsScene3DSnapshotEventOptions } from './RtsScene3DSnapshotIntake';

type RtsScene3DAudioEventHandler = (
  event: NetworkServerSnapshotSimEvent,
) => void;

export class RtsScene3DAudioSystem {
  private readonly scheduler = new AudioEventScheduler();
  private readonly snapshotOptions: RtsScene3DSnapshotEventOptions = {
    scheduler: this.scheduler,
    smoothingEnabled: false,
    presentVisual: () => {},
    playAudio: () => {},
  };

  drainReady(
    enabled: boolean,
    play: RtsScene3DAudioEventHandler,
    now = performance.now(),
  ): void {
    if (!enabled) return;
    this.scheduler.drain(now, play);
  }

  snapshotEventOptions(
    enabled: boolean,
    playAudio: RtsScene3DAudioEventHandler,
    presentVisual: RtsScene3DAudioEventHandler,
  ): RtsScene3DSnapshotEventOptions | undefined {
    if (!enabled) return undefined;
    this.snapshotOptions.smoothingEnabled = getAudioSmoothing();
    this.snapshotOptions.playAudio = playAudio;
    this.snapshotOptions.presentVisual = presentVisual;
    return this.snapshotOptions;
  }

  clear(): void {
    this.scheduler.clear();
    audioManager.stopAllContinuousSoundsNow();
  }
}
