// getDisplayMedia boundary — the display (with-HUD) capture lane.
//
// The composited page (WebGL canvas + minimap 2D canvas + compass canvas +
// Vue DOM) exists nowhere we can read except the browser's compositor, so
// with-HUD capture rides getDisplayMedia. Chromium extensions
// (preferCurrentTab / selfBrowserSurface / Region Capture cropTo) are used
// when present and silently absent otherwise; availability is reported
// honestly up front so unsupported runtimes disable the buttons with a
// reason instead of failing at click time.

import { CAPTURE_CONFIG } from '@/captureConfig';

type DisplayCaptureAvailability = {
  readonly supported: boolean;
  readonly reason: string | null;
};

type CropTargetConstructor = {
  fromElement(element: Element): Promise<unknown>;
};

type CroppableVideoTrack = MediaStreamTrack & {
  cropTo?(target: unknown): Promise<void>;
};

type VideoFrameCallbackCapable = HTMLVideoElement & {
  requestVideoFrameCallback?(callback: () => void): number;
};

export function getDisplayCaptureAvailability(): DisplayCaptureAvailability {
  if (typeof navigator === 'undefined') {
    return { supported: false, reason: 'Tab capture is not supported in this runtime' };
  }
  // Browsers remove navigator.mediaDevices entirely outside secure contexts,
  // so a plain-http LAN dev URL grays these buttons while localhost and the
  // deployed https game keep them. Name the actual cause in the tooltip.
  if (navigator.mediaDevices === undefined || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      return {
        supported: false,
        reason: 'HUD capture needs a secure context — open the game over https or localhost',
      };
    }
    return {
      supported: false,
      reason: 'Tab capture is not supported in this runtime',
    };
  }
  if (typeof MediaRecorder === 'undefined') {
    return { supported: false, reason: 'Video encoding is not supported in this runtime' };
  }
  return { supported: true, reason: null };
}

export function stopStreamTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export async function acquireDisplayCaptureStream(
  cropElement: HTMLElement | null,
): Promise<MediaStream> {
  const availability = getDisplayCaptureAvailability();
  if (!availability.supported) {
    throw new Error(availability.reason ?? 'Display capture unavailable');
  }
  const options = {
    video: {
      frameRate: { ideal: CAPTURE_CONFIG.displayCaptureIdealFrameRate },
    },
    audio: false,
    // Chromium-only hints past the lib.dom type; other engines ignore them.
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(
    options as Parameters<MediaDevices['getDisplayMedia']>[0],
  );

  if (cropElement !== null) {
    const cropTarget = (globalThis as { CropTarget?: CropTargetConstructor }).CropTarget;
    const track = stream.getVideoTracks()[0] as CroppableVideoTrack | undefined;
    if (cropTarget !== undefined && track !== undefined && typeof track.cropTo === 'function') {
      try {
        await track.cropTo(await cropTarget.fromElement(cropElement));
      } catch (err) {
        // Region Capture is an enhancement; the uncropped surface is still a
        // correct with-HUD capture (fullscreen makes them identical anyway).
        console.warn('[capture] region crop unavailable; capturing the full surface', err);
      }
    }
  }
  return stream;
}

/** Draw one frame of the display stream to a scratch canvas and encode it.
 *  The scratch canvas is one-shot and 2D — no extra WebGL context. */
export async function grabDisplayStreamStill(stream: MediaStream): Promise<Blob> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    await waitForVideoFrame(video);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width <= 0 || height <= 0) {
      throw new Error('Display stream produced no frame');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Unable to create still scratch canvas');
    }
    ctx.drawImage(video, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob !== null) resolve(blob);
        else reject(new Error('Still encode returned no blob'));
      }, CAPTURE_CONFIG.stillMimeType);
    });
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  const capable = video as VideoFrameCallbackCapable;
  if (typeof capable.requestVideoFrameCallback === 'function') {
    return new Promise((resolve) => capable.requestVideoFrameCallback!(() => resolve()));
  }
  // Fallback: two display frames is enough for the first composite to land.
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}
