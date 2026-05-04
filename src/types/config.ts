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

// Barrel-cluster geometry conventions. The firing axis points forward
// from the turret head's center along chassis-local +X. Each barrel is
// a cylinder positioned by its BASE (anchor on the head) and TIP (where
// shots leave). All `*RadiusFrac` / `barrelLength` values are scalar
// FRACTIONS of the turret's head radius (= TurretBlueprint.bodyRadius);
// world-space sizing happens at render time. Cylinder thickness is
// authored in absolute world units via `barrelThickness`.
//
// `simpleMultiBarrel` — parallel cluster: every barrel sits on the same
// orbit radius at base and tip, like a Gatling drum.
// `coneMultiBarrel`  — splayed cluster: base and tip sit on different
// orbits, so the cluster fans inward (base wider) or outward (tip
// wider). Used by mortars, salvo-rocket pods, etc.
// `simpleSingleBarrel` — one cylinder on the firing axis (no orbit).
// `complexSingleEmitter` — non-cylindrical force-field emitter.
export type BarrelShape =
  | {
      type: 'simpleMultiBarrel';
      /** Number of cylinders evenly spaced around the firing axis. */
      barrelCount: number;
      /** Forward extension of each cylinder past the head's leading
       *  edge, as a fraction of head radius. The cylinder runs from
       *  (forward=0, orbit=orbitRadius) to (forward=barrelLength,
       *  orbit=orbitRadius). */
      barrelLength: number;
      /** Cylinder diameter in absolute world units. Falls back to a
       *  derived value (from shot collision radius) when omitted. */
      barrelThickness?: number;
      /** Distance from the firing axis to each cylinder's centerline,
       *  as a fraction of head radius. Same value at base and tip
       *  (parallel cluster). */
      orbitRadius: number;
      /** Drum-spin animation (rad/s envelopes by engagement state). */
      spin: SpinConfig;
    }
  | {
      type: 'coneMultiBarrel';
      /** Number of cylinders evenly spaced around the firing axis. */
      barrelCount: number;
      /** Forward extension of each cylinder past the head's leading
       *  edge, as a fraction of head radius. Set to a tiny positive
       *  value (e.g. 0.01) when you want a barrel cluster that splays
       *  almost entirely sideways — the visible cylinder length is
       *  √(barrelLength² + (tipOrbit − baseOrbit)²) × headRadius, so
       *  most of the visible length comes from the radial spread, not
       *  the forward run. */
      barrelLength: number;
      /** Cylinder diameter in absolute world units. */
      barrelThickness?: number;
      /** Distance from the firing axis to each cylinder's BASE, as a
       *  fraction of head radius. */
      baseOrbit: number;
      /** Distance from the firing axis to each cylinder's TIP, as a
       *  fraction of head radius. When omitted, derived from
       *  `spread.angle` so the visible splay matches the firing spread.
       *  Authoring this explicitly DECOUPLES the visual splay from the
       *  firing spread — useful for vertical-launcher rocket pods that
       *  want wide visible barrel angles but a narrow firing cone. */
      tipOrbit?: number;
      /** Drum-spin animation (rad/s envelopes by engagement state). */
      spin: SpinConfig;
    }
  | {
      type: 'simpleSingleBarrel';
      /** Forward extension of the single cylinder past the head's
       *  leading edge, as a fraction of head radius. */
      barrelLength: number;
      /** Cylinder diameter in absolute world units. */
      barrelThickness?: number;
    }
  | { type: 'complexSingleEmitter'; grate: ForceFieldTurretConfig };

export type MapSize = {
  width: number;
  height: number;
};
