// Capture lifecycle contract — the FSM table and the authored capture
// config are data; this pins the transitions everything else relies on:
// one capture at a time, salvage-through-finalizing on recorder errors,
// and refusal of every undeclared event.

import { buildCaptureLifecycleMachine } from './CaptureController';
import { CAPTURE_CONFIG, getCaptureModeConfig } from '@/captureConfig';
import {
  computeVideoBitsPerSecond,
  extensionForVideoMimeType,
} from './mediaRecording';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[capture lifecycle contract] ${message}`);
  }
}

export function runCaptureControllerContractTest(): void {
  // ── config shape ───────────────────────────────────────────────────
  assertContract(
    CAPTURE_CONFIG.modes.length === 4,
    'exactly four capture modes are authored',
  );
  for (const id of ['vid-hud', 'vid-raw', 'pic-hud', 'pic-raw'] as const) {
    const mode = getCaptureModeConfig(id);
    assertContract(
      mode.hud === (mode.source === 'display'),
      `${id}: HUD capture rides the display lane, clean capture the canvas lane`,
    );
  }

  // ── still lifecycle ────────────────────────────────────────────────
  const still = buildCaptureLifecycleMachine();
  assertContract(still.state === 'idle', 'lifecycle starts idle');
  assertContract(still.send('requestStill'), 'idle accepts requestStill');
  assertContract(!still.send('requestVideo'), 'no second capture while arming a still');
  assertContract(!still.send('started'), 'a still never enters recording');
  assertContract(still.send('finish'), 'a finished still returns to idle');
  assertContract(still.state === 'idle', 'still round-trip lands in idle');

  // ── video lifecycle, ordinary stop ─────────────────────────────────
  const video = buildCaptureLifecycleMachine();
  assertContract(video.send('requestVideo'), 'idle accepts requestVideo');
  assertContract(!video.send('requestStill'), 'no still while arming video');
  assertContract(video.send('started'), 'armed video starts recording');
  assertContract(!video.send('requestVideo'), 'no second recording while recording');
  assertContract(!video.send('finish'), 'recording cannot finish without finalizing');
  assertContract(video.send('requestStop'), 'recording accepts requestStop');
  assertContract(video.state === 'finalizing', 'stop flows through finalizing');
  assertContract(video.send('finish'), 'finalizing finishes to idle');

  // ── video lifecycle, recorder error salvages via finalizing ───────
  const errored = buildCaptureLifecycleMachine();
  errored.send('requestVideo');
  errored.send('started');
  assertContract(errored.send('fail'), 'a recorder error is a declared edge');
  assertContract(
    errored.state === 'finalizing',
    'a recorder error still flows through finalizing so chunks are salvaged',
  );
  assertContract(errored.send('fail'), 'finalizing may fail to idle');
  assertContract(errored.state === 'idle', 'errored recording lands in idle');

  // ── denied display-capture permission aborts the arm ──────────────
  const denied = buildCaptureLifecycleMachine();
  denied.send('requestVideo');
  assertContract(denied.send('fail'), 'a denied arm is a declared edge');
  assertContract(denied.state === 'idle', 'a denied arm returns to idle');

  // ── encoding knobs ─────────────────────────────────────────────────
  assertContract(
    computeVideoBitsPerSecond(16, 16) === CAPTURE_CONFIG.minVideoBitsPerSecond,
    'tiny captures clamp to the bitrate floor',
  );
  assertContract(
    computeVideoBitsPerSecond(100000, 100000) === CAPTURE_CONFIG.maxVideoBitsPerSecond,
    'huge captures clamp to the bitrate ceiling',
  );
  const at1080 = computeVideoBitsPerSecond(1920, 1080);
  assertContract(
    at1080 >= CAPTURE_CONFIG.minVideoBitsPerSecond &&
      at1080 <= CAPTURE_CONFIG.maxVideoBitsPerSecond,
    '1080p bitrate stays inside the authored bounds',
  );
  assertContract(
    extensionForVideoMimeType('video/mp4') === 'mp4' &&
      extensionForVideoMimeType('video/webm;codecs=vp9') === 'webm',
    'file extension follows the negotiated container',
  );
}
