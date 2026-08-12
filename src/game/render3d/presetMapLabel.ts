/**
 * Map-corner preset caption.
 *
 * Exact presets show their authored name; any changed gameplay/map setting
 * shows CUSTOM while retaining the current map details. GameCanvas hands over
 * already-formatted lines, so MapPresetLabel3D stays a text painter.
 */

import { createRenderBroadcastChannel } from './renderBroadcastChannel';

/** First line is the preset name or CUSTOM; the rest are current info lines.
 *  `null` remains a lifecycle escape hatch for teardown/empty state. */
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

/** Reactive entry point: GameCanvas passes the current map caption. */
export function setActiveMapPresetLabel(lines: MapPresetLabelLines): void {
  channel.set(lines);
}
