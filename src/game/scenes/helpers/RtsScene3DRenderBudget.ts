import type { GraphicsConfig } from '@/types/graphics';
import { clamp01 } from '../../math';

type RtsScene3DRenderBudgetTier = 'normal' | 'busy' | 'heavy' | 'extreme';

type RtsScene3DRenderBudgetState = {
  readonly graphicsConfig: GraphicsConfig;
  readonly tier: RtsScene3DRenderBudgetTier;
  readonly tierIndex: number;
  readonly unitCount: number;
};

type RtsScene3DRenderBudgetTelemetry = {
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
  readonly burnMarkDensityScale: number;
  readonly groundPrintDensityScale: number;
};

const TIER_CONFIGS: readonly RenderBudgetTierConfig[] = [
  {
    tier: 'normal',
    hudFrameStride: 1,
    effectFrameStride: 1,
    burnMarkDensityScale: 1,
    groundPrintDensityScale: 1,
  },
  {
    tier: 'busy',
    hudFrameStride: 2,
    effectFrameStride: 2,
    burnMarkDensityScale: 0.7,
    groundPrintDensityScale: 0.7,
  },
  {
    tier: 'heavy',
    hudFrameStride: 3,
    effectFrameStride: 3,
    burnMarkDensityScale: 0.35,
    groundPrintDensityScale: 0.35,
  },
  {
    tier: 'extreme',
    hudFrameStride: 4,
    effectFrameStride: 4,
    burnMarkDensityScale: 0.15,
    groundPrintDensityScale: 0.15,
  },
];

// P2-01: recovery hysteresis is elapsed-time based (the old 90-frame count
// meant 0.6s at 144 Hz and 3s at 30 Hz for the same intent).
const RECOVERY_HOLD_MS = 1500;

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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
  private recoveryHoldStartMs: number | null = null;
  private writtenTierIndex = -1;
  private writtenBaseConfig: GraphicsConfig | null = null;

  constructor(seedGraphicsConfig: GraphicsConfig) {
    this.effectiveGraphicsConfig = { ...seedGraphicsConfig };
  }

  resolve(options: ResolveRenderBudgetOptions): RtsScene3DRenderBudgetState {
    this.unitCount = Math.max(0, Math.floor(finiteNonNegative(options.unitCount, 0)));
    const requestedTier = Math.max(
      tierIndexForUnitCount(this.unitCount),
      tierIndexForRenderTps(options.renderTpsAvg, options.renderTpsWorst),
    );

    // Downward quality response stays immediate; recovery holds for a
    // fixed elapsed time regardless of display refresh (P2-01).
    if (requestedTier > this.tierIndex) {
      this.tierIndex = requestedTier;
      this.recoveryHoldStartMs = null;
    } else if (requestedTier < this.tierIndex) {
      const nowMs = performance.now();
      if (this.recoveryHoldStartMs === null) {
        this.recoveryHoldStartMs = nowMs;
      } else if (nowMs - this.recoveryHoldStartMs >= RECOVERY_HOLD_MS) {
        this.tierIndex--;
        this.recoveryHoldStartMs = null;
      }
    } else {
      this.recoveryHoldStartMs = null;
    }

    const tier = TIER_CONFIGS[this.tierIndex] ?? TIER_CONFIGS[0];
    // P2-01: the full config copy only happens when the tier or the base
    // config object actually changed; steady frames return the retained
    // effective config untouched.
    if (
      this.writtenTierIndex !== this.tierIndex ||
      this.writtenBaseConfig !== options.baseGraphicsConfig
    ) {
      this.writeEffectiveGraphicsConfig(options.baseGraphicsConfig, tier);
      this.writtenTierIndex = this.tierIndex;
      this.writtenBaseConfig = options.baseGraphicsConfig;
    }
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
    out.burnMarkDensity = clamp01(base.burnMarkDensity * tier.burnMarkDensityScale);
    out.groundPrintDensity = clamp01(base.groundPrintDensity * tier.groundPrintDensityScale);
  }
}
