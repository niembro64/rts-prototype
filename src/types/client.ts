export type AudioScope = 'off' | 'window' | 'padded' | 'all';
export type DriftMode = 'snap' | 'fast' | 'slow';
export type SoundCategory =
  | 'fire'
  | 'hit'
  | 'dead'
  | 'beam'
  | 'field'
  | 'music';

export type RangeType =
  | 'trackAcquire'
  | 'trackRelease'
  | 'engageAcquire'
  | 'engageRelease'
  | 'build';
export type ProjRangeType = 'collision' | 'primary' | 'secondary';
export type UnitRadiusType = 'visual' | 'shot' | 'push';
