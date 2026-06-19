// Per-window single-instance enforcement for the backend simulation
// and the foreground renderer.
//
// The design philosophy ("Two Simulations, One Authority, Full Physics")
// says exactly one authoritative simulation and exactly one frontend
// renderer per browser window. This module makes that invariant
// load-bearing: any attempt to start a second GameServer, or to create a
// second GameInstance, while a previous one is still alive throws.
// Bugs that would otherwise show up as the commander snapping to origin
// and units flickering — a stale sim's snapshots clobbering the live one
// — now surface immediately at the offending call site.

let activeSim: object | null = null;
let activeRenderer: object | null = null;

function describe(owner: object | null): string {
  if (!owner) return 'none';
  const ctor = (owner as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? 'unknown';
}

export function acquireSimSlot(owner: object): void {
  if (activeSim !== null && activeSim !== owner) {
    throw new Error(
      `sessionSingleton: a backend simulation is already running ` +
        `(${describe(activeSim)}); stop it before starting another ` +
        `(${describe(owner)}). See budget_design_philosophy.html — one ` +
        `authoritative simulation per window.`,
    );
  }
  activeSim = owner;
}

export function transferSimSlot(from: object, to: object): void {
  if (activeSim !== from) {
    throw new Error(
      `sessionSingleton: cannot transfer backend simulation slot from ` +
        `${describe(from)} because the active owner is ${describe(activeSim)}.`,
    );
  }
  activeSim = to;
}

export function releaseSimSlot(owner: object): void {
  if (activeSim === owner) activeSim = null;
}

export function acquireRendererSlot(owner: object): void {
  if (activeRenderer !== null && activeRenderer !== owner) {
    throw new Error(
      `sessionSingleton: a frontend renderer is already alive ` +
        `(${describe(activeRenderer)}); destroy it before creating ` +
        `another (${describe(owner)}). See budget_design_philosophy.html — ` +
        `one renderer per window.`,
    );
  }
  activeRenderer = owner;
}

export function transferRendererSlot(from: object, to: object): void {
  if (activeRenderer !== from) {
    throw new Error(
      `sessionSingleton: cannot transfer frontend renderer slot from ` +
        `${describe(from)} because the active owner is ${describe(activeRenderer)}.`,
    );
  }
  activeRenderer = to;
}

export function releaseRendererSlot(owner: object): void {
  if (activeRenderer === owner) activeRenderer = null;
}


