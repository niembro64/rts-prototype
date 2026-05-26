import { decode, encode } from '@msgpack/msgpack';
import {
  commandTypeFromId,
  commandTypeToId,
  type Command,
  COMMAND_SCHEMA_VERSION,
  type CommandBundle,
  type CommandType,
} from '../../types/commands';
import type { PlayerId } from '../../types/entityTypes';

type WireCommand = [number, unknown[]];
type WireCommandBundle = [
  schemaVersion: number,
  targetTick: number,
  peerId: number,
  seq: number,
  commandCount: number,
  commands: WireCommand[],
];

type CommandPayloadLayout = readonly string[];

// Append-only per-command payload slots. Existing slot order is wire format.
const COMMAND_PAYLOAD_LAYOUTS = {
  select: ['entityIds', 'additive'],
  move: ['entityIds', 'targetX', 'targetY', 'targetZ', 'individualTargets', 'waypointType', 'queue'],
  stop: ['entityIds'],
  clearQueuedOrders: ['entityIds'],
  removeLastQueuedOrder: ['entityIds'],
  clearSelection: [],
  ping: ['targetX', 'targetY', 'targetZ', 'playerId'],
  scan: ['targetX', 'targetY', 'playerId'],
  startBuild: ['builderId', 'buildingType', 'gridX', 'gridY', 'queue'],
  queueUnit: ['factoryId', 'unitId'],
  cancelQueueItem: ['factoryId', 'index'],
  setRallyPoint: ['factoryId', 'rallyX', 'rallyY'],
  setFactoryWaypoints: ['factoryId', 'waypoints', 'queue'],
  fireDGun: ['commanderId', 'targetX', 'targetY', 'targetZ'],
  setFireEnabled: ['entityIds', 'enabled'],
  repair: ['commanderId', 'targetId', 'queue'],
  repairArea: ['commanderId', 'targetX', 'targetY', 'targetZ', 'radius', 'queue'],
  reclaim: ['commanderId', 'targetId', 'queue'],
  wait: ['entityIds', 'queue'],
  attack: ['entityIds', 'targetId', 'queue'],
  attackGround: ['entityIds', 'targetX', 'targetY', 'targetZ', 'queue'],
  attackArea: ['entityIds', 'targetX', 'targetY', 'targetZ', 'radius', 'queue'],
  guard: ['entityIds', 'targetId', 'queue'],
  setSnapshotRate: ['rate'],
  setKeyframeRatio: ['ratio'],
  setTickRate: ['rate'],
  setUnitGroundNormalEmaMode: ['mode'],
  setSendGridInfo: ['enabled'],
  setBackgroundUnitType: ['unitType', 'enabled'],
  setMaxTotalUnits: ['maxTotalUnits'],
  setMirrorsEnabled: ['enabled'],
  setForceFieldsEnabled: ['enabled'],
  setForceFieldsObstructSight: ['enabled'],
  setForceFieldReflectionMode: ['mode'],
  setFogOfWarEnabled: ['enabled'],
  setConverterTax: ['tax'],
} as const satisfies Record<CommandType, CommandPayloadLayout>;

export class CommandBundleCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandBundleCodecError';
  }
}

export class CommandBundleDuplicateError extends CommandBundleCodecError {
  constructor(key: string) {
    super(`Duplicate command bundle: ${key}`);
    this.name = 'CommandBundleDuplicateError';
  }
}

export class CommandBundleDuplicateGuard {
  private readonly seenKeys = new Set<string>();

  accept(bundle: CommandBundle): CommandBundle {
    const key = commandBundleKey(bundle);
    if (this.seenKeys.has(key)) throw new CommandBundleDuplicateError(key);
    this.seenKeys.add(key);
    return bundle;
  }

  has(bundle: CommandBundle): boolean {
    return this.seenKeys.has(commandBundleKey(bundle));
  }

  clear(): void {
    this.seenKeys.clear();
  }
}

export function createCommandBundle(options: {
  targetTick: number;
  peerId: PlayerId;
  seq: number;
  commands: readonly Command[];
}): CommandBundle {
  const targetTick = finiteNonNegativeInteger(options.targetTick, 'targetTick');
  return {
    schemaVersion: COMMAND_SCHEMA_VERSION,
    targetTick,
    peerId: finitePositiveInteger(options.peerId, 'peerId') as PlayerId,
    seq: finiteNonNegativeInteger(options.seq, 'seq'),
    commands: options.commands.map((command, index) =>
      normalizeBundleCommand(command, targetTick, index),
    ),
  };
}

export function createEmptyCommandBundle(
  targetTick: number,
  peerId: PlayerId,
  seq: number,
): CommandBundle {
  return createCommandBundle({ targetTick, peerId, seq, commands: [] });
}

export function encodeCommandBundle(bundle: CommandBundle): Uint8Array {
  validateBundleHeader(bundle);
  const commands = bundle.commands.map((command, index): WireCommand => {
    const normalized = normalizeBundleCommand(command, bundle.targetTick, index);
    return [
      commandTypeToId(normalized.type),
      encodeCommandPayload(normalized),
    ];
  });
  const wire: WireCommandBundle = [
    COMMAND_SCHEMA_VERSION,
    bundle.targetTick,
    bundle.peerId,
    bundle.seq,
    commands.length,
    commands,
  ];
  return encode(wire);
}

export function decodeCommandBundle(bytes: Uint8Array): CommandBundle {
  const wire = decode(bytes);
  if (!Array.isArray(wire) || wire.length !== 6) {
    throw new CommandBundleCodecError('Command bundle must be a 6-slot array');
  }
  const [
    schemaVersion,
    targetTick,
    peerId,
    seq,
    commandCount,
    commands,
  ] = wire as unknown as WireCommandBundle;
  if (schemaVersion !== COMMAND_SCHEMA_VERSION) {
    throw new CommandBundleCodecError(
      `Unsupported command schema version: ${schemaVersion}`,
    );
  }
  const normalizedTargetTick = finiteNonNegativeInteger(targetTick, 'targetTick');
  const normalizedPeerId = finitePositiveInteger(peerId, 'peerId') as PlayerId;
  const normalizedSeq = finiteNonNegativeInteger(seq, 'seq');
  const normalizedCommandCount = finiteNonNegativeInteger(commandCount, 'commandCount');
  if (!Array.isArray(commands)) {
    throw new CommandBundleCodecError('Command list must be an array');
  }
  if (commands.length !== normalizedCommandCount) {
    throw new CommandBundleCodecError(
      `Command count mismatch: header ${normalizedCommandCount}, body ${commands.length}`,
    );
  }
  return {
    schemaVersion: COMMAND_SCHEMA_VERSION,
    targetTick: normalizedTargetTick,
    peerId: normalizedPeerId,
    seq: normalizedSeq,
    commands: commands.map((command, index) =>
      decodeWireCommand(command, normalizedTargetTick, index),
    ),
  };
}

export function decodeCommandBundleOnce(
  bytes: Uint8Array,
  guard: CommandBundleDuplicateGuard,
): CommandBundle {
  return guard.accept(decodeCommandBundle(bytes));
}

export function commandBundleKey(bundle: Pick<CommandBundle, 'targetTick' | 'peerId' | 'seq'>): string {
  return `${bundle.targetTick}:${bundle.peerId}:${bundle.seq}`;
}

export function compareCommandBundlesForExecution(
  a: Pick<CommandBundle, 'targetTick' | 'peerId' | 'seq'>,
  b: Pick<CommandBundle, 'targetTick' | 'peerId' | 'seq'>,
): number {
  const tickDelta = a.targetTick - b.targetTick;
  if (tickDelta !== 0) return tickDelta;
  const peerDelta = a.peerId - b.peerId;
  if (peerDelta !== 0) return peerDelta;
  return a.seq - b.seq;
}

export function orderedCommandsFromBundles(
  bundles: readonly CommandBundle[],
): Command[] {
  const ordered = [...bundles].sort(compareCommandBundlesForExecution);
  const commands: Command[] = [];
  for (const bundle of ordered) {
    for (const command of bundle.commands) commands.push(command);
  }
  return commands;
}

function encodeCommandPayload(command: Command): unknown[] {
  const layout = COMMAND_PAYLOAD_LAYOUTS[command.type];
  const record = command as unknown as Record<string, unknown>;
  return layout.map((field) => record[field] ?? null);
}

function decodeWireCommand(
  wire: WireCommand,
  targetTick: number,
  commandIndex: number,
): Command {
  if (!Array.isArray(wire) || wire.length !== 2) {
    throw new CommandBundleCodecError(`Command ${commandIndex} must be a 2-slot array`);
  }
  const [typeId, payload] = wire;
  if (!Number.isInteger(typeId)) {
    throw new CommandBundleCodecError(`Command ${commandIndex} has invalid type id`);
  }
  const type = commandTypeFromId(typeId);
  if (type === null) {
    throw new CommandBundleCodecError(`Command ${commandIndex} has unknown type id ${typeId}`);
  }
  if (!Array.isArray(payload)) {
    throw new CommandBundleCodecError(`Command ${commandIndex} payload must be an array`);
  }
  const layout = COMMAND_PAYLOAD_LAYOUTS[type];
  if (payload.length !== layout.length) {
    throw new CommandBundleCodecError(
      `Command ${commandIndex} payload slot count mismatch for ${type}: expected ${layout.length}, got ${payload.length}`,
    );
  }
  const command: Record<string, unknown> = { type, tick: targetTick };
  for (let i = 0; i < layout.length; i++) {
    const value = payload[i];
    if (value !== null) command[layout[i]] = value;
  }
  return command as Command;
}

function validateBundleHeader(bundle: CommandBundle): void {
  if (bundle.schemaVersion !== COMMAND_SCHEMA_VERSION) {
    throw new CommandBundleCodecError(
      `Unsupported command schema version: ${bundle.schemaVersion}`,
    );
  }
  finiteNonNegativeInteger(bundle.targetTick, 'targetTick');
  finitePositiveInteger(bundle.peerId, 'peerId');
  finiteNonNegativeInteger(bundle.seq, 'seq');
  if (!Array.isArray(bundle.commands)) {
    throw new CommandBundleCodecError('commands must be an array');
  }
}

function normalizeBundleCommand(
  command: Command,
  targetTick: number,
  commandIndex: number,
): Command {
  if (command.tick !== targetTick) {
    throw new CommandBundleCodecError(
      `Command ${commandIndex} tick ${command.tick} does not match bundle targetTick ${targetTick}`,
    );
  }
  if (commandTypeToId(command.type) === undefined) {
    throw new CommandBundleCodecError(`Command ${commandIndex} has unknown type ${command.type}`);
  }
  return command;
}

function finiteNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new CommandBundleCodecError(`${label} must be a non-negative integer`);
  }
  return value;
}

function finitePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CommandBundleCodecError(`${label} must be a positive integer`);
  }
  return value;
}
