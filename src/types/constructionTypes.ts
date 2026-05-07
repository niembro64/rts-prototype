export type ConstructionEmitterSize = 'small' | 'large';

export type ConstructionEmitterVisualSpec = {
  defaultSize: ConstructionEmitterSize;
  sizes: Record<ConstructionEmitterSize, {
    towerSize: ConstructionEmitterSize;
    pylonHeight: number;
    pylonOffset: number;
    innerPylonRadius: number;
    showerRadius: number;
  }>;
};
