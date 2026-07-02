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
};

// Entity source for attack target queries
export type AttackEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean;
};

// Entity source for guard/assist target queries
export type GuardEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean;
};

// Entity source for reclaim target queries
