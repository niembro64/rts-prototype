const MAX_CACHED_MINIMAP_COLORS = 64;
const minimapColorCache = new Map<number, string>();

export function getMinimapCssColor(color: number): string {
  const cached = minimapColorCache.get(color);
  if (cached !== undefined) return cached;
  const formatted = '#' + color.toString(16).padStart(6, '0');
  if (minimapColorCache.size >= MAX_CACHED_MINIMAP_COLORS) {
    const oldest = minimapColorCache.keys().next().value;
    if (oldest !== undefined) minimapColorCache.delete(oldest);
  }
  minimapColorCache.set(color, formatted);
  return formatted;
}
