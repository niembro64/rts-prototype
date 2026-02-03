// Input rendering helpers for selection, line paths, and build ghosts

import type Phaser from 'phaser';
import type { Entity, WaypointType, BuildingType } from '../../sim/types';
import { getBuildingConfig } from '../../sim/buildConfigs';
import { GRID_CELL_SIZE } from '../../sim/grid';
import { magnitude } from '../../math';
import type { WorldPoint } from './PathDistribution';

// Waypoint mode colors
export const WAYPOINT_COLORS: Record<WaypointType, number> = {
  move: 0x00ff00,   // Green
  patrol: 0x0088ff, // Blue
  fight: 0xff4444,  // Red
};

// Draw selection rectangle (world space)
export function drawSelectionRect(
  graphics: Phaser.GameObjects.Graphics,
  camera: Phaser.Cameras.Scene2D.Camera,
  isDragging: boolean,
  startX: number,
  startY: number,
  endX: number,
  endY: number
): void {
  graphics.clear();

  if (!isDragging) return;

  // Already in world coordinates - use directly
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  const w = Math.abs(endX - startX);
  const h = Math.abs(endY - startY);

  // Fill
  graphics.fillStyle(0x00ff88, 0.15);
  graphics.fillRect(x, y, w, h);

  // Border (scale line width inversely with zoom so it looks consistent)
  const lineWidth = 2 / camera.zoom;
  graphics.lineStyle(lineWidth, 0x00ff88, 0.8);
  graphics.strokeRect(x, y, w, h);
}

// Draw line path preview
export function drawLinePath(
  graphics: Phaser.GameObjects.Graphics,
  camera: Phaser.Cameras.Scene2D.Camera,
  isDrawing: boolean,
  linePathPoints: WorldPoint[],
  linePathTargets: WorldPoint[],
  waypointMode: WaypointType
): void {
  graphics.clear();

  if (!isDrawing || linePathPoints.length === 0) return;

  const lineWidth = 2 / camera.zoom;
  const dotRadius = 8 / camera.zoom;
  const pathColor = WAYPOINT_COLORS[waypointMode];

  // Draw the path line
  graphics.lineStyle(lineWidth, pathColor, 0.6);
  graphics.beginPath();
  graphics.moveTo(linePathPoints[0].x, linePathPoints[0].y);
  for (let i = 1; i < linePathPoints.length; i++) {
    graphics.lineTo(linePathPoints[i].x, linePathPoints[i].y);
  }
  graphics.strokePath();

  // Draw dots at target positions
  graphics.fillStyle(pathColor, 0.9);
  for (const target of linePathTargets) {
    graphics.fillCircle(target.x, target.y, dotRadius);
  }

  // Draw outline around dots
  graphics.lineStyle(lineWidth, 0xffffff, 0.8);
  for (const target of linePathTargets) {
    graphics.strokeCircle(target.x, target.y, dotRadius);
  }
}

// Draw build ghost preview
export function drawBuildGhost(
  graphics: Phaser.GameObjects.Graphics,
  isBuildMode: boolean,
  selectedBuildingType: BuildingType | null,
  ghostX: number,
  ghostY: number,
  commander: Entity | null
): void {
  graphics.clear();

  if (!isBuildMode || !selectedBuildingType) return;

  const config = getBuildingConfig(selectedBuildingType);
  const width = config.gridWidth * GRID_CELL_SIZE;
  const height = config.gridHeight * GRID_CELL_SIZE;
  const x = ghostX;
  const y = ghostY;
  const left = x - width / 2;
  const top = y - height / 2;

  // TODO: Check if placement is valid via construction system
  const canPlace = true; // Placeholder

  // Ghost fill
  const ghostColor = canPlace ? 0x88ff88 : 0xff4444;
  graphics.fillStyle(ghostColor, 0.3);
  graphics.fillRect(left, top, width, height);

  // Ghost outline
  graphics.lineStyle(2, ghostColor, 0.8);
  graphics.strokeRect(left, top, width, height);

  // Grid lines
  graphics.lineStyle(1, ghostColor, 0.4);
  for (let gx = left; gx <= left + width; gx += GRID_CELL_SIZE) {
    graphics.lineBetween(gx, top, gx, top + height);
  }
  for (let gy = top; gy <= top + height; gy += GRID_CELL_SIZE) {
    graphics.lineBetween(left, gy, left + width, gy);
  }

  // Commander range indicator
  if (commander?.builder) {
    const cx = commander.transform.x;
    const cy = commander.transform.y;
    const range = commander.builder.buildRange;

    // Draw range circle
    graphics.lineStyle(1, 0x00ff00, 0.3);
    graphics.strokeCircle(cx, cy, range);

    // Check if building is in range
    const dx = x - cx;
    const dy = y - cy;
    const dist = magnitude(dx, dy);
    const inRange = dist <= range;

    if (!inRange) {
      // Show line to building with warning color
      graphics.lineStyle(1, 0xff4444, 0.5);
      graphics.lineBetween(cx, cy, x, y);
    }
  }
}

// Get snapped world position for building placement
export function getSnappedBuildPosition(
  worldX: number,
  worldY: number,
  buildingType: BuildingType
): { x: number; y: number; gridX: number; gridY: number } {
  const config = getBuildingConfig(buildingType);
  const gridX = Math.floor(worldX / GRID_CELL_SIZE);
  const gridY = Math.floor(worldY / GRID_CELL_SIZE);

  // Center of building
  const x = gridX * GRID_CELL_SIZE + (config.gridWidth * GRID_CELL_SIZE) / 2;
  const y = gridY * GRID_CELL_SIZE + (config.gridHeight * GRID_CELL_SIZE) / 2;

  return { x, y, gridX, gridY };
}
