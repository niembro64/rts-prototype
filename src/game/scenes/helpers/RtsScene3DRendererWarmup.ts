import { isMobileLikeBrowser } from '@/browserRuntime';
import type { Explosion3D } from '../../render3d/Explosion3D';
import type { ThreeApp } from '../../render3d/ThreeApp';
import type { RtsScene3DRenderPhase } from './RtsScene3DRenderPhase';
import type { RtsScene3DSnapshotIntake } from './RtsScene3DSnapshotIntake';

export type RtsScene3DRendererWarmupOptions = {
  threeApp: ThreeApp;
  explosionRenderer: Explosion3D;
  snapshotIntake: RtsScene3DSnapshotIntake;
  getRenderPhase: () => RtsScene3DRenderPhase | null;
  isClientRenderEnabled: () => boolean;
  isDestroyed: () => boolean;
  notifyWarmupChange: (active: boolean) => void;
};

export class RtsScene3DRendererWarmup {
  private readonly threeApp: ThreeApp;
  private readonly explosionRenderer: Explosion3D;
  private readonly snapshotIntake: RtsScene3DSnapshotIntake;
  private readonly getRenderPhase: () => RtsScene3DRenderPhase | null;
  private readonly isClientRenderEnabled: () => boolean;
  private readonly isDestroyed: () => boolean;
  private readonly notifyWarmupChange: (active: boolean) => void;
  private started = false;
  private active = false;
  private token = 0;

  constructor(options: RtsScene3DRendererWarmupOptions) {
    this.threeApp = options.threeApp;
    this.explosionRenderer = options.explosionRenderer;
    this.snapshotIntake = options.snapshotIntake;
    this.getRenderPhase = options.getRenderPhase;
    this.isClientRenderEnabled = options.isClientRenderEnabled;
    this.isDestroyed = options.isDestroyed;
    this.notifyWarmupChange = options.notifyWarmupChange;
  }

  markClientReadyForStartupIfPossible(): void {
    if (this.isClientRenderEnabled() && !this.getRenderPhase()?.isStartupReady()) return;
    this.snapshotIntake.markClientReadyAfterRender();
  }

  tickStartupGate(): void {
    const renderPhase = this.getRenderPhase();
    if (!renderPhase) return;
    if (!this.started && renderPhase.isStartupReady() && this.snapshotIntake.hasStartupFullSnapshotApplied()) {
      this.start();
      return;
    }
    if (this.started && !this.active) this.markClientReadyForStartupIfPossible();
  }

  shutdown(): void {
    this.token++;
    this.threeApp.setDrawSuspended(false);
    this.setActive(false);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.setActive(true);
    if (isMobileLikeBrowser()) {
      this.markClientReadyForStartupIfPossible();
      this.setActive(false);
      return;
    }
    this.threeApp.setDrawSuspended(true);
    const token = ++this.token;
    this.explosionRenderer.prepareWarmup();
    void this.threeApp.precompileShadersAsync().catch((error) => {
      console.warn('3D renderer shader warmup failed', error);
    }).finally(() => {
      if (token !== this.token) return;
      this.explosionRenderer.finishWarmup();
      this.threeApp.setDrawSuspended(false);
      if (this.isDestroyed()) return;
      this.markClientReadyForStartupIfPossible();
      this.setActive(false);
    });
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.notifyWarmupChange(active);
  }
}
