// WASM-backed PhysicsEngine — drop-in replacement for PhysicsEngine.ts
// Uses slot-based indexing instead of object references for zero-copy interop.

import initWasm, {
  PhysicsEngine as WasmPhysicsEngine,
} from './physics-wasm/pkg/rts_physics_wasm.js';
import type { InitOutput } from './physics-wasm/pkg/rts_physics_wasm.js';
import { UNIT_MASS_MULTIPLIER } from '../../config';
import type { PhysicsBody } from '@/types/game';

export type { PhysicsBody } from '@/types/game';

// Thin proxy that maps PhysicsBody field reads to WASM slot lookups.
// GameServer code does `body.x`, `body.vx`, etc. — this makes that work
// without changing any call sites.
function createBodyProxy(
  engine: WasmPhysicsEngine,
  slot: number,
  isStatic: boolean,
  label: string,
  extraStatic?: { halfW: number; halfH: number },
): PhysicsBody {
  if (isStatic) {
    // Static bodies don't move — return a plain object (no proxy overhead)
    return {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 0,
      mass: 0,
      invMass: 0,
      frictionAir: 0,
      restitution: 0,
      isStatic: true,
      label,
      halfW: extraStatic?.halfW,
      halfH: extraStatic?.halfH,
    };
  }

  // Dynamic body — proxy reads of x/y/vx/vy/mass to WASM
  return {
    get x() {
      return engine.get_x(slot);
    },
    set x(_v: number) {
      /* no-op: position is WASM-owned */
    },
    get y() {
      return engine.get_y(slot);
    },
    set y(_v: number) {
      /* no-op */
    },
    get vx() {
      return engine.get_vx(slot);
    },
    set vx(_v: number) {
      /* no-op */
    },
    get vy() {
      return engine.get_vy(slot);
    },
    set vy(_v: number) {
      /* no-op */
    },
    get mass() {
      return engine.get_mass(slot);
    },
    set mass(_v: number) {
      /* no-op */
    },
    radius: 0,
    invMass: 0,
    frictionAir: 0,
    restitution: 0,
    isStatic: false,
    label,
    _wasmSlot: slot,
  } as PhysicsBody;
}

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
    const body = createBodyProxy(this.engine, slot, false, label);
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
    const body = createBodyProxy(this.engine, slot, true, label, {
      halfW,
      halfH,
    });
    // Set the static body's position (it won't change)
    body.x = x;
    body.y = y;
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
  }

  /** Clean up WASM memory */
  destroy(): void {
    this.engine.free();
    this.slotMap.clear();
    this.staticSlotMap.clear();
  }
}
