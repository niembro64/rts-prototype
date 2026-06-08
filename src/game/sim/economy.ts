import {
  NO_ENTITY_ID,
  type EconomyState,
  type Entity,
  type EntityId,
  type PlayerId,
  type ResourceCost,
} from './types';
import {
  STARTING_STOCKPILE,
  MAX_STOCKPILE,
  BASE_INCOME_PER_SECOND,
  STARTING_METAL,
  MAX_METAL,
  BASE_METAL_PER_SECOND,
} from '../../config';
import { getUnitBlueprint } from './blueprints';
import { getBuildingConfig } from './buildConfigs';
import { isEntityActive } from './buildableHelpers';
import {
  resourceMovementSystem,
  type ResourceKind,
  type ResourceMovementReason,
} from './resourceMovement';
import { getSimWasm } from '../sim-wasm/init';
import type { WorldState } from './WorldState';

// Economy constants (using values from config.ts + blueprints)
export const ECONOMY_CONSTANTS = {
  maxStockpile: MAX_STOCKPILE,
  baseIncome: BASE_INCOME_PER_SECOND,
  startingStockpile: STARTING_STOCKPILE,
  maxMetal: MAX_METAL,
  baseMetalIncome: BASE_METAL_PER_SECOND,
  startingMetal: STARTING_METAL,
  dgunCost: getUnitBlueprint('unitCommander').dgun!.energyCost,
};

const ECONOMY_RESOURCE_ENERGY_CODE = 1;
const ECONOMY_RESOURCE_METAL_CODE = 2;
const ECONOMY_INCOME_REASON_BASE_CODE = 1;
const ECONOMY_INCOME_REASON_PRODUCTION_CODE = 2;
const DEFAULT_ECONOMY_INCOME_CAPACITY = 32;
const DEFAULT_ECONOMY_INCOME_PLAYER_CAPACITY = 8;
const DEFAULT_ECONOMY_CONVERTER_CAPACITY = 16;
const DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY = 8;

function economyResourceKindFromCode(code: number): ResourceKind | null {
  if (code === ECONOMY_RESOURCE_ENERGY_CODE) return 'energy';
  if (code === ECONOMY_RESOURCE_METAL_CODE) return 'metal';
  return null;
}

function economyIncomeReasonFromCode(code: number): ResourceMovementReason | null {
  if (code === ECONOMY_INCOME_REASON_BASE_CODE) return 'baseIncome';
  if (code === ECONOMY_INCOME_REASON_PRODUCTION_CODE) return 'production';
  return null;
}

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
  private incomePlayerIds = new Uint32Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
  private incomeResourceCodes = new Uint32Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
  private incomeRates = new Float64Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
  private incomeSourceEntityIds = new Float64Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
  private incomeReasonCodes = new Uint32Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
  private incomeEnergyCurrByPlayer = new Float64Array(DEFAULT_ECONOMY_INCOME_PLAYER_CAPACITY);
  private incomeEnergyMaxByPlayer = new Float64Array(DEFAULT_ECONOMY_INCOME_PLAYER_CAPACITY);
  private incomeMetalCurrByPlayer = new Float64Array(DEFAULT_ECONOMY_INCOME_PLAYER_CAPACITY);
  private incomeMetalMaxByPlayer = new Float64Array(DEFAULT_ECONOMY_INCOME_PLAYER_CAPACITY);
  private incomeAccepted = new Float64Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
  private converterPlayerIds = new Uint32Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
  private converterEntityIds = new Float64Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
  private converterRates = new Float64Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
  private converterEnergyCurrByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
  private converterEnergyMaxByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
  private converterMetalCurrByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
  private converterMetalMaxByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
  private converterRatesByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
  private converterConsumedByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
  private converterOutputByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
  private converterConsumedResourceByPlayer = new Uint32Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
  private converterOutputResourceByPlayer = new Uint32Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
  private converterConsumedOut = new Float64Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
  private converterOutputOut = new Float64Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
  private converterConsumedResourceOut = new Uint32Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
  private converterOutputResourceOut = new Uint32Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);

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

  /** True iff the player's energy pool holds at least `amount`. The
   *  dgun gate uses this — the dgun is paid in ENERGY only (see
   *  `spendInstant` below) so the gate must read the same pool. */
  canAffordEnergy(playerId: PlayerId, amount: number): boolean {
    return this.getOrCreateEconomy(playerId).stockpile.curr >= amount;
  }

  // Spend energy instantly (for things like D-gun)
  spendInstant(
    world: WorldState,
    playerId: PlayerId,
    amount: number,
    sourceEntityId: EntityId | null,
    targetEntityId: EntityId | null,
    reason: ResourceMovementReason,
  ): boolean {
    const economy = this.getOrCreateEconomy(playerId);
    if (economy.stockpile.curr < amount) return false;
    resourceMovementSystem.debit(economy, world, {
      playerId,
      sourceEntityId,
      targetEntityId,
      resource: 'energy',
      amount,
      amountPerSecond: 0,
      direction: 'outbound',
      reason,
    });
    return true;
  }

  addStockpile(
    world: WorldState,
    playerId: PlayerId,
    amount: ResourceCost,
    sourceEntityId: EntityId | null,
    targetEntityId: EntityId | null,
    reason: ResourceMovementReason,
    amountPerSecond: ResourceCost | null = null,
  ): ResourceCost {
    const economy = this.getOrCreateEconomy(playerId);
    const energyPerSecond = amountPerSecond === null ? 0 : amountPerSecond.energy;
    const metalPerSecond = amountPerSecond === null ? 0 : amountPerSecond.metal;
    const energy = resourceMovementSystem.credit(economy, world, {
      playerId,
      sourceEntityId,
      targetEntityId,
      resource: 'energy',
      amount: amount.energy,
      amountPerSecond: energyPerSecond,
      direction: 'inbound',
      reason,
    });
    const metal = resourceMovementSystem.credit(economy, world, {
      playerId,
      sourceEntityId,
      targetEntityId,
      resource: 'metal',
      amount: amount.metal,
      amountPerSecond: metalPerSecond,
      direction: 'inbound',
      reason,
    });
    return { energy, metal };
  }

  // Record metal expenditure (called by distribution system)
  recordMetalExpenditure(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.metal.expenditure += amount;
  }

  // Update economy each tick (energy + metal income).
  update(world: WorldState, dtMs: number, windSpeed: number): void {
    const dtSec = dtMs / 1000;
    let incomeCount = 0;
    let maxPlayerId = 0;

    for (const [playerId, economy] of this.economies) {
      economy.expenditure = 0;
      economy.metal.expenditure = 0;
      if (dtSec <= 0) continue;
      if (this.queueIncomeCredit(
        playerId,
        ECONOMY_RESOURCE_ENERGY_CODE,
        economy.income.base,
        NO_ENTITY_ID,
        ECONOMY_INCOME_REASON_BASE_CODE,
        incomeCount,
      )) {
        incomeCount++;
        if (playerId > maxPlayerId) maxPlayerId = playerId;
      }
      if (this.queueIncomeCredit(
        playerId,
        ECONOMY_RESOURCE_METAL_CODE,
        economy.metal.income.base,
        NO_ENTITY_ID,
        ECONOMY_INCOME_REASON_BASE_CODE,
        incomeCount,
      )) {
        incomeCount++;
        if (playerId > maxPlayerId) maxPlayerId = playerId;
      }
    }

    if (dtSec <= 0) return;
    this.applyIncomeCredits(world, dtSec, windSpeed, incomeCount, maxPlayerId);
  }

  private applyIncomeCredits(
    world: WorldState,
    dtSec: number,
    windSpeed: number,
    incomeCount: number,
    maxPlayerId: number,
  ): void {
    const solarRate = getBuildingConfig('buildingSolar').energyProduction ?? 0;
    if (solarRate > 0) {
      for (const entity of world.getSolarBuildings()) {
        const playerId = this.queueProducerCredit(
          entity,
          ECONOMY_RESOURCE_ENERGY_CODE,
          solarRate,
          incomeCount,
        );
        if (playerId === 0) continue;
        incomeCount++;
        if (playerId > maxPlayerId) maxPlayerId = playerId;
      }
    }

    const windRateBase = getBuildingConfig('buildingWind').energyProduction ?? 0;
    const windRate = windRateBase * windSpeed;
    if (windRate > 0) {
      for (const entity of world.getWindBuildings()) {
        const playerId = this.queueProducerCredit(
          entity,
          ECONOMY_RESOURCE_ENERGY_CODE,
          windRate,
          incomeCount,
        );
        if (playerId === 0) continue;
        incomeCount++;
        if (playerId > maxPlayerId) maxPlayerId = playerId;
      }
    }

    for (const entity of world.getExtractorBuildings()) {
      const metalRate = entity.metalExtractionRate ?? 0;
      if (metalRate <= 0) continue;
      const playerId = this.queueProducerCredit(
        entity,
        ECONOMY_RESOURCE_METAL_CODE,
        metalRate,
        incomeCount,
      );
      if (playerId === 0) continue;
      incomeCount++;
      if (playerId > maxPlayerId) maxPlayerId = playerId;
    }

    if (incomeCount <= 0) return;
    this.ensureIncomePlayerCapacity(maxPlayerId);
    for (let playerId = 1; playerId <= maxPlayerId; playerId++) {
      const economy = this.economies.get(playerId as PlayerId);
      if (economy === undefined) {
        this.incomeEnergyCurrByPlayer[playerId] = 0;
        this.incomeEnergyMaxByPlayer[playerId] = 0;
        this.incomeMetalCurrByPlayer[playerId] = 0;
        this.incomeMetalMaxByPlayer[playerId] = 0;
        continue;
      }
      this.incomeEnergyCurrByPlayer[playerId] = economy.stockpile.curr;
      this.incomeEnergyMaxByPlayer[playerId] = economy.stockpile.max;
      this.incomeMetalCurrByPlayer[playerId] = economy.metal.stockpile.curr;
      this.incomeMetalMaxByPlayer[playerId] = economy.metal.stockpile.max;
    }

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('EconomyManager.applyIncomeCredits: sim-wasm is not initialized');
    }
    const maxExclusive = sim.economyApplyIncomeCredits(
      this.incomePlayerIds,
      this.incomeResourceCodes,
      this.incomeRates,
      incomeCount,
      dtSec,
      this.incomeEnergyCurrByPlayer,
      this.incomeEnergyMaxByPlayer,
      this.incomeMetalCurrByPlayer,
      this.incomeMetalMaxByPlayer,
      this.incomeAccepted,
    );
    if (maxExclusive === 0) {
      throw new Error('EconomyManager.applyIncomeCredits: economy_apply_income_credits rejected its buffers');
    }

    for (let playerId = 1; playerId < maxExclusive; playerId++) {
      const economy = this.economies.get(playerId as PlayerId);
      if (economy === undefined) continue;
      economy.stockpile.curr = this.incomeEnergyCurrByPlayer[playerId];
      economy.metal.stockpile.curr = this.incomeMetalCurrByPlayer[playerId];
    }

    for (let i = 0; i < incomeCount; i++) {
      const accepted = this.incomeAccepted[i];
      if (accepted <= 0) continue;
      const resource = economyResourceKindFromCode(this.incomeResourceCodes[i]);
      if (resource === null) {
        throw new Error('EconomyManager.applyIncomeCredits: unknown income resource code');
      }
      const reason = economyIncomeReasonFromCode(this.incomeReasonCodes[i]);
      if (reason === null) {
        throw new Error('EconomyManager.applyIncomeCredits: unknown income reason code');
      }
      const sourceEntityId = this.incomeSourceEntityIds[i];
      const requested = this.incomeRates[i] * dtSec;
      resourceMovementSystem.recordAppliedCredit(
        world,
        {
          playerId: this.incomePlayerIds[i] as PlayerId,
          sourceEntityId: sourceEntityId === NO_ENTITY_ID ? null : sourceEntityId as EntityId,
          targetEntityId: null,
          resource,
          amount: requested,
          amountPerSecond: this.incomeRates[i],
          direction: 'inbound',
          reason,
        },
        accepted,
      );
    }
  }

  private queueProducerCredit(
    entity: Entity,
    resourceCode: number,
    ratePerSecond: number,
    index: number,
  ): PlayerId | 0 {
    if (
      !Number.isFinite(ratePerSecond)
      || ratePerSecond <= 0
      || !this.isOpenProducerBuilding(entity)
    ) {
      return 0;
    }
    const ownership = entity.ownership;
    if (ownership === null) return 0;
    if (!this.economies.has(ownership.playerId)) return 0;

    return this.queueIncomeCredit(
      ownership.playerId,
      resourceCode,
      ratePerSecond,
      entity.id,
      ECONOMY_INCOME_REASON_PRODUCTION_CODE,
      index,
    ) ? ownership.playerId : 0;
  }

  private queueIncomeCredit(
    playerId: PlayerId,
    resourceCode: number,
    ratePerSecond: number,
    sourceEntityId: EntityId,
    reasonCode: number,
    index: number,
  ): boolean {
    if (playerId <= 0) return false;
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) return false;
    this.ensureIncomeCapacity(index + 1);
    this.incomePlayerIds[index] = playerId;
    this.incomeResourceCodes[index] = resourceCode;
    this.incomeRates[index] = ratePerSecond;
    this.incomeSourceEntityIds[index] = sourceEntityId;
    this.incomeReasonCodes[index] = reasonCode;
    return true;
  }

  private isOpenProducerBuilding(entity: Entity): boolean {
    const ownership = entity.ownership;
    const building = entity.building;
    if (ownership === null || building === null) return false;
    if (building.hp <= 0 || !isEntityActive(entity)) return false;
    const activeState = building.activeState;
    return activeState === null || activeState.open;
  }

  // Record energy expenditure (called by construction system)
  recordExpenditure(playerId: PlayerId, amount: number): void {
    const economy = this.getOrCreateEconomy(playerId);
    economy.expenditure += amount;
  }

  /** Per-tick conversion pass for resource converter buildings. Each
   *  completed converter contributes its blueprint conversionRate to
   *  its owner's per-second source-resource throughput; whichever
   *  resource the owner currently has more of is consumed at that rate
   *  and the other resource is credited at `consumed * (1 - tax)`. Idle
   *  when the two stockpiles are equal. */
  processConverters(world: WorldState, dtMs: number): void {
    const dtSec = dtMs / 1000;
    if (dtSec <= 0) return;
    const tax = world.converterTax;
    const ratePerSec = getBuildingConfig('buildingResourceConverter').conversionRate ?? 0;
    if (ratePerSec <= 0) return;

    let converterCount = 0;
    let maxPlayerId = 0;
    for (const entity of world.getConverterBuildings()) {
      const ownership = entity.ownership;
      const building = entity.building;
      if (ownership === null || building === null) continue;
      if (building.hp <= 0) continue;
      if (!isEntityActive(entity)) continue;
      // ON/OFF gate. A closed (OFF) converter pays no energy and
      // produces no metal, mirroring solar/wind/extractor behavior
      // (see budget_design_philosophy.html "Producer Buildings Are ON/OFF").
      const activeState = building.activeState;
      if (activeState !== null && activeState.open === false) continue;
      const pid = ownership.playerId;
      this.ensureConverterCapacity(converterCount + 1);
      this.converterPlayerIds[converterCount] = pid;
      this.converterEntityIds[converterCount] = entity.id;
      this.converterRates[converterCount] = ratePerSec;
      converterCount++;
      if (pid > maxPlayerId) maxPlayerId = pid;
    }

    if (converterCount <= 0) return;
    this.ensureConverterPlayerCapacity(maxPlayerId);
    for (let playerId = 1; playerId <= maxPlayerId; playerId++) {
      const economy = this.economies.get(playerId as PlayerId);
      if (economy === undefined) {
        this.converterEnergyCurrByPlayer[playerId] = 0;
        this.converterEnergyMaxByPlayer[playerId] = 0;
        this.converterMetalCurrByPlayer[playerId] = 0;
        this.converterMetalMaxByPlayer[playerId] = 0;
        continue;
      }
      this.converterEnergyCurrByPlayer[playerId] = economy.stockpile.curr;
      this.converterEnergyMaxByPlayer[playerId] = economy.stockpile.max;
      this.converterMetalCurrByPlayer[playerId] = economy.metal.stockpile.curr;
      this.converterMetalMaxByPlayer[playerId] = economy.metal.stockpile.max;
    }

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('EconomyManager.processConverters: sim-wasm is not initialized');
    }
    const maxExclusive = sim.economyApplyConverterTransfers(
      this.converterPlayerIds,
      this.converterRates,
      converterCount,
      dtSec,
      tax,
      this.converterEnergyCurrByPlayer,
      this.converterEnergyMaxByPlayer,
      this.converterMetalCurrByPlayer,
      this.converterMetalMaxByPlayer,
      this.converterRatesByPlayer,
      this.converterConsumedByPlayer,
      this.converterOutputByPlayer,
      this.converterConsumedResourceByPlayer,
      this.converterOutputResourceByPlayer,
      this.converterConsumedOut,
      this.converterOutputOut,
      this.converterConsumedResourceOut,
      this.converterOutputResourceOut,
    );
    if (maxExclusive === 0) {
      throw new Error('EconomyManager.processConverters: economy_apply_converter_transfers rejected its buffers');
    }

    for (let playerId = 1; playerId < maxExclusive; playerId++) {
      const economy = this.economies.get(playerId as PlayerId);
      if (economy === undefined) continue;
      economy.stockpile.curr = this.converterEnergyCurrByPlayer[playerId];
      economy.metal.stockpile.curr = this.converterMetalCurrByPlayer[playerId];
    }

    for (let i = 0; i < converterCount; i++) {
      const playerId = this.converterPlayerIds[i] as PlayerId;
      if (!this.economies.has(playerId)) continue;
      const consumedShare = this.converterConsumedOut[i];
      const outputShare = this.converterOutputOut[i];
      if (consumedShare > 0) {
        const consumedResource = economyResourceKindFromCode(this.converterConsumedResourceOut[i]);
        if (consumedResource === null) {
          throw new Error('EconomyManager.processConverters: economy_apply_converter_transfers returned an unknown consumed resource code');
        }
        resourceMovementSystem.recordAppliedDebit(world, {
          playerId,
          sourceEntityId: this.converterEntityIds[i] as EntityId,
          targetEntityId: null,
          resource: consumedResource,
          amount: consumedShare,
          amountPerSecond: dtSec > 0 ? consumedShare / dtSec : 0,
          direction: 'outbound',
          reason: 'conversion',
        }, consumedShare);
      }
      if (outputShare > 0) {
        const outputResource = economyResourceKindFromCode(this.converterOutputResourceOut[i]);
        if (outputResource === null) {
          throw new Error('EconomyManager.processConverters: economy_apply_converter_transfers returned an unknown output resource code');
        }
        resourceMovementSystem.recordAppliedCredit(world, {
          playerId,
          sourceEntityId: this.converterEntityIds[i] as EntityId,
          targetEntityId: null,
          resource: outputResource,
          amount: outputShare,
          amountPerSecond: dtSec > 0 ? outputShare / dtSec : 0,
          direction: 'inbound',
          reason: 'conversion',
        }, outputShare);
      }
    }
  }

  private ensureConverterCapacity(count: number): void {
    if (count <= this.converterPlayerIds.length) return;
    let nextCapacity = this.converterPlayerIds.length;
    while (nextCapacity < count) nextCapacity *= 2;

    const nextPlayerIds = new Uint32Array(nextCapacity);
    nextPlayerIds.set(this.converterPlayerIds);
    this.converterPlayerIds = nextPlayerIds;

    const nextEntityIds = new Float64Array(nextCapacity);
    nextEntityIds.set(this.converterEntityIds);
    this.converterEntityIds = nextEntityIds;

    const nextRates = new Float64Array(nextCapacity);
    nextRates.set(this.converterRates);
    this.converterRates = nextRates;

    const nextConsumedOut = new Float64Array(nextCapacity);
    nextConsumedOut.set(this.converterConsumedOut);
    this.converterConsumedOut = nextConsumedOut;

    const nextOutputOut = new Float64Array(nextCapacity);
    nextOutputOut.set(this.converterOutputOut);
    this.converterOutputOut = nextOutputOut;

    const nextConsumedResourceOut = new Uint32Array(nextCapacity);
    nextConsumedResourceOut.set(this.converterConsumedResourceOut);
    this.converterConsumedResourceOut = nextConsumedResourceOut;

    const nextOutputResourceOut = new Uint32Array(nextCapacity);
    nextOutputResourceOut.set(this.converterOutputResourceOut);
    this.converterOutputResourceOut = nextOutputResourceOut;
  }

  private ensureIncomeCapacity(count: number): void {
    if (count <= this.incomePlayerIds.length) return;
    let nextCapacity = this.incomePlayerIds.length;
    while (nextCapacity < count) nextCapacity *= 2;

    const nextPlayerIds = new Uint32Array(nextCapacity);
    nextPlayerIds.set(this.incomePlayerIds);
    this.incomePlayerIds = nextPlayerIds;

    const nextResourceCodes = new Uint32Array(nextCapacity);
    nextResourceCodes.set(this.incomeResourceCodes);
    this.incomeResourceCodes = nextResourceCodes;

    const nextRates = new Float64Array(nextCapacity);
    nextRates.set(this.incomeRates);
    this.incomeRates = nextRates;

    const nextEntityIds = new Float64Array(nextCapacity);
    nextEntityIds.set(this.incomeSourceEntityIds);
    this.incomeSourceEntityIds = nextEntityIds;

    const nextReasonCodes = new Uint32Array(nextCapacity);
    nextReasonCodes.set(this.incomeReasonCodes);
    this.incomeReasonCodes = nextReasonCodes;

    const nextAccepted = new Float64Array(nextCapacity);
    nextAccepted.set(this.incomeAccepted);
    this.incomeAccepted = nextAccepted;
  }

  private ensureIncomePlayerCapacity(playerId: number): void {
    if (playerId < this.incomeEnergyCurrByPlayer.length) return;
    let nextCapacity = this.incomeEnergyCurrByPlayer.length;
    while (nextCapacity <= playerId) nextCapacity *= 2;
    this.incomeEnergyCurrByPlayer = new Float64Array(nextCapacity);
    this.incomeEnergyMaxByPlayer = new Float64Array(nextCapacity);
    this.incomeMetalCurrByPlayer = new Float64Array(nextCapacity);
    this.incomeMetalMaxByPlayer = new Float64Array(nextCapacity);
  }

  private ensureConverterPlayerCapacity(playerId: number): void {
    if (playerId < this.converterRatesByPlayer.length) return;
    let nextCapacity = this.converterRatesByPlayer.length;
    while (nextCapacity <= playerId) nextCapacity *= 2;
    this.converterRatesByPlayer = new Float64Array(nextCapacity);
    this.converterEnergyCurrByPlayer = new Float64Array(nextCapacity);
    this.converterEnergyMaxByPlayer = new Float64Array(nextCapacity);
    this.converterMetalCurrByPlayer = new Float64Array(nextCapacity);
    this.converterMetalMaxByPlayer = new Float64Array(nextCapacity);
    this.converterConsumedByPlayer = new Float64Array(nextCapacity);
    this.converterOutputByPlayer = new Float64Array(nextCapacity);
    this.converterConsumedResourceByPlayer = new Uint32Array(nextCapacity);
    this.converterOutputResourceByPlayer = new Uint32Array(nextCapacity);
  }

  private trimBatchBuffers(): void {
    this.incomePlayerIds = new Uint32Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
    this.incomeResourceCodes = new Uint32Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
    this.incomeRates = new Float64Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
    this.incomeSourceEntityIds = new Float64Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
    this.incomeReasonCodes = new Uint32Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
    this.incomeEnergyCurrByPlayer = new Float64Array(DEFAULT_ECONOMY_INCOME_PLAYER_CAPACITY);
    this.incomeEnergyMaxByPlayer = new Float64Array(DEFAULT_ECONOMY_INCOME_PLAYER_CAPACITY);
    this.incomeMetalCurrByPlayer = new Float64Array(DEFAULT_ECONOMY_INCOME_PLAYER_CAPACITY);
    this.incomeMetalMaxByPlayer = new Float64Array(DEFAULT_ECONOMY_INCOME_PLAYER_CAPACITY);
    this.incomeAccepted = new Float64Array(DEFAULT_ECONOMY_INCOME_CAPACITY);
    this.converterPlayerIds = new Uint32Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
    this.converterEntityIds = new Float64Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
    this.converterRates = new Float64Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
    this.converterEnergyCurrByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
    this.converterEnergyMaxByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
    this.converterMetalCurrByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
    this.converterMetalMaxByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
    this.converterRatesByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
    this.converterConsumedByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
    this.converterOutputByPlayer = new Float64Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
    this.converterConsumedResourceByPlayer = new Uint32Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
    this.converterOutputResourceByPlayer = new Uint32Array(DEFAULT_ECONOMY_CONVERTER_PLAYER_CAPACITY);
    this.converterConsumedOut = new Float64Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
    this.converterOutputOut = new Float64Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
    this.converterConsumedResourceOut = new Uint32Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
    this.converterOutputResourceOut = new Uint32Array(DEFAULT_ECONOMY_CONVERTER_CAPACITY);
  }

  // Reset all state (call between game sessions)
  reset(): void {
    this.economies.clear();
    this.trimBatchBuffers();
  }
}

// Singleton instance
export const economyManager = new EconomyManager();
