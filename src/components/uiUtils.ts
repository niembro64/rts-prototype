// Shared UI utility functions for control bars and display components.

import { PLAYER_COLORS, type PlayerId } from '../game/sim/types';

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
  if (gray) return { width: `${fillRatio * 100}%`, backgroundColor: '#b0b0b0' };

  let r: number, g: number, b: number;
  if (ratio >= 1) {
    const t = Math.min(ratio - 1, 1);
    r = Math.round(0x44 + (0x44 - 0x44) * t);
    g = Math.round(0xcc + (0x88 - 0xcc) * t);
    b = Math.round(0x44 + (0xff - 0x44) * t);
  } else if (ratio >= 0.5) {
    const t = (ratio - 0.5) / 0.5;
    r = Math.round(0xcc + (0x44 - 0xcc) * t);
    g = Math.round(0xcc + (0xcc - 0xcc) * t);
    b = Math.round(0x00 + (0x44 - 0x00) * t);
  } else {
    const t = ratio / 0.5;
    r = Math.round(0xcc + (0xcc - 0xcc) * t);
    g = Math.round(0x22 + (0xcc - 0x22) * t);
    b = Math.round(0x22 + (0x00 - 0x22) * t);
  }
  const color = `rgb(${r},${g},${b})`;
  return { width: `${fillRatio * 100}%`, backgroundColor: color };
}

export function getPlayerColor(playerId: PlayerId): string {
  const color = PLAYER_COLORS[playerId]?.primary ?? 0x888888;
  return '#' + color.toString(16).padStart(6, '0');
}

export function getPlayerName(playerId: PlayerId): string {
  return PLAYER_COLORS[playerId]?.name ?? 'Unknown';
}
