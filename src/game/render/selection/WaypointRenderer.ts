// Waypoint and action queue rendering

import Phaser from 'phaser';
import type { Entity } from '../../sim/types';
import { ACTION_COLORS, WAYPOINT_COLORS } from '../types';

/**
 * Render action queue for a selected unit
 */
export function renderWaypoints(
  graphics: Phaser.GameObjects.Graphics,
  entity: Entity,
  camera: Phaser.Cameras.Scene2D.Camera
): void {
  if (!entity.unit || entity.unit.actions.length === 0) return;

  const { transform, unit } = entity;
  const lineWidth = 2 / camera.zoom;
  const dotRadius = 6 / camera.zoom;

  const actions = unit.actions;
  let prevX = transform.x;
  let prevY = transform.y;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const color = ACTION_COLORS[action.type];

    // Draw line from previous point to this action target
    graphics.lineStyle(lineWidth, color, 0.5);
    graphics.lineBetween(prevX, prevY, action.x, action.y);

    // Draw dot at action target
    graphics.fillStyle(color, 0.8);
    graphics.fillCircle(action.x, action.y, dotRadius);

    // Draw outline around dot
    graphics.lineStyle(lineWidth * 0.5, 0xffffff, 0.6);
    graphics.strokeCircle(action.x, action.y, dotRadius);

    // For build/repair actions, draw a square instead of circle
    if (action.type === 'build' || action.type === 'repair') {
      graphics.lineStyle(lineWidth, color, 0.8);
      graphics.strokeRect(
        action.x - dotRadius,
        action.y - dotRadius,
        dotRadius * 2,
        dotRadius * 2
      );
    }

    prevX = action.x;
    prevY = action.y;
  }

  // If patrol, draw line from last action back to first patrol action
  if (unit.patrolStartIndex !== null && actions.length > 0) {
    const lastAction = actions[actions.length - 1];
    const firstPatrolAction = actions[unit.patrolStartIndex];
    if (lastAction.type === 'patrol' && firstPatrolAction) {
      const color = ACTION_COLORS['patrol'];
      // Draw dashed-style return line (using lower alpha)
      graphics.lineStyle(lineWidth, color, 0.25);
      graphics.lineBetween(
        lastAction.x,
        lastAction.y,
        firstPatrolAction.x,
        firstPatrolAction.y
      );
    }
  }
}

/**
 * Render waypoints for a selected factory
 */
export function renderFactoryWaypoints(
  graphics: Phaser.GameObjects.Graphics,
  entity: Entity,
  camera: Phaser.Cameras.Scene2D.Camera
): void {
  if (!entity.factory || entity.factory.waypoints.length === 0) return;

  const { transform, factory } = entity;
  const lineWidth = 2 / camera.zoom;
  const dotRadius = 6 / camera.zoom;

  const waypoints = factory.waypoints;
  let prevX = transform.x;
  let prevY = transform.y;

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const color = WAYPOINT_COLORS[wp.type];

    // Draw line from previous point to this waypoint
    graphics.lineStyle(lineWidth, color, 0.5);
    graphics.lineBetween(prevX, prevY, wp.x, wp.y);

    // Draw dot at waypoint
    graphics.fillStyle(color, 0.8);
    graphics.fillCircle(wp.x, wp.y, dotRadius);

    // Draw outline around dot
    graphics.lineStyle(lineWidth * 0.5, 0xffffff, 0.6);
    graphics.strokeCircle(wp.x, wp.y, dotRadius);

    // Draw a small flag marker on last waypoint to indicate rally point
    if (i === waypoints.length - 1) {
      graphics.fillStyle(color, 0.9);
      graphics.fillTriangle(
        wp.x,
        wp.y - 10,
        wp.x + 10,
        wp.y - 5,
        wp.x,
        wp.y
      );
      graphics.lineStyle(1, color, 1);
      graphics.lineBetween(wp.x, wp.y, wp.x, wp.y - 10);
    }

    prevX = wp.x;
    prevY = wp.y;
  }

  // If last waypoint is patrol, draw line back to first patrol waypoint
  if (waypoints.length > 0) {
    const lastWp = waypoints[waypoints.length - 1];
    if (lastWp.type === 'patrol') {
      // Find first patrol waypoint
      const firstPatrolIndex = waypoints.findIndex(
        (wp) => wp.type === 'patrol'
      );
      if (firstPatrolIndex >= 0) {
        const firstPatrolWp = waypoints[firstPatrolIndex];
        const color = WAYPOINT_COLORS['patrol'];
        // Draw dashed-style return line (using lower alpha)
        graphics.lineStyle(lineWidth, color, 0.25);
        graphics.lineBetween(
          lastWp.x,
          lastWp.y,
          firstPatrolWp.x,
          firstPatrolWp.y
        );
      }
    }
  }
}
