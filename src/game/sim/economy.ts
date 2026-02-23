import type { EconomyState, PlayerId } from './types';
import {
  STARTING_STOCKPILE,
  MAX_STOCKPILE,
  BASE_INCOME_PER_SECOND,
} from '../../config';
import { getUnitBlueprint } from './blueprints';

// Economy constants (using values from config.ts + blueprints)
export const ECONOMY_CONSTANTS = {
  maxStockpile: MAX_STOCKPILE,
  baseIncome: BASE_INCOME_PER_SECOND,
  startingStockpile: STARTING_STOCKPILE,
  dgunCost: getUnitBlueprint('commander').dgun!.energyCost,
};

// Create initial economy state for a player
export function createEconomyState(): EconomyState {
  return {
    stockpile: { curr: ECONOMY_CONSTANTS.startingStockpile, max: ECONOMY_CONSTANTS.maxStockpile },
    income: { base: ECONOMY_CONSTANTS.baseIncome, production: 0 },
    expenditure: 0,
  };
}

// Economy manager - handles all player economies
export class EconomyManager {
  private economies: Map<PlayerId, EconomyState> = new Map();

  // Initialize economy for a player
  initPlayer(playerId: PlayerId): void {
    if (!this.economies.has(playerId)) {
      this.economies.set(playerId, createEconomyState());
    }
  }

  // Get economy state for a player
  getEconomy(playerId: PlayerId): EconomyState | undefined {
    return this.economies.get(playerId);
  }

  // Get or create economy for a player
  getOrCreateEconomy(playerId: PlayerId): EconomyState {
    if (!this.economies.has(playerId)) {
      this.initPlayer(playerId);
    }
    return this.economies.get(playerId)!;
  }

  // Set full economy state for a player (used for network sync)
  setEconomyState(playerId: PlayerId, state: EconomyState): void {
    this.economies.set(playerId, { ...state });
  }

  // Set production (called when solar panels change)
  setProduction(playerId: PlayerId, production: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.income.production = production;
  }

  // Add to production (when a solar panel completes)
  addProduction(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.income.production += amount;
  }

  // Remove from production (when a solar panel is destroyed)
  removeProduction(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.income.production = Math.max(0, economy.income.production - amount);
  }

  // Get total income (base + production)
  getTotalIncome(playerId: PlayerId): number {
    const economy = this.getOrCreateEconomy(playerId);
    return economy.income.base + economy.income.production;
  }

  // Get net flow (income - expenditure)
  getNetFlow(playerId: PlayerId): number {
    const economy = this.getOrCreateEconomy(playerId);
    return economy.income.base + economy.income.production - economy.expenditure;
  }

  // Try to spend energy (returns amount actually spent)
  trySpendEnergy(playerId: PlayerId, amount: number): number {
    const economy = this.getOrCreateEconomy(playerId);
    const actualSpend = Math.min(amount, economy.stockpile.curr);
    economy.stockpile.curr -= actualSpend;
    return actualSpend;
  }

  // Check if player can afford something
  canAfford(playerId: PlayerId, amount: number): boolean {
    const economy = this.getOrCreateEconomy(playerId);
    return economy.stockpile.curr >= amount;
  }

  // Spend energy instantly (for things like D-gun)
  spendInstant(playerId: PlayerId, amount: number): boolean {
    const economy = this.getOrCreateEconomy(playerId);
    if (economy.stockpile.curr >= amount) {
      economy.stockpile.curr -= amount;
      return true;
    }
    return false;
  }

  // Update economy each tick
  update(dtMs: number): void {
    const dtSec = dtMs / 1000;

    for (const [, economy] of this.economies) {
      // Calculate income
      const total = economy.income.base + economy.income.production;

      // Add income to stockpile
      economy.stockpile.curr += total * dtSec;

      // Cap at max stockpile
      if (economy.stockpile.curr > economy.stockpile.max) {
        economy.stockpile.curr = economy.stockpile.max;
      }

      // Reset expenditure each frame (will be recalculated by construction system)
      economy.expenditure = 0;
    }
  }

  // Record expenditure (called by construction system)
  recordExpenditure(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.expenditure += amount;
  }

  // Reset all state (call between game sessions)
  reset(): void {
    this.economies.clear();
  }
}

// Singleton instance
export const economyManager = new EconomyManager();
