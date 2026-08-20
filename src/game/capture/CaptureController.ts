// CaptureController — the one writer for the gameplay-capture lifecycle.
//
// Four modes, all authored in captureConfig.json, two source lanes:
//  - canvas lane (RAW): the main WebGL canvas post-render. Pixel-exact,
//    no permission prompt; in-canvas instruments are hidden through the
//    level-triggered capture gate for the duration.
//  - display lane (HUD): the browser compositor via getDisplayMedia, so the
//    output is exactly what the player sees, DOM HUD included.
//
// Fidelity is deliberately uncapped: video records every rendered canvas
// frame (captureStream with no rate argument → one captured frame per
// repaint, variable-frame-rate timestamps) at the canvas's native
// backing-store resolution. ThreeApp's capture-fidelity hold pins the
// dynamic-DPR governor at its profile maximum while a capture is live so
// resolution cannot drift (or sit degraded) mid-clip.
//
// The lifecycle is a declared FSM on StateMachine.ts. Every route back to
// idle runs the same restore side effects on the transition, so a failed
// arm, a recorder error, or the user revoking a display track can never
// leak a hidden HUD or a held fidelity pin.

import {
  createStateMachine,
  type StateMachine,
  type StateMachineChange,
} from '../state/StateMachine';
import {
  CAPTURE_CONFIG,
  getCaptureModeConfig,
  type CaptureModeConfig,
  type CaptureModeId,
} from '@/captureConfig';
import { setCaptureInstrumentsHidden } from './captureInstrumentGate';
import {
  computeVideoBitsPerSecond,
  extensionForVideoMimeType,
  isVideoRecordingSupported,
  pickSupportedVideoMimeType,
  startVideoRecording,
  type ActiveVideoRecording,
} from './mediaRecording';
import {
  acquireDisplayCaptureStream,
  getDisplayCaptureAvailability,
  grabDisplayStreamStill,
  stopStreamTracks,
} from './displayCapture';
import { buildCaptureFilename, saveCapturedBlob } from './saveCapturedBlob';
import type { ThreeApp } from '../render3d/ThreeApp';

export type CaptureLifecycleState =
  | 'idle'
  | 'arming-still'
  | 'arming-video'
  | 'recording'
  | 'finalizing';

type CaptureLifecycleEvent =
  | 'requestStill'
  | 'requestVideo'
  | 'started'
  | 'requestStop'
  | 'finish'
  | 'fail';

/** Exported for the contract test: the table IS the lifecycle. */
export function buildCaptureLifecycleMachine(
  onTransition?: (change: StateMachineChange<CaptureLifecycleState, CaptureLifecycleEvent>) => void,
): StateMachine<CaptureLifecycleState, CaptureLifecycleEvent> {
  return createStateMachine<CaptureLifecycleState, CaptureLifecycleEvent>({
    name: 'CaptureLifecycle',
    initial: 'idle',
    transitions: {
      'idle': {
        requestStill: 'arming-still',
        requestVideo: 'arming-video',
      },
      'arming-still': {
        finish: 'idle',
        fail: 'idle',
      },
      'arming-video': {
        started: 'recording',
        fail: 'idle',
      },
      'recording': {
        requestStop: 'finalizing',
        // A recorder error mid-recording still flows through finalizing so
        // the chunks captured so far are salvaged rather than dropped.
        fail: 'finalizing',
      },
      'finalizing': {
        finish: 'idle',
        fail: 'idle',
      },
    },
    onTransition,
  });
}

export type CaptureAvailability = {
  readonly supported: boolean;
  readonly reason: string | null;
};

export type CaptureUiSnapshot = {
  readonly lifecycleState: CaptureLifecycleState;
  readonly recordingModeId: CaptureModeId | null;
  readonly recordingStartedAtMs: number | null;
  readonly availability: Readonly<Record<CaptureModeId, CaptureAvailability>>;
};

type CaptureControllerDeps = {
  /** The live renderer, foreground battle preferred over the demo. */
  getApp(): ThreeApp | null;
  /** Region-capture crop target for the display lane. */
  getGameArea(): HTMLElement | null;
  /** Fired after every lifecycle change so the Vue layer can resync. */
  onChanged(): void;
};

export class CaptureController {
  private readonly machine: StateMachine<CaptureLifecycleState, CaptureLifecycleEvent>;
  private activeMode: CaptureModeConfig | null = null;
  private recording: ActiveVideoRecording | null = null;
  private activeStream: MediaStream | null = null;
  private displayTrack: MediaStreamTrack | null = null;
  private recordingStartedAtMs: number | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private heldApp: ThreeApp | null = null;

  constructor(private readonly deps: CaptureControllerDeps) {
    this.machine = buildCaptureLifecycleMachine((change) => {
      // Restore rides the edge, not the callers: any route into finalizing
      // or idle drops the instrument gate and the fidelity hold.
      if (change.to === 'finalizing' || change.to === 'idle') {
        this.releaseCaptureHold();
      }
      if (change.to === 'idle') {
        this.activeMode = null;
      }
      this.deps.onChanged();
    });
  }

  getUiSnapshot(): CaptureUiSnapshot {
    const availability = {} as Record<CaptureModeId, CaptureAvailability>;
    for (const mode of CAPTURE_CONFIG.modes) {
      availability[mode.id] = this.getAvailability(mode);
    }
    return {
      lifecycleState: this.machine.state,
      recordingModeId:
        this.machine.is('recording', 'finalizing') && this.activeMode !== null
          ? this.activeMode.id
          : null,
      recordingStartedAtMs: this.machine.is('recording') ? this.recordingStartedAtMs : null,
      availability,
    };
  }

  trigger(modeId: CaptureModeId): void {
    const mode = getCaptureModeConfig(modeId);
    if (mode.media === 'video') {
      if (this.machine.is('recording')) {
        if (this.activeMode?.id === mode.id) {
          void this.finalizeVideo('requestStop');
        }
        return;
      }
      void this.startVideo(mode);
      return;
    }
    void this.captureStill(mode);
  }

  dispose(): void {
    if (this.machine.is('recording')) {
      // Best-effort salvage on teardown: stop and save what was captured.
      void this.finalizeVideo('requestStop');
      return;
    }
    this.releaseCaptureHold();
  }

  private getAvailability(mode: CaptureModeConfig): CaptureAvailability {
    if (mode.source === 'display') {
      return getDisplayCaptureAvailability();
    }
    if (mode.media === 'video') {
      const streamable =
        typeof HTMLCanvasElement !== 'undefined' &&
        'captureStream' in HTMLCanvasElement.prototype;
      if (!streamable || !isVideoRecordingSupported()) {
        return { supported: false, reason: 'Canvas recording is not supported in this runtime' };
      }
    }
    return { supported: true, reason: null };
  }

  private applyCleanCaptureHold(app: ThreeApp): void {
    setCaptureInstrumentsHidden(true);
    app.setCaptureFidelityHold(true);
    this.heldApp = app;
  }

  private releaseCaptureHold(): void {
    setCaptureInstrumentsHidden(false);
    this.heldApp?.setCaptureFidelityHold(false);
    this.heldApp = null;
  }

  // ── stills ─────────────────────────────────────────────────────────

  private async captureStill(mode: CaptureModeConfig): Promise<void> {
    if (!this.machine.send('requestStill')) return;
    this.activeMode = mode;
    try {
      let blob: Blob;
      if (mode.source === 'canvas') {
        const app = this.deps.getApp();
        if (app === null) throw new Error('No active renderer to capture');
        this.applyCleanCaptureHold(app);
        blob = await this.captureCleanCanvasStill(app);
      } else {
        const stream = await acquireDisplayCaptureStream(this.deps.getGameArea());
        try {
          blob = await grabDisplayStreamStill(stream);
        } finally {
          stopStreamTracks(stream);
        }
      }
      saveCapturedBlob(
        blob,
        buildCaptureFilename(CAPTURE_CONFIG.filenamePrefix, mode.id, 'png'),
      );
      this.machine.send('finish');
    } catch (err) {
      console.warn(`[capture] ${mode.id} failed`, err);
      this.machine.send('fail');
    }
  }

  /** One clean frame: the instrument gate is already applied, so the NEXT
   *  rendered frame is world-only; its post-render hook reads the drawing
   *  buffer in the same task, before any resize can clear it. */
  private captureCleanCanvasStill(app: ThreeApp): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Renderer produced no frame within the capture timeout'));
      }, CAPTURE_CONFIG.stillCaptureTimeoutMs);
      app.requestCapturePostRender((canvas) => {
        canvas.toBlob((blob) => {
          clearTimeout(timeout);
          if (blob !== null) resolve(blob);
          else reject(new Error('Canvas still encode returned no blob'));
        }, CAPTURE_CONFIG.stillMimeType);
      });
    });
  }

  // ── video ──────────────────────────────────────────────────────────

  private async startVideo(mode: CaptureModeConfig): Promise<void> {
    if (!this.machine.send('requestVideo')) return;
    this.activeMode = mode;
    try {
      let stream: MediaStream;
      let width: number;
      let height: number;
      if (mode.source === 'canvas') {
        const app = this.deps.getApp();
        if (app === null) throw new Error('No active renderer to record');
        this.applyCleanCaptureHold(app);
        // No rate argument: capture every canvas repaint — one recorded
        // frame per rendered frame, at whatever rate the display runs.
        stream = app.canvas.captureStream();
        width = app.canvas.width;
        height = app.canvas.height;
      } else {
        stream = await acquireDisplayCaptureStream(this.deps.getGameArea());
        const track = stream.getVideoTracks()[0] ?? null;
        this.displayTrack = track;
        if (track !== null) {
          // Browsers surface their own "Stop sharing" control; treat it as
          // an ordinary stop so the recording is finalized and saved.
          track.addEventListener('ended', this.handleDisplayTrackEnded);
          const settings = track.getSettings();
          width = settings.width ?? 0;
          height = settings.height ?? 0;
        } else {
          width = 0;
          height = 0;
        }
        if (width <= 0 || height <= 0) {
          const area = this.deps.getGameArea();
          const ratio = window.devicePixelRatio || 1;
          width = Math.round((area?.clientWidth ?? 1920) * ratio);
          height = Math.round((area?.clientHeight ?? 1080) * ratio);
        }
      }
      this.activeStream = stream;

      const mimeType = pickSupportedVideoMimeType(CAPTURE_CONFIG.videoMimeTypePreference);
      if (mimeType === null) {
        throw new Error('No supported video encoding found');
      }
      this.recording = startVideoRecording(stream, {
        mimeType,
        videoBitsPerSecond: computeVideoBitsPerSecond(width, height),
        onError: () => {
          void this.finalizeVideo('fail');
        },
      });
      this.recordingStartedAtMs = performance.now();
      this.maxDurationTimer = setTimeout(() => {
        void this.finalizeVideo('requestStop');
      }, CAPTURE_CONFIG.maxVideoDurationSeconds * 1000);
      this.machine.send('started');
    } catch (err) {
      console.warn(`[capture] ${mode.id} failed to start`, err);
      this.cleanupVideoResources();
      this.machine.send('fail');
    }
  }

  private readonly handleDisplayTrackEnded = (): void => {
    void this.finalizeVideo('requestStop');
  };

  private async finalizeVideo(via: 'requestStop' | 'fail'): Promise<void> {
    if (!this.machine.send(via)) return;
    const mode = this.activeMode;
    const recording = this.recording;
    this.recording = null;
    try {
      const blob = recording !== null ? await recording.stop() : null;
      if (blob !== null && blob.size > 0 && mode !== null && recording !== null) {
        saveCapturedBlob(
          blob,
          buildCaptureFilename(
            CAPTURE_CONFIG.filenamePrefix,
            mode.id,
            extensionForVideoMimeType(recording.mimeType),
          ),
        );
      }
      this.machine.send('finish');
    } catch (err) {
      console.warn('[capture] recording finalize failed', err);
      this.machine.send('fail');
    } finally {
      this.cleanupVideoResources();
    }
  }

  private cleanupVideoResources(): void {
    if (this.maxDurationTimer !== null) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    if (this.displayTrack !== null) {
      this.displayTrack.removeEventListener('ended', this.handleDisplayTrackEnded);
      this.displayTrack = null;
    }
    if (this.activeStream !== null) {
      stopStreamTracks(this.activeStream);
      this.activeStream = null;
    }
    this.recordingStartedAtMs = null;
  }
}
