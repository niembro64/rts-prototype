// Building identifiers and render/anchor classification.

export type BuildingType =
  | 'solar'
  | 'wind'
  | 'factory'
  | 'extractor'
  | 'radar'
  | 'megaBeamTower'
  | 'cannonTower';
export type BuildingRenderProfile = BuildingType | 'unknown';
export type BuildingAnchorProfile = 'constantVisualTop' | 'factoryTower' | 'collisionDepth';
