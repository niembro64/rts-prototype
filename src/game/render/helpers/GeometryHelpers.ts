// Geometry helper functions for rendering shapes

import Phaser from 'phaser';
import { getGraphicsConfig } from '../graphicsSettings';
import { COLORS } from '../types';

// Reusable point buffers to avoid per-call allocations
const _rectPoints = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
const _toothPoints = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
// Polygon/star point buffer - grows as needed but reuses objects
const _polyPoints: { x: number; y: number }[] = [];

function ensurePolyPoints(count: number): void {
  while (_polyPoints.length < count) {
    _polyPoints.push({ x: 0, y: 0 });
  }
}

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
  ensurePolyPoints(sides);
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i / sides) * Math.PI * 2;
    _polyPoints[i].x = x + Math.cos(angle) * radius;
    _polyPoints[i].y = y + Math.sin(angle) * radius;
  }
  // Truncate to exact count for fillPoints (ensurePolyPoints will regrow if needed)
  _polyPoints.length = sides;
  graphics.fillPoints(_polyPoints, true);
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

  _rectPoints[0].x = x + cos * halfLength - sin * halfWidth;
  _rectPoints[0].y = y + sin * halfLength + cos * halfWidth;
  _rectPoints[1].x = x + cos * halfLength + sin * halfWidth;
  _rectPoints[1].y = y + sin * halfLength - cos * halfWidth;
  _rectPoints[2].x = x - cos * halfLength + sin * halfWidth;
  _rectPoints[2].y = y - sin * halfLength - cos * halfWidth;
  _rectPoints[3].x = x - cos * halfLength - sin * halfWidth;
  _rectPoints[3].y = y - sin * halfLength + cos * halfWidth;

  graphics.fillPoints(_rectPoints, true);
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
  const count = points * 2;
  ensurePolyPoints(count);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? size : size * 0.4;
    _polyPoints[i].x = x + Math.cos(angle) * r;
    _polyPoints[i].y = y + Math.sin(angle) * r;
  }
  _polyPoints.length = count;
  graphics.fillPoints(_polyPoints, true);
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
  lineColor: number = COLORS.GRAY_LIGHT,
  skipDetail: boolean = false
): void {
  const gfxConfig = getGraphicsConfig();
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Draw tread body (dark rectangle)
  graphics.fillStyle(treadColor, 1);
  drawOrientedRect(graphics, x, y, treadLength, treadWidth, bodyRot);

  // Low quality or LOD: just draw the rectangle, skip animated track marks
  if (skipDetail || !gfxConfig.treadsAnimated) {
    return;
  }

  // === TRACK DIMENSIONS ===
  // Track spacing scales slightly with tread size but has min/max bounds
  const TRACK_SPACING = Math.max(4, Math.min(6, treadLength / 8));
  const TRACK_THICKNESS = 1;

  // Convert wheel rotation to linear track movement
  // Wheel radius is proportional to tread width (matches Tread class: ~0.35 * treadWidth)
  const wheelRadius = treadWidth * 0.35;
  const linearDistance = treadRotation * wheelRadius;

  // Normalize to track spacing for seamless looping
  const animOffset = ((linearDistance % TRACK_SPACING) + TRACK_SPACING) % TRACK_SPACING;

  // Track lines extend to full length (top/bottom) but inset from sides
  const EDGE_INSET = 1;
  const halfLen = treadLength / 2;
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

  // Teeth (reuse _toothPoints buffer)
  for (let i = 0; i < teeth; i++) {
    const angle = rotation + (i / teeth) * Math.PI * 2;
    const toothWidth = ((Math.PI * 2) / teeth) * 0.4;

    _toothPoints[0].x = x + Math.cos(angle - toothWidth) * innerRadius;
    _toothPoints[0].y = y + Math.sin(angle - toothWidth) * innerRadius;
    _toothPoints[1].x = x + Math.cos(angle - toothWidth * 0.6) * (innerRadius + toothHeight);
    _toothPoints[1].y = y + Math.sin(angle - toothWidth * 0.6) * (innerRadius + toothHeight);
    _toothPoints[2].x = x + Math.cos(angle + toothWidth * 0.6) * (innerRadius + toothHeight);
    _toothPoints[2].y = y + Math.sin(angle + toothWidth * 0.6) * (innerRadius + toothHeight);
    _toothPoints[3].x = x + Math.cos(angle + toothWidth) * innerRadius;
    _toothPoints[3].y = y + Math.sin(angle + toothWidth) * innerRadius;

    graphics.fillStyle(color, 0.7);
    graphics.fillPoints(_toothPoints, true);
  }

  // Center hole
  graphics.fillStyle(0x1a1a1a, 1);
  graphics.fillCircle(x, y, radius * 0.25);

  // Outline
  graphics.lineStyle(1, 0x333333, 0.5);
  graphics.strokeCircle(x, y, innerRadius);
}
