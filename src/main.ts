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
// Both the server tick (GameServer.create()) and the client
// prediction stepper (ClientViewState construction) await the
// same singleton in initSimWasm() — starting it at boot just
// front-loads the fetch/compile so the first actual await is a
// no-op. Logs the build stamp once so devs can confirm a fresh
// `npm run build:wasm` is being served.
initSimWasm().then(
  (sim) => console.log(`(rust) ${sim.version} loaded`),
  (err) => console.error('(rust) sim-wasm init failed:', err),
);

createApp(App).mount('#app');
