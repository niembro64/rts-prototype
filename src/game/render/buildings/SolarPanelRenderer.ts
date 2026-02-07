// Solar panel building renderer

import type { BuildingRenderContext } from '../types';

/**
 * Render solar panel visual details
 */
export function renderSolarPanel(ctx: BuildingRenderContext): void {
  const { graphics, left, top, width, height, playerColor, sprayParticleTime } = ctx;

  // Panel grid - dark blue photovoltaic cells
  const cellMargin = 4;
  const cellGap = 2;
  const innerLeft = left + cellMargin;
  const innerTop = top + cellMargin;
  const innerWidth = width - cellMargin * 2;
  const innerHeight = height - cellMargin * 2;

  // Dark panel background
  graphics.fillStyle(0x0a1428, 1);
  graphics.fillRect(innerLeft, innerTop, innerWidth, innerHeight);

  // Solar cell grid (3x2 cells)
  const cellsX = 3;
  const cellsY = 2;
  const cellWidth = (innerWidth - cellGap * (cellsX + 1)) / cellsX;
  const cellHeight = (innerHeight - cellGap * (cellsY + 1)) / cellsY;

  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const cellX = innerLeft + cellGap + cx * (cellWidth + cellGap);
      const cellY = innerTop + cellGap + cy * (cellHeight + cellGap);

      // Cell base (dark blue)
      graphics.fillStyle(0x1a3050, 1);
      graphics.fillRect(cellX, cellY, cellWidth, cellHeight);

      // Cell gradient simulation (lighter at top)
      graphics.fillStyle(0x2a4060, 0.6);
      graphics.fillRect(cellX, cellY, cellWidth, cellHeight * 0.4);

      // Grid lines on each cell
      graphics.lineStyle(1, 0x102030, 0.8);
      // Horizontal line
      graphics.lineBetween(
        cellX,
        cellY + cellHeight / 2,
        cellX + cellWidth,
        cellY + cellHeight / 2
      );
      // Vertical line
      graphics.lineBetween(
        cellX + cellWidth / 2,
        cellY,
        cellX + cellWidth / 2,
        cellY + cellHeight
      );
    }
  }

  // Shimmer effect (subtle moving highlight)
  const shimmerPhase = (sprayParticleTime / 2000) % 1;
  const shimmerX =
    innerLeft + shimmerPhase * innerWidth * 1.5 - innerWidth * 0.25;
  const shimmerWidth = innerWidth * 0.3;

  if (
    shimmerX > innerLeft - shimmerWidth &&
    shimmerX < innerLeft + innerWidth
  ) {
    // Gradient shimmer (brighter in center)
    for (let i = 0; i < 5; i++) {
      const segX = shimmerX + i * (shimmerWidth / 5);
      const segW = shimmerWidth / 5;
      const alpha = i < 2.5 ? i * 0.04 : (4 - i) * 0.04;

      if (segX >= innerLeft && segX + segW <= innerLeft + innerWidth) {
        graphics.fillStyle(0xffffff, alpha);
        graphics.fillRect(segX, innerTop, segW, innerHeight);
      }
    }
  }

  // Frame corners (player color accents)
  const cornerSize = 6;
  graphics.fillStyle(playerColor, 0.9);

  // Top-left corner
  graphics.fillRect(left, top, cornerSize, 2);
  graphics.fillRect(left, top, 2, cornerSize);

  // Top-right corner
  graphics.fillRect(left + width - cornerSize, top, cornerSize, 2);
  graphics.fillRect(left + width - 2, top, 2, cornerSize);

  // Bottom-left corner
  graphics.fillRect(left, top + height - 2, cornerSize, 2);
  graphics.fillRect(left, top + height - cornerSize, 2, cornerSize);

  // Bottom-right corner
  graphics.fillRect(
    left + width - cornerSize,
    top + height - 2,
    cornerSize,
    2
  );
  graphics.fillRect(
    left + width - 2,
    top + height - cornerSize,
    2,
    cornerSize
  );

  // Small power indicator LED
  const ledX = left + width - 8;
  const ledY = top + 8;
  graphics.fillStyle(0x44ff44, 0.9);
  graphics.fillCircle(ledX, ledY, 2);
}
