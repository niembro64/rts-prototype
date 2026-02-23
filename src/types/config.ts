// Types extracted from src/config.ts

export type SnapshotConfig = {
  deltaEnabled: boolean;
  positionThreshold: number;
  rotationThreshold: number;
  velocityThreshold: number;
};

export type EmaLowConfig = {
  drop: number;
  recovery: number;
};

export type EmaTierConfig = {
  avg: number;
  low: EmaLowConfig;
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
  baseCost: number;
  hp: number;
};

export type MapSize = {
  width: number;
  height: number;
};
