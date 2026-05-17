import type { EconomyState, PlayerId, ResourceCost } from './types';
import {
  STARTING_STOCKPILE,
  MAX_STOCKPILE,
  BASE_INCOME_PER_SECOND,
  STARTING_METAL,
  MAX_METAL,
  BASE_METAL_PER_SECOND,
} from '../../config';
import { getUnitBlueprint } from './blueprints';

// Economy constants (using values from config.ts + blueprints)
export const ECONOMY_CONSTANTS = {
  maxStockpile: MAX_STOCKPILE,
  baseIncome: BASE_INCOME_PER_SECOND,
  startingStockpile: STARTING_STOCKPILE,
  maxMetal: MAX_METAL,
  baseMetalIncome: BASE_METAL_PER_SECOND,
  startingMetal: STARTING_METAL,
  dgunCost: getUnitBlueprint('commander').dgun!.energyCost,
};

// Create initial economy state for a player
export function createEconomyState(): EconomyState {
  return {
    stockpile: { curr: ECONOMY_CONSTANTS.startingStockpile, max: ECONOMY_CONSTANTS.maxStockpile },
    income: { base: ECONOMY_CONSTANTS.baseIncome, production: 0 },
    expenditure: 0,
    metal: {
      stockpile: { curr: ECONOMY_CONSTANTS.startingMetal, max: ECONOMY_CONSTANTS.maxMetal },
      income: { base: ECONOMY_CONSTANTS.baseMetalIncome, extraction: 0 },
      expenditure: 0,
    },
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
    let economy = this.economies.get(playerId);
    if (!economy) {
      economy = createEconomyState();
      this.economies.set(playerId, economy);
    }

    economy.stockpile.curr = state.stockpile.curr;
    economy.stockpile.max = state.stockpile.max;
    economy.income.base = state.income.base;
    economy.income.production = state.income.production;
    economy.expenditure = state.expenditure;

    economy.metal.stockpile.curr = state.metal.stockpile.curr;
    economy.metal.stockpile.max = state.metal.stockpile.max;
    economy.metal.income.base = state.metal.income.base;
    economy.metal.income.extraction = state.metal.income.extraction;
    economy.metal.expenditure = state.metal.expenditure;
  }

  // Set energy production (called when solar panels change)
  setProduction(playerId: PlayerId, production: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.income.production = production;
  }

  // Add to energy production (when a solar panel completes)
  addProduction(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.income.production += amount;
  }

  // Remove from energy production (when a solar panel is destroyed)
  removeProduction(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.income.production = Math.max(0, economy.income.production - amount);
  }

  // Add to metal extraction income (when an extractor completes)
  addMetalExtraction(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.metal.income.extraction += amount;
  }

  // Remove from metal extraction income (when an extractor is destroyed)
  removeMetalExtraction(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.metal.income.extraction = Math.max(0, economy.metal.income.extraction - amount);
  }

  // Get total energy income (base + production)
  getTotalIncome(playerId: PlayerId): number {
    const economy = this.getOrCreateEconomy(playerId);
    return economy.income.base + economy.income.production;
  }

  // Get net energy flow (income - expenditure)
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

  /** True iff the player's energy pool holds at least `amount`. The
   *  dgun gate uses this — the dgun is paid in ENERGY only (see
   *  `spendInstant` below) so the gate must read the same pool. */
  canAffordEnergy(playerId: PlayerId, amount: number): boolean {
    return this.getOrCreateEconomy(playerId).stockpile.curr >= amount;
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

  addStockpile(playerId: PlayerId, amount: ResourceCost): ResourceCost {
    const economy = this.getOrCreateEconomy(playerId);
    const energy = Math.max(0, Math.min(amount.energy, economy.stockpile.max - economy.stockpile.curr));
    const metal = Math.max(0, Math.min(amount.metal, economy.metal.stockpile.max - economy.metal.stockpile.curr));
    economy.stockpile.curr += energy;
    economy.metal.stockpile.curr += metal;
    return { energy, metal };
  }

  // Try to spend metal (returns amount actually spent)
  trySpendMetal(playerId: PlayerId, amount: number): number {
    const economy = this.getOrCreateEconomy(playerId);
    const actualSpend = Math.min(amount, economy.metal.stockpile.curr);
    economy.metal.stockpile.curr -= actualSpend;
    return actualSpend;
  }

  // Record metal expenditure (called by distribution system)
  recordMetalExpenditure(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.metal.expenditure += amount;
  }

  // Update economy each tick (energy + metal income).
  update(dtMs: number, _hasCommander?: (playerId: PlayerId) => boolean): void {
    const dtSec = dtMs / 1000;

    for (const economy of this.economies.values()) {
      // Energy income — unconditional.
      const totalEnergy = economy.income.base + economy.income.production;
      economy.stockpile.curr = Math.min(
        economy.stockpile.curr + totalEnergy * dtSec,
        economy.stockpile.max,
      );
      economy.expenditure = 0;

      // Metal income — base + extraction (from completed extractors
      // sitting on deposits). Unconditional, like energy.
      const totalMetal = economy.metal.income.base + economy.metal.income.extraction;
      economy.metal.stockpile.curr = Math.min(
        economy.metal.stockpile.curr + totalMetal * dtSec,
        economy.metal.stockpile.max,
      );
      economy.metal.expenditure = 0;
    }
  }

  // Record energy expenditure (called by construction system)
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
