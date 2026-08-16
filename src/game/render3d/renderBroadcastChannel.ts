/**
 * One-writer / many-reader channel for preset-derived render state.
 *
 * GameCanvas writes whenever the battle bar's matched preset changes.
 * The readers are renderers that are built and torn down per battle
 * (and again for the lobby preview), so registering hands the current
 * value over immediately — an instance created mid-session never waits
 * for the next write to look right.
 *
 * Shared by the sky backdrop (presetBackdrops) and the map-corner preset
 * caption (presetMapLabel); both used to hand-roll this same Set + apply
 * + dedupe dance.
 */
type RenderBroadcastChannel<T> = {
  /** Apply the current value now, and on every later change. The
   *  returned function must be called from the reader's destroy(). */
  register(apply: (value: T) => void): () => void;
  /** Broadcast a new value. Values equal to the active one are dropped
   *  so readers never see redundant work (a texture reload, a repaint). */
  set(value: T): void;
  get(): T;
};

export function createRenderBroadcastChannel<T>(
  initial: T,
  isSameValue: (a: T, b: T) => boolean,
): RenderBroadcastChannel<T> {
  const readers = new Set<(value: T) => void>();
  let active = initial;
  return {
    register(apply) {
      readers.add(apply);
      apply(active);
      return () => {
        readers.delete(apply);
      };
    },
    set(value) {
      if (isSameValue(active, value)) return;
      active = value;
      for (const apply of readers) apply(value);
    },
    get() {
      return active;
    },
  };
}
