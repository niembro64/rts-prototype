import type { PlayerId } from './sim';

// Per-tile state: one flag height per team (sparse — only non-zero entries)
export type TileState = Map<PlayerId, number>;

// Network format: tile with per-team heights
export type NetworkCaptureTile = {
  cx: number;
  cy: number;
  heights: Record<number, number>;
};
