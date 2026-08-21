// Input system types extracted from game/input/ files

import type { Entity, PlayerId,  } from './sim';

// Point in world space (sim coords). `z` is the altitude of the
// rendered 3D ground at this XY (from CursorGround.pickSim) and is
// optional — 2D-only callers and synthetic interior points (path
// distribution interpolations) can omit it; renderers fall back to a
// terrain sample when missing.
export type WorldPoint = {
  x: number;
  y: number;
  z?: number;
};


// Provides tick and player info
export type InputContext = {
  getTick(): number;
  activePlayerId: PlayerId;
  /** True when this client holds NO seat — it watches. A spectator's
   *  activePlayerId is only a VIEW target (whose fog/economy to borrow),
   *  never an allegiance: selection and cursors must stay agnostic to
   *  players and teams instead of impersonating the viewed seat. */
  isSpectator: boolean;
};


// Entity source for selection queries
export type SelectionEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
};

// Entity source for repair target queries
export type RepairEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean;
};

// Entity source for relationship-aware point target queries.
export type PointTargetEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean;
};

export type AttackEntitySource = PointTargetEntitySource;
export type GuardEntitySource = PointTargetEntitySource;

// Entity source for reclaim target queries
