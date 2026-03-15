// Base types and utilities for unit renderers

export type { UnitRenderer, LegAccessor, TreadAccessor } from '@/types/render';

// Re-export constants for unit renderers
import { COLORS, getLegConfig } from '../types';
export { COLORS, getLegConfig };
export type { ColorPalette, UnitRenderContext } from '../types';
