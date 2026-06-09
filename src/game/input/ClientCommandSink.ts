import type { Command } from '../sim/commands';

export type ClientCommandSink = {
  enqueue(command: Command): void;
};
