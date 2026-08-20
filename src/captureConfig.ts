// Capture config loader — authored knobs for the gameplay screenshot /
// video-recording system (the VID/PIC grid next to the fullscreen toggle).
//
// The four capture modes are enumerated data, not branches: the UI grid and
// the CaptureController both iterate `CAPTURE_CONFIG.modes`. Output fidelity
// is deliberately uncapped — video records every rendered canvas frame at the
// canvas's native backing-store resolution; the knobs here shape encoding
// (codec preference, bitrate-per-pixel) and safety rails (max duration),
// never a resolution or frame-rate ceiling.

import captureConfigJson from './captureConfig.json';

export type CaptureModeId = 'vid-hud' | 'vid-raw' | 'pic-hud' | 'pic-raw';
export type CaptureMediaKind = 'video' | 'still';
export type CaptureSourceLane = 'canvas' | 'display';

export type CaptureModeConfig = {
  readonly id: CaptureModeId;
  readonly media: CaptureMediaKind;
  readonly source: CaptureSourceLane;
  readonly hud: boolean;
  readonly label: string;
  readonly title: string;
};

export type CaptureConfig = {
  readonly filenamePrefix: string;
  readonly stillMimeType: string;
  readonly videoMimeTypePreference: readonly string[];
  /** Encoded bits budgeted per pixel per frame; bitrate is derived from the
   *  live capture dimensions so 4K recordings are not starved by a constant. */
  readonly videoBitsPerPixelPerFrame: number;
  /** Frame-rate term of the bitrate product. A reference, not a cap: the
   *  recording itself samples every canvas repaint. */
  readonly videoReferenceFramesPerSecond: number;
  readonly minVideoBitsPerSecond: number;
  readonly maxVideoBitsPerSecond: number;
  readonly recorderChunkIntervalMs: number;
  /** Auto-stop rail so a forgotten recording cannot eat RAM unbounded. */
  readonly maxVideoDurationSeconds: number;
  /** Ideal frame rate requested from getDisplayMedia; the browser clamps it
   *  to what the compositor actually produces. */
  readonly displayCaptureIdealFrameRate: number;
  /** How long a clean-frame still may wait for the renderer to produce a
   *  frame (a paused client renders none) before the capture fails. */
  readonly stillCaptureTimeoutMs: number;
  readonly modes: readonly CaptureModeConfig[];
};

const CAPTURE_MODE_IDS: readonly CaptureModeId[] = [
  'vid-hud',
  'vid-raw',
  'pic-hud',
  'pic-raw',
];

function assertCaptureConfig(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[captureConfig] ${message}`);
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateCaptureConfig(raw: typeof captureConfigJson): CaptureConfig {
  assertCaptureConfig(
    typeof raw.filenamePrefix === 'string' && raw.filenamePrefix.length > 0,
    'filenamePrefix must be a non-empty string',
  );
  assertCaptureConfig(
    typeof raw.stillMimeType === 'string' && raw.stillMimeType.startsWith('image/'),
    'stillMimeType must be an image/* MIME type',
  );
  assertCaptureConfig(
    Array.isArray(raw.videoMimeTypePreference) &&
      raw.videoMimeTypePreference.length > 0 &&
      raw.videoMimeTypePreference.every(
        (entry) => typeof entry === 'string' && entry.startsWith('video/'),
      ),
    'videoMimeTypePreference must be a non-empty list of video/* MIME types',
  );
  assertCaptureConfig(
    isFiniteNumber(raw.videoBitsPerPixelPerFrame) && raw.videoBitsPerPixelPerFrame > 0,
    'videoBitsPerPixelPerFrame must be a positive number',
  );
  assertCaptureConfig(
    isFiniteNumber(raw.videoReferenceFramesPerSecond) && raw.videoReferenceFramesPerSecond > 0,
    'videoReferenceFramesPerSecond must be a positive number',
  );
  assertCaptureConfig(
    isFiniteNumber(raw.minVideoBitsPerSecond) &&
      isFiniteNumber(raw.maxVideoBitsPerSecond) &&
      raw.minVideoBitsPerSecond > 0 &&
      raw.maxVideoBitsPerSecond >= raw.minVideoBitsPerSecond,
    'video bitrate bounds must be positive with max >= min',
  );
  assertCaptureConfig(
    isFiniteNumber(raw.recorderChunkIntervalMs) && raw.recorderChunkIntervalMs > 0,
    'recorderChunkIntervalMs must be a positive number',
  );
  assertCaptureConfig(
    isFiniteNumber(raw.maxVideoDurationSeconds) && raw.maxVideoDurationSeconds > 0,
    'maxVideoDurationSeconds must be a positive number',
  );
  assertCaptureConfig(
    isFiniteNumber(raw.displayCaptureIdealFrameRate) && raw.displayCaptureIdealFrameRate > 0,
    'displayCaptureIdealFrameRate must be a positive number',
  );
  assertCaptureConfig(
    isFiniteNumber(raw.stillCaptureTimeoutMs) && raw.stillCaptureTimeoutMs > 0,
    'stillCaptureTimeoutMs must be a positive number',
  );

  assertCaptureConfig(Array.isArray(raw.modes), 'modes must be a list');
  const seen = new Set<string>();
  for (const mode of raw.modes) {
    assertCaptureConfig(
      (CAPTURE_MODE_IDS as readonly string[]).includes(mode.id),
      `mode id "${mode.id}" is not a known capture mode`,
    );
    assertCaptureConfig(!seen.has(mode.id), `mode id "${mode.id}" is duplicated`);
    seen.add(mode.id);
    assertCaptureConfig(
      mode.media === 'video' || mode.media === 'still',
      `mode "${mode.id}" media must be "video" or "still"`,
    );
    assertCaptureConfig(
      mode.source === 'canvas' || mode.source === 'display',
      `mode "${mode.id}" source must be "canvas" or "display"`,
    );
    assertCaptureConfig(
      typeof mode.hud === 'boolean',
      `mode "${mode.id}" hud must be a boolean`,
    );
    assertCaptureConfig(
      mode.hud === (mode.source === 'display'),
      `mode "${mode.id}": HUD capture must ride the display lane and clean capture the canvas lane`,
    );
    assertCaptureConfig(
      typeof mode.label === 'string' && mode.label.length > 0 &&
        typeof mode.title === 'string' && mode.title.length > 0,
      `mode "${mode.id}" needs a non-empty label and title`,
    );
  }
  assertCaptureConfig(
    seen.size === CAPTURE_MODE_IDS.length,
    `modes must cover all of: ${CAPTURE_MODE_IDS.join(', ')}`,
  );

  return raw as CaptureConfig;
}

export const CAPTURE_CONFIG: CaptureConfig = validateCaptureConfig(captureConfigJson);

export function getCaptureModeConfig(id: CaptureModeId): CaptureModeConfig {
  const mode = CAPTURE_CONFIG.modes.find((entry) => entry.id === id);
  if (mode === undefined) {
    throw new Error(`[captureConfig] unknown capture mode "${id}"`);
  }
  return mode;
}
