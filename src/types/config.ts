// Types extracted from src/config.ts

export type SnapshotConfig = {
  deltaEnabled: boolean;
  positionThreshold: number;
  velocityThreshold: number;
  rotationPositionThreshold: number;
  rotationVelocityThreshold: number;
};

export type EmaLowConfig = {
  drop: number;
  recovery: number;
};

export type EmaTierConfig = {
  avg: number;
  low: EmaLowConfig;
};

export type EmaHighConfig = {
  spike: number;
  recovery: number;
};

export type EmaMsConfig = {
  avg: number;
  hi: EmaHighConfig;
};

export type KnockbackConfig = {
  FORCE_FIELD_PULL_MULTIPLIER: number;
  SPLASH: number;
};

export type ForceFieldVisualConfig = {
  particleCount: number;
  particleSpeed: number;
  particleLength: number;
  particleThickness: number;
  arcCount: number;
  arcSegments: number;
  arcJitter: number;
  arcThickness: number;
  arcOpacity: number;
  arcFlickerMs: number;
  trailSegments: number;
  trailSpacing: number;
  trailFalloff: number;
};

export type ForceFieldTurretShape =
  | 'triangle'
  | 'line'
  | 'square'
  | 'hexagon'
  | 'circle';

export type ForceFieldTurretConfig = {
  shape: ForceFieldTurretShape;
  count: number;
  length: number;
  width: number;
  taper: number;
  baseOffset: number;
  originOffset: number;
  thickness: number;
  reversePhase: boolean;
};

export type SpinConfig = {
  idle: number;
  max: number;
  accel: number;
  decel: number;
};

export type BarrelShape =
  | {
      type: 'simpleMultiBarrel';
      barrelCount: number;
      barrelLength: number;
      barrelThickness?: number;
      orbitRadius: number;
      depthScale: number;
      spin: SpinConfig;
    }
  | {
      type: 'coneMultiBarrel';
      barrelCount: number;
      barrelLength: number;
      barrelThickness?: number;
      baseOrbit: number;
      /** Explicit tip-orbit radius (as a fraction of unit scale). When
       *  present, overrides the default derivation from `spread.angle`
       *  — so the barrel cluster's visual splay can be specified
       *  directly without also widening the firing spread. Useful for
       *  vertical-launcher rocket pods where we want wide visible
       *  barrel angles but a narrow firing cone around vertical. */
      tipOrbit?: number;
      depthScale: number;
      spin: SpinConfig;
    }
  | {
      type: 'simpleSingleBarrel';
      barrelLength: number;
      barrelThickness?: number;
    }
  | { type: 'complexSingleEmitter'; grate: ForceFieldTurretConfig };

export type MountPoint = {
  x: number;
  y: number;
};

export type BuildingStatEntry = {
  energyCost: number;
  hp: number;
};

export type MapSize = {
  width: number;
  height: number;
};
