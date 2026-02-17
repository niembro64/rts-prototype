// Standalone UI bar rendering functions used by building, unit, and other renderers

import Phaser from 'phaser';
import { COLORS } from './types';

export function renderBuildBar(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  percent: number,
): void {
  const left = x - width / 2;
  graphics.fillStyle(COLORS.HEALTH_BAR_BG, 0.8);
  graphics.fillRect(left, y, width, height);
  graphics.fillStyle(COLORS.BUILD_BAR_FG, 0.9);
  graphics.fillRect(left, y, width * percent, height);
}

export function renderHealthBar(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  percent: number,
): void {
  const left = x - width / 2;
  graphics.fillStyle(COLORS.HEALTH_BAR_BG, 0.8);
  graphics.fillRect(left, y, width, height);
  const healthColor = percent > 0.3 ? COLORS.HEALTH_BAR_FG : COLORS.HEALTH_BAR_LOW;
  graphics.fillStyle(healthColor, 0.9);
  graphics.fillRect(left, y, width * percent, height);
}
