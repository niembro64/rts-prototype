import type { EconomyState, PlayerId } from './types';
import {
  STARTING_STOCKPILE,
  MAX_STOCKPILE,
  BASE_INCOME_PER_SECOND,
  STARTING_MANA,
  MAX_MANA,
  BASE_MANA_PER_SECOND,
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
  maxMana: MAX_MANA,
  baseManaIncome: BASE_MANA_PER_SECOND,
  startingMana: STARTING_MANA,
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
    mana: {
      stockpile: { curr: ECONOMY_CONSTANTS.startingMana, max: ECONOMY_CONSTANTS.maxMana },
      income: { base: ECONOMY_CONSTANTS.baseManaIncome, territory: 0 },
      expenditure: 0,
    },
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

    economy.mana.stockpile.curr = state.mana.stockpile.curr;
    economy.mana.stockpile.max = state.mana.stockpile.max;
    economy.mana.income.base = state.mana.income.base;
    economy.mana.income.territory = state.mana.income.territory;
    economy.mana.expenditure = state.mana.expenditure;

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

  // Set mana territory income (called each tick from capture system)
  setManaTerritory(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.mana.income.territory = amount;
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

  // Check if player can afford a unified resource cost (energy + mana + metal each).
  canAfford(playerId: PlayerId, resourceCost: number): boolean {
    const economy = this.getOrCreateEconomy(playerId);
    return (
      economy.stockpile.curr >= resourceCost &&
      economy.mana.stockpile.curr >= resourceCost &&
      economy.metal.stockpile.curr >= resourceCost
    );
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

  // Try to spend mana (returns amount actually spent)
  trySpendMana(playerId: PlayerId, amount: number): number {
    const economy = this.getOrCreateEconomy(playerId);
    const actualSpend = Math.min(amount, economy.mana.stockpile.curr);
    economy.mana.stockpile.curr -= actualSpend;
    return actualSpend;
  }

  // Try to spend metal (returns amount actually spent)
  trySpendMetal(playerId: PlayerId, amount: number): number {
    const economy = this.getOrCreateEconomy(playerId);
    const actualSpend = Math.min(amount, economy.metal.stockpile.curr);
    economy.metal.stockpile.curr -= actualSpend;
    return actualSpend;
  }

  // Record mana expenditure (called by distribution system)
  recordManaExpenditure(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.mana.expenditure += amount;
  }

  // Record metal expenditure (called by distribution system)
  recordMetalExpenditure(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.metal.expenditure += amount;
  }

  // Update economy each tick (energy + mana + metal income).
  //
  // `hasCommander(playerId)` gates the BASE mana income: a team only
  // earns its passive mana drip while it still has a living commander
  // on the field. Lose your commander → mana production stops (you
  // can still spend whatever's stockpiled). Energy and metal stay
  // unconditional so a commander-less team can keep paying for solar
  // panels, existing builds, and harvesting deposits. Predicate is
  // optional — when omitted, both incomes credit unconditionally
  // (single-player sandbox / tests).
  update(dtMs: number, hasCommander?: (playerId: PlayerId) => boolean): void {
    const dtSec = dtMs / 1000;

    for (const [playerId, economy] of this.economies) {
      // Energy income — unconditional.
      const totalEnergy = economy.income.base + economy.income.production;
      economy.stockpile.curr = Math.min(
        economy.stockpile.curr + totalEnergy * dtSec,
        economy.stockpile.max,
      );
      economy.expenditure = 0;

      // Mana income — base requires a living commander; territory
      // income (capture-flag drip) keeps flowing because it's tied to
      // physical map control, not commander presence.
      const commanderAlive = hasCommander ? hasCommander(playerId) : true;
      const baseManaThisTick = commanderAlive ? economy.mana.income.base : 0;
      const totalMana = baseManaThisTick + economy.mana.income.territory;
      economy.mana.stockpile.curr = Math.min(
        economy.mana.stockpile.curr + totalMana * dtSec,
        economy.mana.stockpile.max,
      );
      economy.mana.expenditure = 0;

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
