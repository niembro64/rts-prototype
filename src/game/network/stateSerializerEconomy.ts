import type { PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import type { NetworkServerSnapshotEconomy } from './NetworkManager';

const economyBuf: Record<PlayerId, NetworkServerSnapshotEconomy> = {} as Record<
  PlayerId,
  NetworkServerSnapshotEconomy
>;
const economyKeys: PlayerId[] = [];

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

  const economyPlayerCount = Math.max(0, Math.floor(playerCount));
  for (let playerId = 1; playerId <= economyPlayerCount; playerId++) {
    if (recipientPlayerId !== undefined && playerId !== recipientPlayerId) continue;
    const eco = economyManager.getEconomy(playerId as PlayerId);
    if (eco) {
      const pid = playerId as PlayerId;
      economyKeys.push(pid);
      economyBuf[pid] = {
        stockpile: { curr: eco.stockpile.curr, max: eco.stockpile.max },
        income: { base: eco.income.base, production: eco.income.production },
        expenditure: eco.expenditure,
        mana: {
          stockpile: { curr: eco.mana.stockpile.curr, max: eco.mana.stockpile.max },
          income: { base: eco.mana.income.base, territory: eco.mana.income.territory },
          expenditure: eco.mana.expenditure,
        },
        metal: {
          stockpile: { curr: eco.metal.stockpile.curr, max: eco.metal.stockpile.max },
          income: { base: eco.metal.income.base, extraction: eco.metal.income.extraction },
          expenditure: eco.metal.expenditure,
        },
      };
    }
  }

  return economyBuf;
}
