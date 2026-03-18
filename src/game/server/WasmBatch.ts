// Module-level WASM engine reference for batch processing (turrets, projectiles).
// Set by GameServer when using WASM physics; null when using JS fallback.

import type { PhysicsEngine as WasmPhysicsEngine } from './physics-wasm/pkg/rts_physics_wasm.js';

let _wasmEngine: WasmPhysicsEngine | null = null;
let _wasmMemory: WebAssembly.Memory | null = null;

export function setWasmBatchEngine(engine: WasmPhysicsEngine, memory: WebAssembly.Memory): void {
  _wasmEngine = engine;
  _wasmMemory = memory;
}

export function clearWasmBatchEngine(): void {
  _wasmEngine = null;
  _wasmMemory = null;
}

export function getWasmEngine(): WasmPhysicsEngine | null {
  return _wasmEngine;
}

export function getWasmMemory(): WebAssembly.Memory | null {
  return _wasmMemory;
}
