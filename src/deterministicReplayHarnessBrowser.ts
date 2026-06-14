import { runDeterministicReplayHarness } from './game/architecture/DeterministicReplayHarness';
import { initSimWasm } from './game/sim-wasm/init';

declare global {
  interface Window {
    __runDeterministicReplayHarness: () => Promise<Awaited<ReturnType<typeof runDeterministicReplayHarness>>>;
  }
}

window.__runDeterministicReplayHarness = async () => {
  await initSimWasm();
  return runDeterministicReplayHarness();
};

export {};
