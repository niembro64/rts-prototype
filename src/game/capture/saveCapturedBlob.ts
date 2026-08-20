// Browser save path for captured media — the same object-URL download idiom
// the replay export uses. A Tauri-native save dialog is a later phase; the
// anchor download is the one current path.

export function saveCapturedBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function buildCaptureFilename(
  prefix: string,
  modeId: string,
  extension: string,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${modeId}-${stamp}.${extension}`;
}
