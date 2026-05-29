export type CameraAnchorScreen = 'cursor' | 'screen-center';

export type CameraAnchorTerrain = 'plane-2d' | 'terrain-3d' | 'terrain-3d-water';

export type CameraAnchor = {
  readonly screen: CameraAnchorScreen;
  readonly terrain: CameraAnchorTerrain;
};
