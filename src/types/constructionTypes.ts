export type ConstructionEmitterSize = 'small' | 'large';

/**
 * A host-owned build-power origin. Unit offsets are authored in body-radius
 * units, matching unit turret mounts; building offsets are world units.
 * Multiple points may be authored for large factories, but they all emit the
 * same team-colored work stream.
 */
export type WorkEmitterSpec = {
  points: ReadonlyArray<{ x: number; y: number; z: number }>;
  particleTravelSpeed: number;
  particleRadius: number;
};

export type ConstructionChannelKind =
  | 'build'
  | 'repair'
  | 'reclaim'
  | 'resurrect';

/** Host-owned work capability. Resource payment remains a coupled metal +
 * energy economy transaction; channels describe legal work, not separate
 * colored fluids or independently simulated sprays. */
export type ConstructionCapability = {
  rate: number;
  channels: ReadonlyArray<ConstructionChannelKind>;
  workEmitter: WorkEmitterSpec | null;
};

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
  }>;
};
