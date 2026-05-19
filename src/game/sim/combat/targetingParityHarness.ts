// AIM-08.0 parity harness.
//
// This file is the contract that the upcoming SoA targeting kernels
// (AIM-08.1 through AIM-08.5) must satisfy on every supported scenario
// before each phase's PR lands. The TS targeting FSM in
// targetingSystem.ts produces a final per-turret tuple of (target,
// state, aimErrorYaw, aimErrorPitch, losBlockedTicks); the SoA path
// must produce the identical tuple for every turret on every tick.
// Without this grep-able invariant, parity is a vibe.
//
// Lifecycle:
//   AIM-08.0 (this PR) — capture the TS tuple after the targeting pass,
//     stub the SoA capture as empty, run a zero-diff check that is
//     trivially clean while no shadow data exists.
//   AIM-08.1..5         — each phase fills out the SoA capture from
//     the slab/kernel it lands, so the diff actually exercises the
//     new path against the still-authoritative TS path.
//   AIM-08.6            — delete this file in the same PR as the
//     writeback that makes the slab the source of truth.
//
// The harness is debug-flag gated (`VITE_BA_AIM08_PARITY=1` or
// `?aim08=1`); production builds skip even the snapshot capture.

import type { WorldState } from '../WorldState';
import type { EntityId, TurretState } from '../types';
import { GAME_DIAGNOSTICS } from '../../diagnostics';

type TurretParityRecord = {
  entityId: EntityId;
  turretIndex: number;
  target: EntityId | null;
  state: TurretState;
  aimErrorYaw: number;
  aimErrorPitch: number;
  losBlockedTicks: number;
};

// Float epsilon for aimError comparisons. The TS path uses
// double-precision math; the SoA path will use f64 in Rust through
// WASM, so the values should be bit-identical. Leave headroom for the
// odd Math.atan2 reorder while we burn in the parity work.
const AIM_ERROR_EPSILON = 1e-9;

// Rate-limit parity warnings so a systematic mismatch can't flood the
// console. Matches the cap pattern used by verifyRustDiffMask.
const WARN_LIMIT = 50;
let _warnCount = 0;

const _tsSnapshot: TurretParityRecord[] = [];
const _soaSnapshot: TurretParityRecord[] = [];
const _recordPool: TurretParityRecord[] = [];
const _soaIndex = new Map<number, TurretParityRecord>();

function acquireRecord(): TurretParityRecord {
  const r = _recordPool.pop();
  if (r) return r;
  return {
    entityId: 0,
    turretIndex: 0,
    target: null,
    state: 'idle',
    aimErrorYaw: 0,
    aimErrorPitch: 0,
    losBlockedTicks: 0,
  };
}

function releaseSnapshot(snap: TurretParityRecord[]): void {
  for (let i = 0; i < snap.length; i++) _recordPool.push(snap[i]);
  snap.length = 0;
}

// Pack (entityId, turretIndex) into a single number key. EntityIds are
// well under 2^24 in practice and turretIndex never exceeds 8 per
// MAX_WEAPONS_PER_ENTITY, so a 28-bit shift leaves room to spare.
function parityKey(entityId: EntityId, turretIndex: number): number {
  return entityId * 16 + turretIndex;
}

export function isTargetingParityEnabled(): boolean {
  return GAME_DIAGNOSTICS.targetingParity;
}

function captureTsSnapshot(world: WorldState): void {
  releaseSnapshot(_tsSnapshot);
  for (const entity of world.getArmedEntities()) {
    const combat = entity.combat;
    if (!combat) continue;
    const turrets = combat.turrets;
    for (let i = 0; i < turrets.length; i++) {
      const t = turrets[i];
      const r = acquireRecord();
      r.entityId = entity.id;
      r.turretIndex = i;
      r.target = t.target;
      r.state = t.state;
      r.aimErrorYaw = t.aimErrorYaw;
      r.aimErrorPitch = t.aimErrorPitch;
      r.losBlockedTicks = t.losBlockedTicks;
      _tsSnapshot.push(r);
    }
  }
}

// AIM-08.1+ will populate this from the SoA slab the next phase lands.
// Today the slab does not exist, so the snapshot is empty — which makes
// the diff a no-op and the "zero per-tick diff" Done-when criteria
// trivially satisfied.
function captureSoaSnapshot(_world: WorldState): void {
  releaseSnapshot(_soaSnapshot);
}

function reportMismatch(
  tick: number,
  kind: 'mismatch' | 'missing-in-ts' | 'missing-in-soa',
  ts: TurretParityRecord | null,
  soa: TurretParityRecord | null,
): void {
  if (_warnCount >= WARN_LIMIT) return;
  _warnCount++;
  console.warn('[AIM-08 parity]', {
    tick,
    kind,
    ts: ts && {
      entityId: ts.entityId,
      turretIndex: ts.turretIndex,
      target: ts.target,
      state: ts.state,
      aimErrorYaw: ts.aimErrorYaw,
      aimErrorPitch: ts.aimErrorPitch,
      losBlockedTicks: ts.losBlockedTicks,
    },
    soa: soa && {
      entityId: soa.entityId,
      turretIndex: soa.turretIndex,
      target: soa.target,
      state: soa.state,
      aimErrorYaw: soa.aimErrorYaw,
      aimErrorPitch: soa.aimErrorPitch,
      losBlockedTicks: soa.losBlockedTicks,
    },
  });
  if (_warnCount === WARN_LIMIT) {
    console.warn(
      `[AIM-08 parity] reached ${WARN_LIMIT} divergence warns; ` +
      `suppressing further warns for this session.`,
    );
  }
}

function diffSnapshots(tick: number): void {
  // Empty SoA snapshot means the next phase has not landed yet; nothing
  // to compare. This is the steady state for AIM-08.0.
  if (_soaSnapshot.length === 0) return;

  _soaIndex.clear();
  for (let i = 0; i < _soaSnapshot.length; i++) {
    const r = _soaSnapshot[i];
    _soaIndex.set(parityKey(r.entityId, r.turretIndex), r);
  }

  for (let i = 0; i < _tsSnapshot.length; i++) {
    const ts = _tsSnapshot[i];
    const key = parityKey(ts.entityId, ts.turretIndex);
    const soa = _soaIndex.get(key);
    if (!soa) {
      reportMismatch(tick, 'missing-in-soa', ts, null);
      continue;
    }
    _soaIndex.delete(key);
    if (
      ts.target !== soa.target ||
      ts.state !== soa.state ||
      ts.losBlockedTicks !== soa.losBlockedTicks ||
      Math.abs(ts.aimErrorYaw - soa.aimErrorYaw) > AIM_ERROR_EPSILON ||
      Math.abs(ts.aimErrorPitch - soa.aimErrorPitch) > AIM_ERROR_EPSILON
    ) {
      reportMismatch(tick, 'mismatch', ts, soa);
    }
  }
  for (const soa of _soaIndex.values()) {
    reportMismatch(tick, 'missing-in-ts', null, soa);
  }
  _soaIndex.clear();
}

export function checkTargetingParity(world: WorldState): void {
  if (!GAME_DIAGNOSTICS.targetingParity) return;
  captureTsSnapshot(world);
  captureSoaSnapshot(world);
  diffSnapshots(world.getTick());
}
