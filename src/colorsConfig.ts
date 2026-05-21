// Central visual color/material configuration. Keep authored shared colors,
// opacity, and material shine values in colors_config.json. Colors are written
// as CSS strings there so editors can show color chips; this module normalizes
// them back to the numeric values and tuples Three.js/render code expects.

import rawColorsConfig from './colors_config.json';
import type { ActionType, WaypointType } from './game/sim/types';

export type RgbTuple = readonly [number, number, number];
export type RgbaTuple = readonly [number, number, number, number];

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

function parseCssHex(value: string, fieldName: string): { r: number; g: number; b: number; a?: number } {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  if (!match) {
    throw new Error(`${fieldName} must be a CSS hex color like #44dd44 or #44dd44cc`);
  }
  const hex = match[1];
  const alphaHex = match[2];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: alphaHex === undefined ? undefined : Number.parseInt(alphaHex, 16),
  };
}

function parseCssRgba(value: string, fieldName: string): RgbaTuple {
  const hex = parseCssHex(value, fieldName);
  return [hex.r, hex.g, hex.b, hex.a ?? 255];
}

function parseCssRgb(value: string, fieldName: string, scale01: boolean): RgbTuple {
  const { r, g, b } = parseCssHex(value, fieldName);
  return scale01 ? [r / 255, g / 255, b / 255] : [r, g, b];
}

function normalizeConfigValue(key: string, value: JsonValue, fieldName: string): unknown {
  const lowerKey = key.toLowerCase();
  if (typeof value === 'string') {
    if (lowerKey.endsWith('hex')) return cssHexToNumber(value, fieldName);
    if (lowerKey.endsWith('rgb01')) return parseCssRgb(value, fieldName, true);
    if (lowerKey.endsWith('rgb') || lowerKey === 'rgb') return parseCssRgb(value, fieldName, false);
    if (lowerKey.endsWith('rgba')) return parseCssRgba(value, fieldName);
    return value;
  }
  if (Array.isArray(value)) {
    if (lowerKey.endsWith('rgb')) {
      return value.map((entry, index) => {
        if (typeof entry === 'string') return parseCssRgb(entry, `${fieldName}[${index}]`, false);
        return normalizeConfigValue('', entry, `${fieldName}[${index}]`);
      });
    }
    return value.map((entry, index) => normalizeConfigValue('', entry, `${fieldName}[${index}]`));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = normalizeConfigValue(childKey, childValue, `${fieldName}.${childKey}`);
    }
    return out;
  }
  return value;
}

function cssHexToNumber(value: string, fieldName: string): number {
  const { r, g, b } = parseCssHex(value, fieldName);
  return (r << 16) | (g << 8) | b;
}

export const COLORS = normalizeConfigValue('colors', rawColorsConfig as JsonValue, 'colors_config') as any;

export function readRgbTuple(value: readonly number[], fieldName: string): RgbTuple {
  if (value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    throw new Error(`${fieldName} must be a 3-component RGB tuple`);
  }
  return value as unknown as RgbTuple;
}

export function readRgbTupleArray(value: readonly (readonly number[])[], fieldName: string): readonly RgbTuple[] {
  return value.map((tuple, index) => readRgbTuple(tuple, `${fieldName}[${index}]`));
}

export function readRgbaTuple(value: readonly number[], fieldName: string): RgbaTuple {
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
