import { createApp } from 'vue';
import App from './App.vue';
// Canonical styling for the bar-control component family
// (BarLabel / BarButton / BarButtonGroup / BarControlGroup).
// Loaded once at app boot so both the bottom bars (which still use
// bare HTML with the same class names) and the GAME LOBBY's
// component-based controls share one source of truth.
import './styles/barControls.css';
import { initSimWasm } from './game/sim-wasm/init';

// Kick off the WASM sim core load in parallel with Vue mount.
// Both the authoritative server tick and adjacent-tick renderer
// presentation use the same singleton in initSimWasm() — starting it at boot just
// front-loads the fetch/compile so the first actual await is a
// no-op. Logs the build stamp once so devs can confirm a fresh
// `npm run build:wasm` is being served.
//
// If the WASM core fails to load, the game cannot run at all
// (every battle start awaits the same rejected singleton), so the
// failure must be user-visible — not a console line behind a
// lobby that silently can't start anything.
initSimWasm().then(
  (sim) => console.log(`(rust) ${sim.version} loaded`),
  (err) => {
    console.error('(rust) sim-wasm init failed:', err);
    showFatalBootError(err);
  },
);

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

createApp(App).mount('#app');
