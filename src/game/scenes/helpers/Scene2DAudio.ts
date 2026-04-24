// Per-frame audio pumping for the 2D (Phaser) scene. Extracted from
// RtsScene.ts to keep the scene file focused on lifecycle/rendering
// orchestration rather than audio plumbing.
//
// Three pieces, split so callers can time them separately:
//
//   drainScheduledAudio  — fire any audio events whose scheduled play
//                          time has passed (driven by AudioEventScheduler).
//   scheduleSnapshotAudio — feed the scheduler with the audio events
//                          that arrived in the latest snapshot. Honors
//                          the global AUDIO_SMOOTHING toggle.
//   muteOffscreenContinuousSounds — per-frame viewport check: mute
//                          beam / force-field / continuous sounds whose
//                          source entity is outside the configured
//                          audio scope, and rescale their volume with
//                          the current zoom.
//
// All three take the same "context" bundle to avoid a 7-arg signature
// repeated 3x.

import type { Viewport } from '../../Camera';
import type { EntityRenderer } from '../../render/renderEntities';
import type { ClientViewState } from '../../network/ClientViewState';
import type { AudioEventScheduler } from './AudioEventScheduler';
import type { SimEvent } from '../../sim/combat';
import { audioManager } from '../../audio/AudioManager';
import { AUDIO } from '../../../audioConfig';
import { getAudioScope, getAudioSmoothing } from '@/clientBarConfig';
import { handleSimEvent } from './DeathEffectsHandler';

export type SceneAudioContext = {
  scheduler: AudioEventScheduler;
  entityRenderer: EntityRenderer;
  audioInitialized: boolean;
  viewport: Viewport;
  zoom: number;
  clientViewState: ClientViewState;
};

/** Fire any scheduler-queued events whose time has come. */
export function drainScheduledAudio(ctx: SceneAudioContext, now: number): void {
  ctx.scheduler.drain(now, (event) => {
    handleSimEvent(
      event as SimEvent,
      ctx.entityRenderer,
      ctx.audioInitialized,
      ctx.viewport,
      ctx.zoom,
      ctx.clientViewState,
    );
  });
}

/** Queue a snapshot's audio events onto the scheduler (or fire
 *  immediately if smoothing is off). */
export function scheduleSnapshotAudio(
  ctx: SceneAudioContext,
  events: SimEvent[],
  now: number,
): void {
  ctx.scheduler.schedule(events, now, getAudioSmoothing(), (event) => {
    handleSimEvent(
      event as SimEvent,
      ctx.entityRenderer,
      ctx.audioInitialized,
      ctx.viewport,
      ctx.zoom,
      ctx.clientViewState,
    );
  });
}

/** Walk active continuous sounds (laser beams, force fields) and mute
 *  the ones whose source entity is dead or out of audio scope. Also
 *  rescales volume with zoom so distant weapons don't feel as loud. */
export function muteOffscreenContinuousSounds(ctx: SceneAudioContext): void {
  const continuousSounds = audioManager.getActiveContinuousSounds();
  if (continuousSounds.length === 0) return;

  const audioScope = getAudioScope();
  const vp = ctx.viewport;
  const zoomVolume = Math.pow(ctx.zoom, AUDIO.zoomVolumeExponent);

  for (const [soundId, sourceEntityId] of continuousSounds) {
    const entity = ctx.clientViewState.getEntity(sourceEntityId);
    if (!entity) {
      // Source gone (died / evicted) — mute the dangling stream.
      audioManager.setContinuousSoundAudible(soundId, false);
      continue;
    }
    const ex = entity.transform.x;
    const ey = entity.transform.y;
    let inScope = true;
    if (audioScope === 'off') {
      inScope = false;
    } else if (audioScope === 'window') {
      inScope = vp.contains(ex, ey);
    } else if (audioScope === 'padded') {
      const padX = vp.width * 0.5;
      const padY = vp.height * 0.5;
      inScope =
        ex >= vp.x - padX &&
        ex <= vp.right + padX &&
        ey >= vp.y - padY &&
        ey <= vp.bottom + padY;
    }
    // 'all' scope leaves inScope=true.
    audioManager.setContinuousSoundAudible(soundId, inScope);
    audioManager.updateContinuousSoundZoom(soundId, zoomVolume);
  }
}
