import type { PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import type { NetworkServerSnapshotEconomy } from './NetworkManager';
import {
  createFloat64WireRows,
  reserveFloat64WireRows,
  type Float64WireRows,
} from './snapshotWireRows';

export const ECONOMY_SNAPSHOT_WIRE_STRIDE = 11;

type EconomySnapshotWireSource = Float64WireRows;

const economyBuf: Record<PlayerId, NetworkServerSnapshotEconomy> = {} as Record<
  PlayerId,
  NetworkServerSnapshotEconomy
>;
const economyEntryPool: Record<PlayerId, NetworkServerSnapshotEconomy> = {} as Record<
  PlayerId,
  NetworkServerSnapshotEconomy
>;
const economyKeys: PlayerId[] = [];
const economyWireSource: EconomySnapshotWireSource = createFloat64WireRows();
const economyWireSources = new WeakMap<object, EconomySnapshotWireSource>([
  [economyBuf, economyWireSource],
]);

function createEconomyEntry(): NetworkServerSnapshotEconomy {
  return {
    stockpile: { curr: 0, max: 0 },
    income: { base: 0, production: 0 },
    expenditure: 0,
    metal: {
      stockpile: { curr: 0, max: 0 },
      income: { base: 0, extraction: 0 },
      expenditure: 0,
    },
  };
}

function copyEconomyIntoWireRow(
  playerId: PlayerId,
  economy: NetworkServerSnapshotEconomy,
  base: number,
): void {
  const values = economyWireSource.values;
  values[base + 0] = playerId;
  values[base + 1] = economy.stockpile.curr;
  values[base + 2] = economy.stockpile.max;
  values[base + 3] = economy.income.base;
  values[base + 4] = economy.income.production;
  values[base + 5] = economy.expenditure;
  values[base + 6] = economy.metal.stockpile.curr;
  values[base + 7] = economy.metal.stockpile.max;
  values[base + 8] = economy.metal.income.base;
  values[base + 9] = economy.metal.income.extraction;
  values[base + 10] = economy.metal.expenditure;
}

function getPooledEconomyEntry(playerId: PlayerId): NetworkServerSnapshotEconomy {
  let entry = economyEntryPool[playerId];
  if (!entry) {
    entry = createEconomyEntry();
    economyEntryPool[playerId] = entry;
  }
  return entry;
}

export function getEconomySnapshotWireSource(
  economy: Record<number, NetworkServerSnapshotEconomy>,
): EconomySnapshotWireSource | undefined {
  return economyWireSources.get(economy);
}

export function writeEconomySnapshotWireRowsDirect(
  playerCount: number,
  recipientPlayerId: PlayerId | undefined,
  economy: Record<PlayerId, NetworkServerSnapshotEconomy>,
): Record<PlayerId, NetworkServerSnapshotEconomy> {
  economyWireSources.set(economy, economyWireSource);
  economyWireSource.count = 0;

  const economyPlayerCount = Math.max(0, Math.floor(playerCount));
  for (let playerId = 1; playerId <= economyPlayerCount; playerId++) {
    if (recipientPlayerId !== undefined && playerId !== recipientPlayerId) continue;
    const eco = economyManager.getEconomy(playerId as PlayerId);
    if (!eco) continue;
    const base = reserveFloat64WireRows(
      economyWireSource,
      1,
      ECONOMY_SNAPSHOT_WIRE_STRIDE,
    ) * ECONOMY_SNAPSHOT_WIRE_STRIDE;
    const values = economyWireSource.values;
    values[base + 0] = playerId;
    values[base + 1] = eco.stockpile.curr;
    values[base + 2] = eco.stockpile.max;
    values[base + 3] = eco.income.base;
    values[base + 4] = eco.income.production;
    values[base + 5] = eco.expenditure;
    values[base + 6] = eco.metal.stockpile.curr;
    values[base + 7] = eco.metal.stockpile.max;
    values[base + 8] = eco.metal.income.base;
    values[base + 9] = eco.metal.income.extraction;
    values[base + 10] = eco.metal.expenditure;
  }

  return economy;
}

export function serializeEconomySnapshot(
  playerCount: number,
  recipientPlayerId: PlayerId | undefined,
): Record<PlayerId, NetworkServerSnapshotEconomy> {
  // Unscoped/local streams keep the full table for debug player toggling.
  // Per-player streams only need the recipient's top-bar economy.
  for (const key of economyKeys) {
    delete economyBuf[key];
  }
  economyKeys.length = 0;
  economyWireSource.count = 0;

  const economyPlayerCount = Math.max(0, Math.floor(playerCount));
  for (let playerId = 1; playerId <= economyPlayerCount; playerId++) {
    if (recipientPlayerId !== undefined && playerId !== recipientPlayerId) continue;
    const eco = economyManager.getEconomy(playerId as PlayerId);
    if (eco) {
      const pid = playerId as PlayerId;
      const entry = getPooledEconomyEntry(pid);
      entry.stockpile.curr = eco.stockpile.curr;
      entry.stockpile.max = eco.stockpile.max;
      entry.income.base = eco.income.base;
      entry.income.production = eco.income.production;
      entry.expenditure = eco.expenditure;
      entry.metal.stockpile.curr = eco.metal.stockpile.curr;
      entry.metal.stockpile.max = eco.metal.stockpile.max;
      entry.metal.income.base = eco.metal.income.base;
      entry.metal.income.extraction = eco.metal.income.extraction;
      entry.metal.expenditure = eco.metal.expenditure;
      economyKeys.push(pid);
      economyBuf[pid] = entry;
      const base = reserveFloat64WireRows(
        economyWireSource,
        1,
        ECONOMY_SNAPSHOT_WIRE_STRIDE,
      ) * ECONOMY_SNAPSHOT_WIRE_STRIDE;
      copyEconomyIntoWireRow(pid, entry, base);
    }
  }

  return economyBuf;
}
