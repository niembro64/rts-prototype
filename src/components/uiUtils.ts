// Shared UI utility functions for control bars and display components.

import { COLORS, readRgbTuple } from '@/colorsConfig';
import { getPlayerPrimaryColor, type PlayerId } from '../game/sim/types';

const STAT_BAR_RGB = {
  gray: readRgbTuple(COLORS.ui.statBars.gray.rgb, 'ui.statBars.gray.rgb'),
  low: readRgbTuple(COLORS.ui.statBars.low.rgb, 'ui.statBars.low.rgb'),
  mid: readRgbTuple(COLORS.ui.statBars.mid.rgb, 'ui.statBars.mid.rgb'),
  target: readRgbTuple(COLORS.ui.statBars.target.rgb, 'ui.statBars.target.rgb'),
  over: readRgbTuple(COLORS.ui.statBars.over.rgb, 'ui.statBars.over.rgb'),
};

/** Format milliseconds as HH:MM:SS */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Format a number with maximum precision for its magnitude (4 chars max). */
export function fmt4(n: number): string {
  if (n < 10) return n.toFixed(2);
  if (n < 100) return n.toFixed(1);
  return n.toFixed(0);
}

/** Format with sign prefix (+/-) and magnitude-based precision. Uses '+' for zero. */
export function fmtSigned(n: number): string {
  const sign = n < 0 ? '-' : '+';
  return sign + fmt4(Math.abs(n));
}

/** Color for a signed value: gray when near-zero (|n| < 1), green when positive, red when negative. */
export function signedColor(n: number): string {
  if (Math.abs(n) < 1) return COLORS.ui.numericDelta.neutral;
  if (n > 0) return COLORS.ui.numericDelta.positive;
  return COLORS.ui.numericDelta.negative;
}

function mixRgb(from: readonly [number, number, number], to: readonly [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

function rgbCss(rgb: readonly [number, number, number]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/**
 * Generate a width + background-color style for a stat bar.
 * Green at target, yellow at half, red at zero, blue above target.
 */
export function statBarStyle(
  value: number,
  target = 60,
  gray = false,
): { width: string; backgroundColor: string } {
  const ratio = value / target;
  const fillRatio = Math.min(Math.max(ratio, 0), 1);
  if (gray) return { width: `${fillRatio * 100}%`, backgroundColor: rgbCss(STAT_BAR_RGB.gray) };

  let rgb: readonly [number, number, number];
  if (ratio >= 1) {
    const t = Math.min(ratio - 1, 1);
    rgb = mixRgb(STAT_BAR_RGB.target, STAT_BAR_RGB.over, t);
  } else if (ratio >= 0.5) {
    const t = (ratio - 0.5) / 0.5;
    rgb = mixRgb(STAT_BAR_RGB.mid, STAT_BAR_RGB.target, t);
  } else {
    const t = ratio / 0.5;
    rgb = mixRgb(STAT_BAR_RGB.low, STAT_BAR_RGB.mid, t);
  }
  return { width: `${fillRatio * 100}%`, backgroundColor: rgbCss(rgb) };
}

/**
 * Inverted stat bar for ms durations: green at 0, yellow at half budget, red at budget.
 * Budget defaults to 16.67ms (60fps frame budget).
 */
export function msBarStyle(
  value: number,
  budget = 1000 / 60,
): { width: string; backgroundColor: string } {
  const ratio = Math.min(Math.max(value / budget, 0), 1);
  let rgb: readonly [number, number, number];
  if (ratio <= 0.5) {
    const t = ratio / 0.5;
    rgb = mixRgb(STAT_BAR_RGB.target, STAT_BAR_RGB.mid, t);
  } else {
    const t = (ratio - 0.5) / 0.5;
    rgb = mixRgb(STAT_BAR_RGB.mid, STAT_BAR_RGB.low, t);
  }
  return { width: `${ratio * 100}%`, backgroundColor: rgbCss(rgb) };
}

export function getPlayerColor(playerId: PlayerId): string {
  return '#' + getPlayerPrimaryColor(playerId).toString(16).padStart(6, '0');
}
