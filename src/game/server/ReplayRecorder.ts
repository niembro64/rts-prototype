import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { CommandAuthority } from './commandAuthority';
import type { GameServerConfig } from '@/types/game';

export type BudgetReplayCommandEntry = {
  receivedAtTick: number;
  receivedAtMs: number;
  authority: CommandAuthority;
  command: Command;
};

export type BudgetReplayFile = {
  schema: 'budget-annihilation.replay.v1';
  createdAt: string;
  exportedAt: string;
  playerIds: PlayerId[];
  initialConfig: unknown;
  finalTick: number;
  commands: BudgetReplayCommandEntry[];
};

export class ReplayRecorder {
  private readonly createdAt = new Date().toISOString();
  private readonly initialConfig: unknown;
  private readonly playerIds: PlayerId[];
  private readonly commands: BudgetReplayCommandEntry[] = [];

  constructor(config: GameServerConfig, playerIds: readonly PlayerId[]) {
    this.initialConfig = cloneJson(config);
    this.playerIds = copyPlayerIds(playerIds);
  }

  recordAcceptedCommand(
    command: Command,
    authority: CommandAuthority,
    receivedAtTick: number,
    receivedAtMs: number,
  ): void {
    this.commands.push({
      receivedAtTick,
      receivedAtMs,
      authority: cloneJson(authority),
      command: cloneJson(command),
    });
  }

  getCommandCount(): number {
    return this.commands.length;
  }

  export(finalTick: number, exportedAt = new Date().toISOString()): BudgetReplayFile {
    return {
      schema: 'budget-annihilation.replay.v1',
      createdAt: this.createdAt,
      exportedAt,
      playerIds: copyPlayerIds(this.playerIds),
      initialConfig: cloneJson(this.initialConfig),
      finalTick,
      commands: cloneJson(this.commands),
    };
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, jsonReplacer)) as T;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) {
    const items: unknown[] = [];
    for (const item of value) items.push(item);
    return items;
  }
  return value;
}

function copyPlayerIds(playerIds: readonly PlayerId[]): PlayerId[] {
  const copy = new Array<PlayerId>(playerIds.length);
  for (let i = 0; i < playerIds.length; i++) copy[i] = playerIds[i];
  return copy;
}
