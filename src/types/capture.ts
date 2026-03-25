import type { PlayerId } from './sim';

export type TileState = {
  teamId: PlayerId | null;
  flagHeight: number;
};

export type NetworkCaptureTile = {
  cx: number;
  cy: number;
  teamId: number;
  flagHeight: number;
};
