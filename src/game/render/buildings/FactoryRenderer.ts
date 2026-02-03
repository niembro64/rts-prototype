// Factory building renderer

import type { BuildingRenderContext } from '../types';
import { COLORS } from '../types';
import { drawGear } from '../helpers';
import { renderSmoke } from '../effects';

/**
 * Render factory-specific elements (gears, conveyor, chimney, queue)
 */
export function renderFactory(ctx: BuildingRenderContext): void {
  const { graphics, entity, left, top, width, height, playerColor, sprayParticleTime } = ctx;

  if (!entity.factory) return;

  const factory = entity.factory;
  const x = entity.transform.x;
  const isProducing = factory.isProducing;

  // Inner machinery area (darker background)
  const machineMargin = 8;
  graphics.fillStyle(0x1a1a1a, 0.9);
  graphics.fillRect(
    left + machineMargin,
    top + machineMargin,
    width - machineMargin * 2,
    height - machineMargin * 2
  );

  // Animated gear/cogs - spin when producing
  const gearPhase = isProducing ? sprayParticleTime / 1000 : 0;
  drawGear(
    graphics,
    left + width * 0.25,
    top + height * 0.35,
    12,
    gearPhase,
    playerColor
  );
  drawGear(
    graphics,
    left + width * 0.75,
    top + height * 0.35,
    10,
    -gearPhase * 1.3,
    playerColor
  );
  drawGear(
    graphics,
    left + width * 0.5,
    top + height * 0.6,
    14,
    gearPhase * 0.8,
    playerColor
  );

  // Conveyor belt exit (bottom center)
  const conveyorWidth = width * 0.4;
  const conveyorHeight = 8;
  const conveyorX = x - conveyorWidth / 2;
  const conveyorY = top + height - conveyorHeight - 4;

  graphics.fillStyle(0x333333, 1);
  graphics.fillRect(conveyorX, conveyorY, conveyorWidth, conveyorHeight);

  // Conveyor belt lines (animated when producing)
  const beltOffset = isProducing ? (sprayParticleTime / 50) % 8 : 0;
  graphics.lineStyle(1, 0x555555, 0.8);
  for (let i = -1; i < conveyorWidth / 8 + 1; i++) {
    const lineX = conveyorX + i * 8 + beltOffset;
    if (lineX >= conveyorX && lineX <= conveyorX + conveyorWidth) {
      graphics.lineBetween(
        lineX,
        conveyorY,
        lineX,
        conveyorY + conveyorHeight
      );
    }
  }

  // Chimney/smokestack
  const chimneyWidth = 10;
  const chimneyHeight = 18;
  const chimneyX = left + width - 15;
  const chimneyY = top - chimneyHeight + 5;

  // Chimney body
  graphics.fillStyle(0x444444, 1);
  graphics.fillRect(chimneyX, chimneyY, chimneyWidth, chimneyHeight);
  graphics.lineStyle(1, 0x666666, 0.8);
  graphics.strokeRect(chimneyX, chimneyY, chimneyWidth, chimneyHeight);

  // Chimney cap
  graphics.fillStyle(0x333333, 1);
  graphics.fillRect(chimneyX - 2, chimneyY - 3, chimneyWidth + 4, 4);

  // Smoke particles when producing
  if (isProducing) {
    renderSmoke(graphics, chimneyX + chimneyWidth / 2, chimneyY - 5, sprayParticleTime);
  }

  // Status lights (corner indicators)
  const lightRadius = 3;
  const lightMargin = 6;

  // Top-left light - power status (green = ready)
  graphics.fillStyle(0x44ff44, 0.9);
  graphics.fillCircle(
    left + lightMargin,
    top + lightMargin,
    lightRadius
  );

  // Top-right light - production status (yellow when producing, dim when idle)
  const prodLightColor = isProducing ? 0xffcc00 : 0x555533;
  const prodLightAlpha = isProducing
    ? 0.9 + Math.sin(sprayParticleTime / 100) * 0.1
    : 0.5;
  graphics.fillStyle(prodLightColor, prodLightAlpha);
  graphics.fillCircle(
    left + width - lightMargin,
    top + lightMargin,
    lightRadius
  );

  // Production glow effect when building
  if (isProducing) {
    const glowIntensity = 0.15 + Math.sin(sprayParticleTime / 200) * 0.1;
    graphics.fillStyle(0xffcc00, glowIntensity);
    graphics.fillRect(left, top, width, height);
  }

  // Production progress indicator (if producing)
  if (isProducing && factory.buildQueue.length > 0) {
    const progress = factory.currentBuildProgress;
    const barWidth = width * 0.8;
    const barHeight = 6;
    const barX = x - barWidth / 2;
    const barY = top + height + 4;

    // Background
    graphics.fillStyle(COLORS.HEALTH_BAR_BG, 0.8);
    graphics.fillRect(barX, barY, barWidth, barHeight);

    // Progress fill
    graphics.fillStyle(COLORS.BUILD_BAR_FG, 0.9);
    graphics.fillRect(barX, barY, barWidth * progress, barHeight);

    // Queue indicator (small dots for queued items)
    const queueCount = Math.min(factory.buildQueue.length, 5);
    const dotSpacing = 8;
    const dotsStartX = x - ((queueCount - 1) * dotSpacing) / 2;
    for (let i = 0; i < queueCount; i++) {
      const dotX = dotsStartX + i * dotSpacing;
      const dotY = barY + barHeight + 6;
      const alpha = i === 0 ? 1 : 0.5;
      graphics.fillStyle(0xffcc00, alpha);
      graphics.fillCircle(dotX, dotY, 3);
    }
  }
}
