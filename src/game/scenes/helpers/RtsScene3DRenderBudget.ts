import type { GraphicsConfig } from '@/types/graphics';

export type RtsScene3DRenderBudgetTier = 'normal';

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
  readonly cameraDistance?: number;
};

export class RtsScene3DRenderBudget {
  private readonly effectiveGraphicsConfig: GraphicsConfig;
  private unitCount = 0;

  constructor(seedGraphicsConfig: GraphicsConfig) {
    this.effectiveGraphicsConfig = { ...seedGraphicsConfig };
  }

  resolve(options: ResolveRenderBudgetOptions): RtsScene3DRenderBudgetState {
    this.unitCount = Math.max(0, Math.floor(options.unitCount));
    void options.renderTpsAvg;
    void options.renderTpsWorst;
    void options.cameraDistance;
    Object.assign(this.effectiveGraphicsConfig, options.baseGraphicsConfig);
    return {
      graphicsConfig: this.effectiveGraphicsConfig,
      tier: 'normal',
      tierIndex: 0,
      unitCount: this.unitCount,
    };
  }

  getTelemetry(): RtsScene3DRenderBudgetTelemetry {
    return {
      tier: 'normal',
      tierIndex: 0,
      unitCount: this.unitCount,
      hudFrameStride: this.effectiveGraphicsConfig.hudFrameStride,
      effectFrameStride: this.effectiveGraphicsConfig.effectFrameStride,
    };
  }
}
