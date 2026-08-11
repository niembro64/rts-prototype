// Entry point for contractTestHost.html: initialize the WASM sim and stop.
//
// No Vue app, no lobby, no background battle -- so the per-window sim slot
// (game/lifecycle/sessionSingleton) stays free and a contract test that needs
// to stand up its own authoritative backend can actually do so.

import { initSimWasm } from './game/sim-wasm/init';

declare global {
  interface Window {
    __BA_CONTRACT_HOST_READY__?: true;
  }
}

void initSimWasm().then(() => {
  window.__BA_CONTRACT_HOST_READY__ = true;
});
