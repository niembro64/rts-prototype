// Shared types and helpers for CombatStatsModal and CombatStatsGraph

export type { FriendlyFireMode, StatsSnapshot } from '@/types/ui';
import type { FriendlyFireMode } from '@/types/ui';

export function applyFriendlyFire(enemy: number, friendly: number, mode: FriendlyFireMode): number {
  if (mode === 'include') return enemy + friendly;
  if (mode === 'ignore') return enemy;
  if (mode === 'subHalf') return enemy - friendly * 0.5;
  return enemy - friendly; // subtract
}
