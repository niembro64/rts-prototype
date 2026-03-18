export type { GamePhase } from '@/types/network';
import type { GamePhase } from '@/types/network';

const GAME_PHASE_TRANSITIONS: Record<GamePhase, GamePhase[]> = {
  init: ['battle'],
  battle: ['paused', 'gameOver'],
  paused: ['battle', 'gameOver'],
  gameOver: [],
};

export function transitionPhase(from: GamePhase, to: GamePhase): GamePhase {
  if (!GAME_PHASE_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid phase transition: ${from} → ${to}`);
  }
  return to;
}
