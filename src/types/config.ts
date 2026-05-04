// Types extracted from src/config.ts

export type SnapshotDeltaResolutionConfig = {
  positionThresholdMultiplier: number;
  velocityThresholdMultiplier: number;
  rotationPositionThresholdMultiplier: number;
  rotationVelocityThresholdMultiplier: number;
};

export type SnapshotConfig = {
  deltaEnabled: boolean;
  positionThreshold: number;
  velocityThreshold: number;
  rotationPositionThreshold: number;
  rotationVelocityThreshold: number;
  ownedEntityDelta: SnapshotDeltaResolutionConfig;
  observedEntityDelta: SnapshotDeltaResolutionConfig;
  ownedProjectileUpdateStride: number;
  observedProjectileUpdateStride: number;
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
  SPLASH: number;
};

export type ForceFieldVisualConfig = {
  /** 'player' makes the shield inherit the owning player's primary color. */
  colorMode: 'player' | 'config';
  /** Fallback used when no owning player is known or colorMode='config'. */
  fallbackColor: number;
  /** Idle emitter color; active pulse lerps from this toward the field color. */
  emitterIdleColor: number;
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

export type ForceFieldImpactVisualConfig = {
  /** Tangent plane burst style. More styles can be added without changing events. */
  style: 'tangentRingPulse';
  /** Same player/config color routing as the shield bubble. */
  colorMode: 'player' | 'config';
  fallbackColor: number;
  maxImpacts: number;
  durationMs: number;
  ringCount: number;
  ringSegments: number;
  ringDelayMs: number;
  startRadius: number;
  endRadius: number;
  ringInnerRadiusFrac: number;
  ringOpacity: number;
  coreRadiusFrac: number;
  coreOpacity: number;
  coreDurationFrac: number;
  surfaceOffset: number;
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

export type MapSize = {
  width: number;
  height: number;
};
