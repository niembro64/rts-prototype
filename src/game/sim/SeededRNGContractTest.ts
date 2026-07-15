import { createHostGameGenerationSeed } from '../network/gameGenerationSeed';
import { SeededRNG } from './SeededRNG';
import { WorldState } from './WorldState';
import type { PlayerId } from './types';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[SeededRNG contract] ${message}`);
}

export function runSeededRNGContractTest(): void {
  const hostSeed = createHostGameGenerationSeed(1_785_000_000_123);
  assertContract(
    hostSeed === createHostGameGenerationSeed(1_785_000_000_123),
    'the same host millisecond must create the same uint32 seed',
  );
  assertContract(
    hostSeed !== createHostGameGenerationSeed(1_785_000_000_124),
    'adjacent host milliseconds must create distinct seeds',
  );

  const first = new SeededRNG(hostSeed);
  const second = new SeededRNG(hostSeed);
  const firstSequence = [first.next(1, 12), first.next(1, 12), first.next(2, 13)];
  const secondSequence = [second.next(1, 12), second.next(1, 12), second.next(2, 13)];
  assertContract(
    firstSequence.every((value, index) => value === secondSequence[index]),
    'equal seed/player/tick/call sequences must replay exactly',
  );
  assertContract(
    firstSequence[0] !== firstSequence[1],
    'multiple requests by one player in one tick need distinct stream ordinals',
  );

  const playerOne = new SeededRNG(hostSeed).next(1, 12);
  const playerTwo = new SeededRNG(hostSeed).next(2, 12);
  const nextTick = new SeededRNG(hostSeed).next(1, 13);
  const nextGame = new SeededRNG((hostSeed + 1) >>> 0).next(1, 12);
  assertContract(playerOne !== playerTwo, 'player number must influence each sample');
  assertContract(playerOne !== nextTick, 'simulation tick must influence each sample');
  assertContract(playerOne !== nextGame, 'game generation seed must influence each sample');

  const world = new WorldState(hostSeed, 128, 128);
  const playerId = 3 as PlayerId;
  const tickZero = world.nextRandom(playerId);
  world.incrementTick();
  const tickOne = world.nextRandom(playerId);
  assertContract(tickZero !== tickOne, 'WorldState must supply its current tick');
}
