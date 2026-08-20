/**
 * The picture the lobby shows for each authored map.
 *
 * Keyed by the preset's own `backdropSlug` so one map has one asset name
 * across both generated sets — the four-layer sky panorama and this overhead
 * still — and addressed exactly the way the panoramas are, off
 * `import.meta.env.BASE_URL`, because the app is served from a sub-path on
 * the web and from the filesystem root under Tauri.
 *
 * Both sets are produced from the map itself rather than drawn by hand:
 * `scripts/captureMapPresetThumbnails.mjs` applies each preset in the real
 * app and photographs the world the terrain generator built, so a change to a
 * preset's numbers can never leave the picker advertising a map that no
 * longer exists. Re-run it after editing `battlePresets.ts`.
 */
export function getMapPresetThumbnailUrl(backdropSlug: string): string {
  return `${import.meta.env.BASE_URL}assets/map-previews/${backdropSlug}.jpg`;
}
