/**
 * Map-corner preset caption.
 *
 * Visible only while the battle bar's settings match a stock preset
 * exactly; a single hand-tuned knob drops the match and clears it (null).
 * GameCanvas owns "which preset am I on" and hands over already-formatted
 * lines, so MapPresetLabel3D stays a text painter — the same split
 * NameLabel3D uses against EntityName.
 */

import { createRenderBroadcastChannel } from './renderBroadcastChannel';

/** First line is the preset name; the rest are info lines, painted
 *  smaller beneath it. `null` hides the caption entirely. */
export type MapPresetLabelLines = readonly string[] | null;

export type MapPresetLabelTarget = {
  setMapPresetLabelLines(lines: MapPresetLabelLines): void;
};

const LINE_SEPARATOR = '\n';

function labelKey(lines: MapPresetLabelLines): string | null {
  return lines === null ? null : lines.join(LINE_SEPARATOR);
}

const channel = createRenderBroadcastChannel<MapPresetLabelLines>(
  null,
  (a, b) => labelKey(a) === labelKey(b),
);

/** Called by ThreeApp on construction; the returned function must be
 *  called from destroy(). Mirrors registerBackdropTarget — the current
 *  caption applies immediately so a renderer built mid-session (battle
 *  restart, lobby preview) shows it without waiting for a preset change. */
export function registerMapPresetLabelTarget(
  target: MapPresetLabelTarget,
): () => void {
  return channel.register((lines) => target.setMapPresetLabelLines(lines));
}

/** Reactive entry point: GameCanvas passes the matched preset's caption,
 *  or null when the settings match no stock preset. */
export function setActiveMapPresetLabel(lines: MapPresetLabelLines): void {
  channel.set(lines);
}
