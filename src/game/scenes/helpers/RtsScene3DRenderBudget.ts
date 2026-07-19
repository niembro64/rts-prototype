import type { GraphicsConfig } from '@/types/graphics';

export type RtsScene3DRenderBudgetTier = 'normal' | 'busy' | 'heavy' | 'extreme';

export type RtsScene3DRenderBudgetState = {
  readonly graphicsConfig: GraphicsConfig;
  readonly tier: RtsScene3DRenderBudgetTier;
  readonly tierIndex: number;
  readonly unitCount: number;
};

export type RtsScene3DRenderBudgetTelemetry = {
  readonly tier: RtsScene3DRenderBudgetTier;
  readonly tierIndex: number;
  readonly unitCount: number;
  readonly hudFrameStride: number;
  readonly effectFrameStride: number;
};

type ResolveRenderBudgetOptions = {
  readonly baseGraphicsConfig: GraphicsConfig;
  readonly unitCount: number;
  readonly renderTpsAvg: number;
  readonly renderTpsWorst: number;
};

type RenderBudgetTierConfig = {
  readonly tier: RtsScene3DRenderBudgetTier;
  readonly hudFrameStride: number;
  readonly effectFrameStride: number;
  /**
   * Animated tread wheels and cleats create a large per-object scene graph.
   * At high battlefield counts preserve the track envelope, but shed this
   * presentation-only motion before it can dominate frame preparation.
   */
  readonly treadsAnimated: boolean;
  readonly burnMarkDensityScale: number;
  readonly groundPrintDensityScale: number;
  readonly materialExplosionPieceBudgetCap: number;
  readonly materialExplosionPhysicsFramesSkipMin: number;
};

const TIER_CONFIGS: readonly RenderBudgetTierConfig[] = [
  {
    tier: 'normal',
    hudFrameStride: 1,
    effectFrameStride: 1,
    treadsAnimated: true,
    burnMarkDensityScale: 1,
    groundPrintDensityScale: 1,
    materialExplosionPieceBudgetCap: Number.POSITIVE_INFINITY,
    materialExplosionPhysicsFramesSkipMin: 0,
  },
  {
    tier: 'busy',
    hudFrameStride: 2,
    effectFrameStride: 2,
    treadsAnimated: true,
    burnMarkDensityScale: 0.7,
    groundPrintDensityScale: 0.7,
    materialExplosionPieceBudgetCap: 24,
    materialExplosionPhysicsFramesSkipMin: 1,
  },
  {
    tier: 'heavy',
    hudFrameStride: 3,
    effectFrameStride: 3,
    treadsAnimated: false,
    burnMarkDensityScale: 0.35,
    groundPrintDensityScale: 0.35,
    materialExplosionPieceBudgetCap: 12,
    materialExplosionPhysicsFramesSkipMin: 2,
  },
  {
    tier: 'extreme',
    hudFrameStride: 4,
    effectFrameStride: 4,
    treadsAnimated: false,
    burnMarkDensityScale: 0.15,
    groundPrintDensityScale: 0.15,
    materialExplosionPieceBudgetCap: 4,
    materialExplosionPhysicsFramesSkipMin: 3,
  },
];

const RECOVERY_SAMPLE_COUNT = 90;

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function tierIndexForUnitCount(unitCount: number): number {
  if (unitCount >= 900) return 3;
  if (unitCount >= 350) return 2;
  if (unitCount >= 200) return 1;
  return 0;
}

function tierIndexForRenderTps(renderTpsAvg: number, renderTpsWorst: number): number {
  if (renderTpsAvg <= 0 && renderTpsWorst <= 0) return 0;
  if (renderTpsAvg < 28 || renderTpsWorst < 18) return 3;
  if (renderTpsAvg < 38 || renderTpsWorst < 26) return 2;
  if (renderTpsAvg < 50 || renderTpsWorst < 38) return 1;
  return 0;
}

function copyGraphicsConfig(source: GraphicsConfig, target: GraphicsConfig): void {
  Object.assign(target, source);
}

export class RtsScene3DRenderBudget {
  private readonly effectiveGraphicsConfig: GraphicsConfig;
  private tierIndex = 0;
  private unitCount = 0;
  private recoverySamples = 0;

  constructor(seedGraphicsConfig: GraphicsConfig) {
    this.effectiveGraphicsConfig = { ...seedGraphicsConfig };
  }

  resolve(options: ResolveRenderBudgetOptions): RtsScene3DRenderBudgetState {
    this.unitCount = Math.max(0, Math.floor(finiteNonNegative(options.unitCount, 0)));
    const requestedTier = Math.max(
      tierIndexForUnitCount(this.unitCount),
      tierIndexForRenderTps(options.renderTpsAvg, options.renderTpsWorst),
    );

    if (requestedTier > this.tierIndex) {
      this.tierIndex = requestedTier;
      this.recoverySamples = 0;
    } else if (requestedTier < this.tierIndex) {
      this.recoverySamples++;
      if (this.recoverySamples >= RECOVERY_SAMPLE_COUNT) {
        this.tierIndex--;
        this.recoverySamples = 0;
      }
    } else {
      this.recoverySamples = 0;
    }

    const tier = TIER_CONFIGS[this.tierIndex] ?? TIER_CONFIGS[0];
    this.writeEffectiveGraphicsConfig(options.baseGraphicsConfig, tier);
    return {
      graphicsConfig: this.effectiveGraphicsConfig,
      tier: tier.tier,
      tierIndex: this.tierIndex,
      unitCount: this.unitCount,
    };
  }

  getTelemetry(): RtsScene3DRenderBudgetTelemetry {
    const tier = TIER_CONFIGS[this.tierIndex] ?? TIER_CONFIGS[0];
    return {
      tier: tier.tier,
      tierIndex: this.tierIndex,
      unitCount: this.unitCount,
      hudFrameStride: this.effectiveGraphicsConfig.hudFrameStride,
      effectFrameStride: this.effectiveGraphicsConfig.effectFrameStride,
    };
  }

  private writeEffectiveGraphicsConfig(
    base: GraphicsConfig,
    tier: RenderBudgetTierConfig,
  ): void {
    const out = this.effectiveGraphicsConfig;
    copyGraphicsConfig(base, out);
    out.hudFrameStride = Math.max(base.hudFrameStride | 0, tier.hudFrameStride);
    out.effectFrameStride = Math.max(base.effectFrameStride | 0, tier.effectFrameStride);
    // This only changes the local visual rig. Unit movement, terrain contact,
    // collision, and lockstep state remain authored and simulated exactly as
    // before; the lower-detail mesh still renders each tread's full envelope.
    out.treadsAnimated = base.treadsAnimated && tier.treadsAnimated;
    out.burnMarkDensity = clamp01(base.burnMarkDensity * tier.burnMarkDensityScale);
    out.groundPrintDensity = clamp01(base.groundPrintDensity * tier.groundPrintDensityScale);
    out.materialExplosionPieceBudget = Math.min(
      Math.max(0, Math.floor(base.materialExplosionPieceBudget)),
      tier.materialExplosionPieceBudgetCap,
    );
    out.materialExplosionPhysicsFramesSkip = Math.max(
      Math.max(0, Math.floor(base.materialExplosionPhysicsFramesSkip)),
      tier.materialExplosionPhysicsFramesSkipMin,
    );
  }
}
