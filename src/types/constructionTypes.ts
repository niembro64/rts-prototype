import type {
  TurretAngularActuator,
  TurretStationArticulation,
} from './blueprintSchema.generated';

export type WorkStationAttachment =
  | { kind: 'host' }
  | {
      kind: 'botArm';
      arm: 'leftArm' | 'rightArm';
      socketOffset: { x: number; y: number; z: number };
    };

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
  /** Named parent piece for QueryWork. Host is a rigid local socket; botArm
   * follows the same authoritative biped arm geometry as held weapons. */
  attachment: WorkStationAttachment;
  /** Null for fixed emitters with no moving mechanism. */
  angularActuator: TurretAngularActuator | null;
  articulation: TurretStationArticulation | null;
  /** BAR-like in-build-stance gate. Fixed/legacy area emitters may opt out. */
  requiresAlignmentForWork: boolean;
  alignmentToleranceRadians: number;
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
