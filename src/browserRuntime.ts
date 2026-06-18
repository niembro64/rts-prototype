export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

export function isMobileLikeBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;

  const userAgent = navigator.userAgent;
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)) {
    return true;
  }

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
}

export type BrowserRenderRuntimeProfile = {
  readonly label: 'browser-desktop' | 'browser-mobile' | 'tauri-desktop';
  readonly mobileLike: boolean;
  readonly tauri: boolean;
  readonly antialias: boolean;
  readonly precision: 'highp' | 'mediump' | 'lowp';
  readonly dynamicPixelRatio: boolean;
  readonly pixelRatioCap: number;
  readonly lodDistanceMultiplier: number;
  readonly highQualityToneMapping: boolean;
  readonly environmentLighting: boolean;
  readonly powerPreference: WebGLPowerPreference;
};

export function getBrowserRenderRuntimeProfile(): BrowserRenderRuntimeProfile {
  const tauri = isTauriRuntime();
  const mobileLike = !tauri && isMobileLikeBrowser();
  if (tauri) {
    return {
      label: 'tauri-desktop',
      mobileLike: false,
      tauri: true,
      antialias: false,
      precision: 'highp',
      dynamicPixelRatio: false,
      pixelRatioCap: 1,
      lodDistanceMultiplier: 1,
      highQualityToneMapping: false,
      environmentLighting: false,
      powerPreference: 'high-performance',
    };
  }
  if (mobileLike) {
    return {
      label: 'browser-mobile',
      mobileLike: true,
      tauri: false,
      antialias: false,
      precision: 'highp',
      dynamicPixelRatio: false,
      pixelRatioCap: 1,
      lodDistanceMultiplier: 1,
      highQualityToneMapping: false,
      environmentLighting: false,
      powerPreference: 'default',
    };
  }
  return {
    label: 'browser-desktop',
    mobileLike: false,
    tauri: false,
    antialias: true,
    precision: 'highp',
    dynamicPixelRatio: true,
    pixelRatioCap: Number.POSITIVE_INFINITY,
    lodDistanceMultiplier: 1,
    highQualityToneMapping: true,
    environmentLighting: true,
    powerPreference: 'high-performance',
  };
}
