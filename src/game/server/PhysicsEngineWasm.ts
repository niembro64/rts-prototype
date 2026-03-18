// WASM-backed PhysicsEngine — drop-in replacement for PhysicsEngine.ts
// Phase 3: bulk sync via typed array view (one WASM call replaces N*4 getter calls)

import initWasm, {
  PhysicsEngine as WasmPhysicsEngine,
} from './physics-wasm/pkg/rts_physics_wasm.js';
import type { InitOutput } from './physics-wasm/pkg/rts_physics_wasm.js';
import { UNIT_MASS_MULTIPLIER } from '../../config';
import type { PhysicsBody } from '@/types/game';

export type { PhysicsBody } from '@/types/game';

/** Singleton WASM module output — initialized once */
let wasmOutput: InitOutput | null = null;

/** Initialize the WASM module. Must be called (and awaited) before creating a PhysicsEngineWasm. */
export async function initPhysicsWasm(): Promise<void> {
  if (!wasmOutput) {
    wasmOutput = await initWasm();
  }
}

export class PhysicsEngineWasm {
  private engine: WasmPhysicsEngine;
  private slotMap: Map<PhysicsBody, number> = new Map();
  private staticSlotMap: Map<PhysicsBody, number> = new Map();

  constructor(mapWidth: number, mapHeight: number) {
    if (!wasmOutput) {
      throw new Error(
        'WASM not initialized. Call await initPhysicsWasm() before creating PhysicsEngineWasm.',
      );
    }
    this.engine = new WasmPhysicsEngine(mapWidth, mapHeight);
  }

  createUnitBody(
    x: number,
    y: number,
    physicsRadius: number,
    mass: number,
    label: string,
  ): PhysicsBody {
    const physicsMass = mass * UNIT_MASS_MULTIPLIER;
    const slot = this.engine.add_dynamic_body(
      x,
      y,
      physicsRadius,
      physicsMass,
      0.15, // frictionAir
      0.2, // restitution
    );
    // Plain object — updated in bulk after each step()
    const body: PhysicsBody = {
      x,
      y,
      vx: 0,
      vy: 0,
      radius: physicsRadius,
      mass: physicsMass,
      invMass: 1 / physicsMass,
      frictionAir: 0.15,
      restitution: 0.2,
      isStatic: false,
      label,
    };
    this.slotMap.set(body, slot);
    return body;
  }

  createBuildingBody(
    x: number,
    y: number,
    width: number,
    height: number,
    label: string,
  ): PhysicsBody {
    const halfW = width / 2;
    const halfH = height / 2;
    const slot = this.engine.add_static_body(x, y, halfW, halfH, 0.1);
    const body: PhysicsBody = {
      x,
      y,
      vx: 0,
      vy: 0,
      radius: 0,
      mass: 0,
      invMass: 0,
      frictionAir: 0,
      restitution: 0.1,
      isStatic: true,
      label,
      halfW,
      halfH,
    };
    this.staticSlotMap.set(body, slot);
    return body;
  }

  removeBody(body: PhysicsBody): void {
    const dynSlot = this.slotMap.get(body);
    if (dynSlot !== undefined) {
      this.engine.remove_dynamic_body(dynSlot);
      this.slotMap.delete(body);
      return;
    }
    const statSlot = this.staticSlotMap.get(body);
    if (statSlot !== undefined) {
      this.engine.remove_static_body(statSlot);
      this.staticSlotMap.delete(body);
    }
  }

  applyForce(body: PhysicsBody, fx: number, fy: number): void {
    const slot = this.slotMap.get(body);
    if (slot === undefined) return;
    this.engine.apply_force(slot, fx, fy);
  }

  step(dtSec: number): void {
    this.engine.step(dtSec);
    this.bulkSync();
  }

  /** Bulk-copy x/y/vx/vy from WASM memory into PhysicsBody objects.
   *  One WASM call + one typed array view replaces N*4 boundary crossings. */
  private bulkSync(): void {
    const ptr = this.engine.bulk_sync();
    const maxSlots = this.engine.max_slot_count();
    if (maxSlots === 0) return;
    const buf = new Float64Array(wasmOutput!.memory.buffer, ptr, maxSlots * 4);
    for (const [body, slot] of this.slotMap) {
      const base = slot * 4;
      body.x = buf[base];
      body.y = buf[base + 1];
      body.vx = buf[base + 2];
      body.vy = buf[base + 3];
    }
  }

  /** Get the underlying WASM engine (for Phase 4 turret/projectile batch calls). */
  getWasmEngine(): WasmPhysicsEngine {
    return this.engine;
  }

  /** Get WASM memory (for reading batch output buffers). */
  static getWasmMemory(): WebAssembly.Memory {
    return wasmOutput!.memory;
  }

  /** Clean up WASM memory */
  destroy(): void {
    this.engine.free();
    this.slotMap.clear();
    this.staticSlotMap.clear();
  }
}
