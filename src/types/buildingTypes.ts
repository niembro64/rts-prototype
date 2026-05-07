// Building identifiers and render/anchor classification.

export type BuildingType = 'solar' | 'wind' | 'factory' | 'extractor' | 'megaBeamTower';
export type BuildingRenderProfile = BuildingType | 'unknown';
export type BuildingAnchorProfile = 'constantVisualTop' | 'factoryTower' | 'collisionDepth';
