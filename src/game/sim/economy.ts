import type { EconomyState, PlayerId } from './types';
import {
  STARTING_STOCKPILE,
  MAX_STOCKPILE,
  BASE_INCOME_PER_SECOND,
  COMMANDER_STATS,
} from '../../config';

// Economy constants (using values from config.ts)
export const ECONOMY_CONSTANTS = {
  maxStockpile: MAX_STOCKPILE,
  baseIncome: BASE_INCOME_PER_SECOND,
  startingStockpile: STARTING_STOCKPILE,
  dgunCost: COMMANDER_STATS.dgunCost,
};

// Create initial economy state for a player
export function createEconomyState(): EconomyState {
  return {
    stockpile: ECONOMY_CONSTANTS.startingStockpile,
    maxStockpile: ECONOMY_CONSTANTS.maxStockpile,
    baseIncome: ECONOMY_CONSTANTS.baseIncome,
    production: 0,         // Will be updated based on solar panels
    expenditure: 0,        // Will be updated based on construction
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
    economy.production = production;
  }

  // Add to production (when a solar panel completes)
  addProduction(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.production += amount;
  }

  // Remove from production (when a solar panel is destroyed)
  removeProduction(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.production = Math.max(0, economy.production - amount);
  }

  // Get total income (base + production)
  getTotalIncome(playerId: PlayerId): number {
    const economy = this.getOrCreateEconomy(playerId);
    return economy.baseIncome + economy.production;
  }

  // Get net flow (income - expenditure)
  getNetFlow(playerId: PlayerId): number {
    const economy = this.getOrCreateEconomy(playerId);
    return economy.baseIncome + economy.production - economy.expenditure;
  }

  // Try to spend energy (returns amount actually spent)
  trySpendEnergy(playerId: PlayerId, amount: number): number {
    const economy = this.getOrCreateEconomy(playerId);
    const actualSpend = Math.min(amount, economy.stockpile);
    economy.stockpile -= actualSpend;
    return actualSpend;
  }

  // Check if player can afford something
  canAfford(playerId: PlayerId, amount: number): boolean {
    const economy = this.getOrCreateEconomy(playerId);
    return economy.stockpile >= amount;
  }

  // Spend energy instantly (for things like D-gun)
  spendInstant(playerId: PlayerId, amount: number): boolean {
    const economy = this.getOrCreateEconomy(playerId);
    if (economy.stockpile >= amount) {
      economy.stockpile -= amount;
      return true;
    }
    return false;
  }

  // Update economy each tick
  update(dtMs: number): void {
    const dtSec = dtMs / 1000;

    for (const [, economy] of this.economies) {
      // Calculate income
      const income = economy.baseIncome + economy.production;

      // Add income to stockpile
      economy.stockpile += income * dtSec;

      // Cap at max stockpile
      if (economy.stockpile > economy.maxStockpile) {
        economy.stockpile = economy.maxStockpile;
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
}

// Singleton instance
export const economyManager = new EconomyManager();
