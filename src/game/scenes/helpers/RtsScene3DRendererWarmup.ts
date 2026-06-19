import { isMobileLikeBrowser } from '@/browserRuntime';
import type { Explosion3D } from '../../render3d/Explosion3D';
import type { ThreeApp } from '../../render3d/ThreeApp';
import type { RtsScene3DRenderPhase } from './RtsScene3DRenderPhase';
import type { RtsScene3DSnapshotIntake } from './RtsScene3DSnapshotIntake';

const SHADER_WARMUP_TIMEOUT_MS = 5000;

type RtsScene3DRendererWarmupOptions = {
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
  private warmupTimeout: ReturnType<typeof setTimeout> | null = null;

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
    this.clearWarmupTimeout();
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
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.clearWarmupTimeout();
      if (token !== this.token) return;
      this.explosionRenderer.finishWarmup();
      this.threeApp.setDrawSuspended(false);
      if (this.isDestroyed()) return;
      this.markClientReadyForStartupIfPossible();
      this.setActive(false);
    };
    const runSynchronousFallback = (): void => {
      try {
        this.threeApp.precompileShaders();
      } catch (error) {
        console.warn('3D renderer shader warmup fallback failed', error);
      }
    };

    this.explosionRenderer.prepareWarmup();
    // The server startup barrier only needs to know the client has consumed
    // the full bootstrap and has render resources ready. Shader compilation is
    // an optimization for the reveal frame; waiting on it here can deadlock the
    // server because no post-start tick snapshots are emitted until clients ack.
    this.markClientReadyForStartupIfPossible();
    this.warmupTimeout = setTimeout(() => {
      if (finished) return;
      if (token !== this.token) return;
      console.warn(
        `3D renderer shader warmup timed out after ${SHADER_WARMUP_TIMEOUT_MS}ms; ` +
          'continuing startup.',
      );
      runSynchronousFallback();
      finish();
    }, SHADER_WARMUP_TIMEOUT_MS);
    void this.threeApp.precompileShadersAsync()
      .then(finish)
      .catch((error) => {
        if (finished) return;
        if (token !== this.token) return;
        console.warn('3D renderer async shader warmup failed', error);
        runSynchronousFallback();
        finish();
      });
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.notifyWarmupChange(active);
  }

  private clearWarmupTimeout(): void {
    if (this.warmupTimeout === null) return;
    clearTimeout(this.warmupTimeout);
    this.warmupTimeout = null;
  }
}
