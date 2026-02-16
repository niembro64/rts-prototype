// Color palette utilities for unit and building rendering

import { PLAYER_COLORS } from '../../sim/types';
import type { ColorPalette } from '../types';

/**
 * Get player color from player ID
 */
export function getPlayerColor(playerId: number | undefined): number {
  if (playerId === undefined) return 0x888888;
  return PLAYER_COLORS[playerId]?.primary ?? 0x888888;
}

/**
 * Get light variant of a color (blend toward white)
 */
export function getColorLight(baseColor: number): number {
  const r = (baseColor >> 16) & 0xff;
  const g = (baseColor >> 8) & 0xff;
  const b = baseColor & 0xff;
  const blend = 0.45;
  return (
    (Math.round(r + (240 - r) * blend) << 16) |
    (Math.round(g + (240 - g) * blend) << 8) |
    Math.round(b + (240 - b) * blend)
  );
}

/**
 * Get dark variant of a color (blend toward black)
 */
export function getColorDark(baseColor: number): number {
  const r = (baseColor >> 16) & 0xff;
  const g = (baseColor >> 8) & 0xff;
  const b = baseColor & 0xff;
  const blend = 0.45;
  return (
    (Math.round(r * (1 - blend)) << 16) |
    (Math.round(g * (1 - blend)) << 8) |
    Math.round(b * (1 - blend))
  );
}

/**
 * Tint a color toward white (amount > 0) or black (amount < 0).
 * amount in range [-1, 1]. Typical subtle tint: ±0.15
 */
export function tintColor(color: number, amount: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const t = Math.abs(amount);
  if (amount > 0) {
    // Blend toward white
    return (
      (Math.round(r + (255 - r) * t) << 16) |
      (Math.round(g + (255 - g) * t) << 8) |
      Math.round(b + (255 - b) * t)
    );
  }
  // Blend toward black
  return (
    (Math.round(r * (1 - t)) << 16) |
    (Math.round(g * (1 - t)) << 8) |
    Math.round(b * (1 - t))
  );
}

/**
 * Get projectile color (bright version of base color for visibility)
 */
export function getProjectileColor(baseColor: number): number {
  return getColorLight(baseColor);
}

/**
 * Create a full color palette from a player ID
 */
export function createColorPalette(playerId: number | undefined): ColorPalette {
  const base = getPlayerColor(playerId);
  return {
    base,
    light: getColorLight(base),
    dark: getColorDark(base),
  };
}
