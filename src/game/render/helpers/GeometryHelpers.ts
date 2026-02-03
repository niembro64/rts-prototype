// Geometry helper functions for rendering shapes

import Phaser from 'phaser';
import { getGraphicsConfig } from '../graphicsSettings';
import { COLORS } from '../types';

/**
 * Draw a regular polygon (triangle, square, pentagon, hexagon, etc.)
 */
export function drawPolygon(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  radius: number,
  sides: number,
  rotation: number
): void {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i / sides) * Math.PI * 2;
    points.push({
      x: x + Math.cos(angle) * radius,
      y: y + Math.sin(angle) * radius,
    });
  }
  graphics.fillPoints(points, true);
}

/**
 * Draw an oriented rectangle (rotated around center)
 */
export function drawOrientedRect(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  length: number,
  width: number,
  rotation: number
): void {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const halfLength = length / 2;
  const halfWidth = width / 2;

  const points = [
    {
      x: x + cos * halfLength - sin * halfWidth,
      y: y + sin * halfLength + cos * halfWidth,
    },
    {
      x: x + cos * halfLength + sin * halfWidth,
      y: y + sin * halfLength - cos * halfWidth,
    },
    {
      x: x - cos * halfLength + sin * halfWidth,
      y: y - sin * halfLength - cos * halfWidth,
    },
    {
      x: x - cos * halfLength - sin * halfWidth,
      y: y - sin * halfLength + cos * halfWidth,
    },
  ];
  graphics.fillPoints(points, true);
}

/**
 * Draw a star shape
 */
export function drawStar(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  size: number,
  points: number
): void {
  const starPoints: { x: number; y: number }[] = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? size : size * 0.4;
    starPoints.push({
      x: x + Math.cos(angle) * r,
      y: y + Math.sin(angle) * r,
    });
  }
  graphics.fillPoints(starPoints, true);
}

/**
 * Draw an animated tread (track system) at the given position
 * treadRotation is the wheel rotation in radians from the Tread class
 */
export function drawAnimatedTread(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  treadLength: number,
  treadWidth: number,
  bodyRot: number,
  treadRotation: number,
  treadColor: number = COLORS.DARK_GRAY,
  lineColor: number = COLORS.GRAY_LIGHT
): void {
  const gfxConfig = getGraphicsConfig();
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Draw tread body (dark rectangle)
  graphics.fillStyle(treadColor, 1);
  drawOrientedRect(graphics, x, y, treadLength, treadWidth, bodyRot);

  // Low quality: just draw the rectangle, skip tracks
  if (!gfxConfig.treadsAnimated) {
    return;
  }

  // === TRACK DIMENSIONS ===
  // Track spacing scales slightly with tread size but has min/max bounds
  const TRACK_SPACING = Math.max(4, Math.min(6, treadLength / 8));
  const TRACK_THICKNESS = 1;
  const EDGE_INSET = 1; // Small inset from tread edges

  // Convert wheel rotation to linear track movement
  // Wheel radius is proportional to tread width (matches Tread class: ~0.35 * treadWidth)
  const wheelRadius = treadWidth * 0.35;
  const linearDistance = treadRotation * wheelRadius;

  // Normalize to track spacing for seamless looping
  const animOffset = ((linearDistance % TRACK_SPACING) + TRACK_SPACING) % TRACK_SPACING;

  // Calculate visible area for tracks
  const halfLen = treadLength / 2 - EDGE_INSET;
  const halfWid = treadWidth / 2 - EDGE_INSET;

  // Calculate number of tracks needed
  const numTracks = Math.ceil(treadLength / TRACK_SPACING) + 1;

  // Draw track lines
  graphics.lineStyle(TRACK_THICKNESS, lineColor, 1);
  for (let i = 0; i < numTracks; i++) {
    const trackPos = -halfLen + animOffset + i * TRACK_SPACING;

    // Skip tracks outside visible area
    if (trackPos < -halfLen || trackPos > halfLen) continue;

    // Calculate track line endpoints
    const lx = x + cos * trackPos;
    const ly = y + sin * trackPos;
    const perpX = -sin * halfWid;
    const perpY = cos * halfWid;

    graphics.lineBetween(lx - perpX, ly - perpY, lx + perpX, ly + perpY);
  }
}

/**
 * Render a gear/cog shape
 */
export function drawGear(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  radius: number,
  rotation: number,
  color: number
): void {
  const teeth = 6;
  const innerRadius = radius * 0.6;
  const toothHeight = radius * 0.35;

  // Gear body
  graphics.fillStyle(color, 0.7);
  graphics.fillCircle(x, y, innerRadius);

  // Teeth
  for (let i = 0; i < teeth; i++) {
    const angle = rotation + (i / teeth) * Math.PI * 2;
    const toothWidth = ((Math.PI * 2) / teeth) * 0.4;

    const toothPoints = [
      {
        x: x + Math.cos(angle - toothWidth) * innerRadius,
        y: y + Math.sin(angle - toothWidth) * innerRadius,
      },
      {
        x:
          x +
          Math.cos(angle - toothWidth * 0.6) * (innerRadius + toothHeight),
        y:
          y +
          Math.sin(angle - toothWidth * 0.6) * (innerRadius + toothHeight),
      },
      {
        x:
          x +
          Math.cos(angle + toothWidth * 0.6) * (innerRadius + toothHeight),
        y:
          y +
          Math.sin(angle + toothWidth * 0.6) * (innerRadius + toothHeight),
      },
      {
        x: x + Math.cos(angle + toothWidth) * innerRadius,
        y: y + Math.sin(angle + toothWidth) * innerRadius,
      },
    ];

    graphics.fillStyle(color, 0.7);
    graphics.fillPoints(toothPoints, true);
  }

  // Center hole
  graphics.fillStyle(0x1a1a1a, 1);
  graphics.fillCircle(x, y, radius * 0.25);

  // Outline
  graphics.lineStyle(1, 0x333333, 0.5);
  graphics.strokeCircle(x, y, innerRadius);
}
