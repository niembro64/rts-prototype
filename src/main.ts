import { createApp } from 'vue';
// Canonical styling for the bar-control component family
// (BarLabel / BarButton / BarButtons / BarControlGroup).
// Loaded once at app boot so both the bottom bars (which still use
// bare HTML with the same class names) and the GAME LOBBY's
// component-based controls share one source of truth.
import './styles/barControls.css';
import { initSimWasm } from './game/sim-wasm/init';

// Initialize authoritative math before importing or mounting the application.
// A cold production load can fetch cached JavaScript chunks much faster than
// the larger WASM artifact; letting Vue mount during that window allows
// presentation work such as roster thumbnails to enter sim-safe geometry
// helpers before their deterministic kernels exist.
//
// If the WASM core fails to load, the game cannot run at all
// (every battle start awaits the same rejected singleton), so failure remains
// user-visible without mounting a partially functional lobby.
async function bootApplication(): Promise<void> {
  let sim;
  try {
    sim = await initSimWasm();
  } catch (err) {
    console.error('(rust) sim-wasm init failed:', err);
    showFatalBootError(err);
    return;
  }

  console.log(`(rust) ${sim.version} loaded`);
  const { default: App } = await import('./App.vue');
  createApp(App).mount('#app');
}

void bootApplication().catch((err) => {
  console.error('(app) startup failed:', err);
  showFatalBootError(err);
});

/** Full-viewport fatal-boot overlay. Deliberately plain DOM (no Vue,
 *  no game state) so it works no matter how broken the boot is. */
function showFatalBootError(err: unknown): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'background:rgba(8,10,12,0.96)', 'color:#ff6b6b',
    'display:flex', 'flex-direction:column', 'align-items:center',
    'justify-content:center', 'gap:16px', 'text-align:center',
    'font:16px/1.5 system-ui, sans-serif', 'padding:32px',
  ].join(';');

  const title = document.createElement('div');
  title.style.cssText = 'font-size:22px;font-weight:700';
  title.textContent = 'Failed to load the simulation core';

  const detail = document.createElement('div');
  detail.style.cssText = 'color:#d8d2c8;max-width:640px;word-break:break-word';
  detail.textContent =
    `${err instanceof Error ? err.message : String(err)} — ` +
    'the game cannot start without its WebAssembly simulation. ' +
    'Check your connection (or rebuild with `npm run build:wasm`) and reload.';

  const reload = document.createElement('button');
  reload.style.cssText = [
    'font:600 16px system-ui,sans-serif', 'padding:10px 28px',
    'background:#266b5e', 'color:#fff', 'border:none',
    'border-radius:6px', 'cursor:pointer',
  ].join(';');
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => window.location.reload());

  overlay.append(title, detail, reload);
  document.body.appendChild(overlay);
}
