// Geometry helper functions for rendering shapes

import Phaser from 'phaser';
import { getGraphicsConfig } from '../graphicsSettings';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import type { LodLevel } from '../types';
import type { ForceFieldTurretConfig } from '../../../config';
import type { ArachnidLeg } from '../ArachnidLeg';
import type { TankTreadSetup, VehicleWheelSetup } from '../Tread';
import { getUnitBlueprint } from '../../sim/blueprints';
import type { TreadConfigData, WheelConfig } from '../../sim/blueprints/types';

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
  lod: LodLevel = 'high'
): void {
  const gfxConfig = getGraphicsConfig();
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Draw tread body (dark rectangle)
  graphics.fillStyle(treadColor, 1);
  drawOrientedRect(graphics, x, y, treadLength, treadWidth, bodyRot);

  // Low LOD or low quality: just draw the rectangle, skip animated track marks
  if (lod === 'low' || !gfxConfig.treadsAnimated) {
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

/** Linearly interpolate between two hex colors by factor t (0→a, 1→b). */
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = (ar + (br - ar) * t) | 0;
  const g = (ag + (bg - ag) * t) | 0;
  const bl = (ab + (bb - ab) * t) | 0;
  return (r << 16) | (g << 8) | bl;
}

/**
 * Draw a force field grate turret — configurable shape pieces that taper
 * and cluster tighter the farther they are from the origin.
 * Pieces animate white↔blue based on force field progress.
 */
export function drawForceFieldGrate(
  graphics: Phaser.GameObjects.Graphics,
  originX: number,
  originY: number,
  turretRot: number,
  radius: number,
  config: ForceFieldTurretConfig,
  progress: number = 0,
  transitionTimeMs: number = 1000,
): void {
  const { shape, count, length, width, taper, baseOffset, thickness, reversePhase } = config;
  const grateLength = radius * length;
  const maxHalfWidth = radius * width;

  const fwdX = Math.cos(turretRot);
  const fwdY = Math.sin(turretRot);
  const perpX = -fwdY;
  const perpY = fwdX;

  const TWO_PI = Math.PI * 2;
  const SQRT3 = Math.sqrt(3);
  const time = Date.now() / 1000;
  const freq = TWO_PI / (transitionTimeMs / 1000);
  const BLUE = 0x3366ff;
  const LIGHT_BLUE = lerpColor(BLUE, COLORS.WHITE, 0.5);

  // Size-proportional spacing: gap before each piece scales with its width.
  // First two pieces keep original positions; smaller ones cluster closer.
  const wFactor = (idx: number) => 1 - (idx / (count - 1)) * taper;
  const span = 1 - baseOffset;
  const uniformStep = span / (count - 1);
  const k = uniformStep / wFactor(1);

  let pos = baseOffset;
  for (let i = 0; i < count; i++) {
    if (i > 0) pos += k * wFactor(i);
    const halfWidth = maxHalfWidth * wFactor(i);
    const dist = grateLength * pos;

    // Per-piece color: smooth continuum from white through light-blue to blue.
    // Progress drives both endpoints: low drifts white→lightBlue, high drifts white→blue.
    let color: number = COLORS.WHITE;
    if (progress > 0) {
      const phaseIdx = reversePhase ? (count - 1 - i) : i;
      const phase = phaseIdx * (TWO_PI / count);
      const sine = Math.sin(time * freq + phase);
      const t = sine * 0.5 + 0.5; // 0→1 oscillation
      const lo = lerpColor(COLORS.WHITE, LIGHT_BLUE, progress);
      const hi = lerpColor(COLORS.WHITE, BLUE, progress);
      color = lerpColor(lo, hi, t);
    }

    const cx = originX + fwdX * dist;
    const cy = originY + fwdY * dist;

    graphics.fillStyle(color, 1);

    if (shape === 'triangle') {
      const h = halfWidth * SQRT3;
      graphics.fillTriangle(
        cx - perpX * halfWidth, cy - perpY * halfWidth,
        cx + perpX * halfWidth, cy + perpY * halfWidth,
        cx - fwdX * h, cy - fwdY * h,
      );
    } else if (shape === 'square') {
      // Square centered at cx,cy with side = halfWidth * 2, aligned to turret
      _rectPoints[0].x = cx + perpX * halfWidth + fwdX * halfWidth;
      _rectPoints[0].y = cy + perpY * halfWidth + fwdY * halfWidth;
      _rectPoints[1].x = cx - perpX * halfWidth + fwdX * halfWidth;
      _rectPoints[1].y = cy - perpY * halfWidth + fwdY * halfWidth;
      _rectPoints[2].x = cx - perpX * halfWidth - fwdX * halfWidth;
      _rectPoints[2].y = cy - perpY * halfWidth - fwdY * halfWidth;
      _rectPoints[3].x = cx + perpX * halfWidth - fwdX * halfWidth;
      _rectPoints[3].y = cy + perpY * halfWidth - fwdY * halfWidth;
      graphics.fillPoints(_rectPoints, true);
    } else if (shape === 'hexagon') {
      drawPolygon(graphics, cx, cy, halfWidth, 6, turretRot);
    } else if (shape === 'circle') {
      graphics.fillCircle(cx, cy, halfWidth);
    } else {
      // 'line' — horizontal bar
      graphics.lineStyle(thickness, color, 1);
      graphics.lineBetween(
        cx - perpX * halfWidth, cy - perpY * halfWidth,
        cx + perpX * halfWidth, cy + perpY * halfWidth,
      );
    }
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

/**
 * Draw arachnid-style legs using a named style from LEG_STYLE_CONFIG.
 * Shared by BeamRenderer, ArachnidRenderer, ForceFieldRenderer, SnipeRenderer.
 */
export function drawLegs(
  graphics: Phaser.GameObjects.Graphics,
  legs: ArachnidLeg[],
  style: string,
  x: number,
  y: number,
  bodyRot: number,
  lod: LodLevel,
  dark: number,
  light: number
): void {
  const lc = LEG_STYLE_CONFIG[style];
  const halfLegs = legs.length / 2;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const side = i < halfLegs ? -1 : 1;

    const attach = leg.getAttachmentPoint(x, y, bodyRot);
    const foot = leg.getFootPosition();
    const knee = leg.getKneePosition(attach.x, attach.y, side);

    graphics.lineStyle(lc.upperThickness, dark, 1);
    graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

    graphics.lineStyle(lc.lowerThickness, dark, 1);
    graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

    if (lod === 'high') {
      graphics.fillStyle(light, 1);
      graphics.fillCircle(attach.x, attach.y, lc.hipRadius);
      graphics.fillCircle(knee.x, knee.y, lc.kneeRadius);
      graphics.fillCircle(foot.x, foot.y, lc.footRadius);
    }
  }
}

/**
 * Draw paired tank treads for a unit, looking up blueprint config by unit ID.
 * Shared by BrawlRenderer, BurstRenderer, TankRenderer.
 */
export function drawUnitTreads(
  graphics: Phaser.GameObjects.Graphics,
  unitId: string,
  x: number,
  y: number,
  r: number,
  bodyRot: number,
  treads: TankTreadSetup | undefined,
  lod: LodLevel
): void {
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  const cfg = getUnitBlueprint(unitId).locomotion.config as TreadConfigData;
  const treadOffset = r * cfg.treadOffset;
  const treadLength = r * cfg.treadLength;
  const treadWidth = r * cfg.treadWidth;

  for (const side of [-1, 1]) {
    const offsetX = -sin * treadOffset * side;
    const offsetY = cos * treadOffset * side;

    const tread = side === -1 ? treads?.leftTread : treads?.rightTread;
    const treadRotation = tread?.getRotation() ?? 0;

    drawAnimatedTread(
      graphics, x + offsetX, y + offsetY, treadLength, treadWidth, bodyRot, treadRotation,
      COLORS.DARK_GRAY, COLORS.GRAY_LIGHT, lod
    );
  }
}

/**
 * Draw 4-wheel tread setup for a unit, looking up blueprint config by unit ID.
 * Shared by ScoutRenderer, MortarRenderer.
 */
export function drawUnitWheels(
  graphics: Phaser.GameObjects.Graphics,
  unitId: string,
  x: number,
  y: number,
  r: number,
  bodyRot: number,
  wheelSetup: VehicleWheelSetup | undefined,
  lod: LodLevel
): void {
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  const cfg = getUnitBlueprint(unitId).locomotion.config as WheelConfig;
  const treadDistX = r * cfg.wheelDistX;
  const treadDistY = r * cfg.wheelDistY;
  const treadLength = r * cfg.treadLength;
  const treadWidth = r * cfg.treadWidth;

  const treadPositions = [
    { dx: treadDistX, dy: treadDistY },
    { dx: treadDistX, dy: -treadDistY },
    { dx: -treadDistX, dy: treadDistY },
    { dx: -treadDistX, dy: -treadDistY },
  ];

  for (let i = 0; i < treadPositions.length; i++) {
    const tp = treadPositions[i];
    const tx = x + cos * tp.dx - sin * tp.dy;
    const ty = y + sin * tp.dx + cos * tp.dy;
    const treadRotation = wheelSetup?.wheels[i]?.getRotation() ?? 0;
    drawAnimatedTread(
      graphics, tx, ty, treadLength, treadWidth, bodyRot, treadRotation,
      COLORS.DARK_GRAY, COLORS.GRAY_LIGHT, lod
    );
  }
}

/**
 * Draw a filled rotated oval by populating a pre-allocated point array.
 * Shared by BeamRenderer and SnipeRenderer for body/abdomen shapes.
 */
export function drawOval(
  graphics: Phaser.GameObjects.Graphics,
  points: { x: number; y: number }[],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  cos: number,
  sin: number,
  count: number
): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const lx = Math.cos(a) * ry;
    const ly = Math.sin(a) * rx;
    points[i].x = cx + cos * lx - sin * ly;
    points[i].y = cy + sin * lx + cos * ly;
  }
  graphics.fillPoints(points, true);
}
