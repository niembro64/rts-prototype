// Central visual color/material configuration. Keep authored shared colors,
// opacity, and material shine values in colors_config.json; this file only
// provides typed helpers for modules that need tuple-shaped values.

import colorsConfig from './colors_config.json';
import type { ActionType, WaypointType } from './game/sim/types';

export const COLORS = colorsConfig;

export type RgbTuple = readonly [number, number, number];
export type RgbaTuple = readonly [number, number, number, number];

export function readRgbTuple(value: number[], fieldName: string): RgbTuple {
  if (value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    throw new Error(`${fieldName} must be a 3-component RGB tuple`);
  }
  return value as unknown as RgbTuple;
}

export function readRgbTupleArray(value: number[][], fieldName: string): readonly RgbTuple[] {
  return value.map((tuple, index) => readRgbTuple(tuple, `${fieldName}[${index}]`));
}

export function readRgbaTuple(value: number[], fieldName: string): RgbaTuple {
  if (value.length !== 4 || value.some((component) => !Number.isFinite(component))) {
    throw new Error(`${fieldName} must be a 4-component RGBA tuple`);
  }
  return value as unknown as RgbaTuple;
}

export function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export const RESOURCE_COLOR_HEX = {
  energy: COLORS.resources.energy.colorHex,
  metal: COLORS.resources.metal.colorHex,
} as const;

export const RESOURCE_COLOR_CSS = {
  energy: COLORS.resources.energy.cssColor,
  metal: COLORS.resources.metal.cssColor,
} as const;

export const WAYPOINT_COLOR_HEX: Record<WaypointType, number> = {
  move: COLORS.ui.waypointColors.move.colorHex,
  patrol: COLORS.ui.waypointColors.patrol.colorHex,
  fight: COLORS.ui.waypointColors.fight.colorHex,
};

export const WAYPOINT_COLOR_CSS: Record<WaypointType, string> = {
  move: COLORS.ui.waypointColors.move.cssColor,
  patrol: COLORS.ui.waypointColors.patrol.cssColor,
  fight: COLORS.ui.waypointColors.fight.cssColor,
};

export const ACTION_COLOR_HEX: Record<ActionType, number> = {
  move: COLORS.ui.actionColors.move.colorHex,
  patrol: COLORS.ui.actionColors.patrol.colorHex,
  fight: COLORS.ui.actionColors.fight.colorHex,
  build: COLORS.ui.actionColors.build.colorHex,
  repair: COLORS.ui.actionColors.repair.colorHex,
  reclaim: COLORS.ui.actionColors.reclaim.colorHex,
  wait: COLORS.ui.actionColors.wait.colorHex,
  attack: COLORS.ui.actionColors.attack.colorHex,
  attackGround: COLORS.ui.actionColors.attackGround.colorHex,
  guard: COLORS.ui.actionColors.guard.colorHex,
};

export const ACTION_COLOR_CSS: Record<ActionType, string> = {
  move: COLORS.ui.actionColors.move.cssColor,
  patrol: COLORS.ui.actionColors.patrol.cssColor,
  fight: COLORS.ui.actionColors.fight.cssColor,
  build: COLORS.ui.actionColors.build.cssColor,
  repair: COLORS.ui.actionColors.repair.cssColor,
  reclaim: COLORS.ui.actionColors.reclaim.cssColor,
  wait: COLORS.ui.actionColors.wait.cssColor,
  attack: COLORS.ui.actionColors.attack.cssColor,
  attackGround: COLORS.ui.actionColors.attackGround.cssColor,
  guard: COLORS.ui.actionColors.guard.cssColor,
};
