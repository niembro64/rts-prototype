// MediaRecorder boundary — the one seam through which video encoding is
// reached. Encoding runs inside the browser's media pipeline; TypeScript
// only starts, stops, and collects chunk blobs. No per-frame pixel access.

import { CAPTURE_CONFIG } from '@/captureConfig';

export type ActiveVideoRecording = {
  readonly mimeType: string;
  /** Stop and resolve the finished container blob. Idempotent: repeated
   *  calls return the same promise. Chunks received so far are always
   *  assembled, so an errored recording still salvages what it captured. */
  stop(): Promise<Blob>;
};

export function isVideoRecordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined';
}

export function pickSupportedVideoMimeType(
  preferences: readonly string[],
): string | null {
  if (!isVideoRecordingSupported()) return null;
  for (const mimeType of preferences) {
    try {
      if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
    } catch {
      // Third-party boundary: an engine that throws on an unknown container
      // string is treated the same as one that answers false.
    }
  }
  return null;
}

/** Bitrate scales with the live capture area so high-DPR / high-refresh
 *  recordings are not starved by a constant tuned for 1080p. */
export function computeVideoBitsPerSecond(width: number, height: number): number {
  const config = CAPTURE_CONFIG;
  const raw =
    config.videoBitsPerPixelPerFrame *
    Math.max(1, width) *
    Math.max(1, height) *
    config.videoReferenceFramesPerSecond;
  return Math.round(
    Math.min(config.maxVideoBitsPerSecond, Math.max(config.minVideoBitsPerSecond, raw)),
  );
}

export function extensionForVideoMimeType(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

export function startVideoRecording(
  stream: MediaStream,
  options: {
    mimeType: string;
    videoBitsPerSecond: number;
    onError: () => void;
  },
): ActiveVideoRecording {
  const recorder = new MediaRecorder(stream, {
    mimeType: options.mimeType,
    videoBitsPerSecond: options.videoBitsPerSecond,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onerror = () => {
    options.onError();
  };

  let stopping: Promise<Blob> | null = null;
  const stop = (): Promise<Blob> => {
    if (stopping !== null) return stopping;
    stopping = new Promise<Blob>((resolve) => {
      const finish = () => resolve(new Blob(chunks, { type: options.mimeType }));
      if (recorder.state === 'inactive') {
        finish();
        return;
      }
      recorder.onstop = finish;
      try {
        recorder.stop();
      } catch {
        finish();
      }
    });
    return stopping;
  };

  recorder.start(CAPTURE_CONFIG.recorderChunkIntervalMs);
  return { mimeType: options.mimeType, stop };
}
