export type ConstructionEmitterSize = 'small' | 'large';

export type ConstructionEmitterVisualSpec = {
  defaultSize: ConstructionEmitterSize;
  /** World units per second for construction spray particles travelling
   *  linearly from emitter pylon to build target. */
  particleTravelSpeed: number;
  /** Cosmetic sphere radius for each construction spray particle. */
  particleRadius: number;
  sizes: Record<ConstructionEmitterSize, {
    towerSize: ConstructionEmitterSize;
    pylonHeight: number;
    pylonOffset: number;
    innerPylonRadius: number;
    showerRadius: number;
  }>;
};
