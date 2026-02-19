// Shared types and helpers for CombatStatsModal and CombatStatsGraph

import type { NetworkCombatStats } from '../game/network/NetworkTypes';

export type FriendlyFireMode = 'include' | 'ignore' | 'subHalf' | 'subtract';

export interface StatsSnapshot {
  timestamp: number; // ms since history start
  stats: NetworkCombatStats;
}

export function applyFriendlyFire(enemy: number, friendly: number, mode: FriendlyFireMode): number {
  if (mode === 'include') return enemy + friendly;
  if (mode === 'ignore') return enemy;
  if (mode === 'subHalf') return enemy - friendly * 0.5;
  return enemy - friendly; // subtract
}
