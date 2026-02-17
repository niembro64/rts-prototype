// Shared types and helpers for CombatStatsModal and CombatStatsGraph

import type { NetworkCombatStats } from '../game/network/NetworkTypes';

export type FriendlyFireMode = 'ignore' | 'include' | 'subtract';

export interface StatsSnapshot {
  timestamp: number; // ms since history start
  stats: NetworkCombatStats;
}

export function applyFriendlyFire(enemy: number, friendly: number, mode: FriendlyFireMode): number {
  if (mode === 'ignore') return enemy;
  if (mode === 'include') return enemy + friendly;
  return enemy - friendly; // subtract
}
