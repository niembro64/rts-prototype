import type { EconomyState, Entity, EntityId, PlayerId, ResourceCost } from './types';
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
  type ResourceMovementDirection,
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

function economyResourceKindFromCode(code: number): ResourceKind | null {
  if (code === ECONOMY_RESOURCE_ENERGY_CODE) return 'energy';
  if (code === ECONOMY_RESOURCE_METAL_CODE) return 'metal';
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
  private producerPlayerIds = new Uint32Array(32);
  private producerResourceCodes = new Uint32Array(32);
  private producerRates = new Float64Array(32);
  private producerEntityIds = new Float64Array(32);
  private producerEnergyCurrByPlayer = new Float64Array(8);
  private producerEnergyMaxByPlayer = new Float64Array(8);
  private producerMetalCurrByPlayer = new Float64Array(8);
  private producerMetalMaxByPlayer = new Float64Array(8);
  private producerAccepted = new Float64Array(32);
  private converterPlayerIds = new Uint32Array(16);
  private converterEntityIds = new Float64Array(16);
  private converterRates = new Float64Array(16);
  private converterEnergyCurrByPlayer = new Float64Array(8);
  private converterEnergyMaxByPlayer = new Float64Array(8);
  private converterMetalCurrByPlayer = new Float64Array(8);
  private converterMetalMaxByPlayer = new Float64Array(8);
  private converterRatesByPlayer = new Float64Array(8);
  private converterConsumedByPlayer = new Float64Array(8);
  private converterOutputByPlayer = new Float64Array(8);
  private converterConsumedResourceByPlayer = new Uint32Array(8);
  private converterOutputResourceByPlayer = new Uint32Array(8);
  private converterConsumedOut = new Float64Array(16);
  private converterOutputOut = new Float64Array(16);
  private converterConsumedResourceOut = new Uint32Array(16);
  private converterOutputResourceOut = new Uint32Array(16);

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
    const energy = resourceMovementSystem.credit(economy, world, {
      playerId,
      sourceEntityId,
      targetEntityId,
      resource: 'energy',
      amount: amount.energy,
      amountPerSecond: amountPerSecond?.energy ?? 0,
      direction: 'inbound',
      reason,
    });
    const metal = resourceMovementSystem.credit(economy, world, {
      playerId,
      sourceEntityId,
      targetEntityId,
      resource: 'metal',
      amount: amount.metal,
      amountPerSecond: amountPerSecond?.metal ?? 0,
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

    for (const [playerId, economy] of this.economies) {
      economy.expenditure = 0;
      economy.metal.expenditure = 0;
      this.creditResource(
        world,
        economy,
        playerId,
        'energy',
        economy.income.base * dtSec,
        economy.income.base,
        null,
        null,
        'inbound',
        'baseIncome',
      );
      this.creditResource(
        world,
        economy,
        playerId,
        'metal',
        economy.metal.income.base * dtSec,
        economy.metal.income.base,
        null,
        null,
        'inbound',
        'baseIncome',
      );
    }

    if (dtSec <= 0) return;
    this.applyProducerIncome(world, dtSec, windSpeed);
  }

  private applyProducerIncome(world: WorldState, dtSec: number, windSpeed: number): void {
    let producerCount = 0;
    let maxPlayerId = 0;

    const solarRate = getBuildingConfig('buildingSolar').energyProduction ?? 0;
    if (solarRate > 0) {
      for (const entity of world.getSolarBuildings()) {
        const playerId = this.queueProducerCredit(
          entity,
          ECONOMY_RESOURCE_ENERGY_CODE,
          solarRate,
          producerCount,
        );
        if (playerId === 0) continue;
        producerCount++;
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
          producerCount,
        );
        if (playerId === 0) continue;
        producerCount++;
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
        producerCount,
      );
      if (playerId === 0) continue;
      producerCount++;
      if (playerId > maxPlayerId) maxPlayerId = playerId;
    }

    if (producerCount <= 0) return;
    this.ensureProducerPlayerCapacity(maxPlayerId);
    for (let playerId = 1; playerId <= maxPlayerId; playerId++) {
      const economy = this.economies.get(playerId as PlayerId);
      if (economy === undefined) {
        this.producerEnergyCurrByPlayer[playerId] = 0;
        this.producerEnergyMaxByPlayer[playerId] = 0;
        this.producerMetalCurrByPlayer[playerId] = 0;
        this.producerMetalMaxByPlayer[playerId] = 0;
        continue;
      }
      this.producerEnergyCurrByPlayer[playerId] = economy.stockpile.curr;
      this.producerEnergyMaxByPlayer[playerId] = economy.stockpile.max;
      this.producerMetalCurrByPlayer[playerId] = economy.metal.stockpile.curr;
      this.producerMetalMaxByPlayer[playerId] = economy.metal.stockpile.max;
    }

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('EconomyManager.applyProducerIncome: sim-wasm is not initialized');
    }
    const maxExclusive = sim.economyApplyProducerCredits(
      this.producerPlayerIds,
      this.producerResourceCodes,
      this.producerRates,
      producerCount,
      dtSec,
      this.producerEnergyCurrByPlayer,
      this.producerEnergyMaxByPlayer,
      this.producerMetalCurrByPlayer,
      this.producerMetalMaxByPlayer,
      this.producerAccepted,
    );
    if (maxExclusive === 0) {
      throw new Error('EconomyManager.applyProducerIncome: economy_apply_producer_credits rejected its buffers');
    }

    for (let playerId = 1; playerId < maxExclusive; playerId++) {
      const economy = this.economies.get(playerId as PlayerId);
      if (economy === undefined) continue;
      economy.stockpile.curr = this.producerEnergyCurrByPlayer[playerId];
      economy.metal.stockpile.curr = this.producerMetalCurrByPlayer[playerId];
    }

    for (let i = 0; i < producerCount; i++) {
      const accepted = this.producerAccepted[i];
      if (accepted <= 0) continue;
      const resource = economyResourceKindFromCode(this.producerResourceCodes[i]);
      if (resource === null) {
        throw new Error('EconomyManager.applyProducerIncome: unknown producer resource code');
      }
      const requested = this.producerRates[i] * dtSec;
      resourceMovementSystem.recordAppliedCredit(
        world,
        {
          playerId: this.producerPlayerIds[i] as PlayerId,
          sourceEntityId: this.producerEntityIds[i] as EntityId,
          targetEntityId: null,
          resource,
          amount: requested,
          amountPerSecond: this.producerRates[i],
          direction: 'inbound',
          reason: 'production',
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

    this.ensureProducerCapacity(index + 1);
    this.producerPlayerIds[index] = ownership.playerId;
    this.producerResourceCodes[index] = resourceCode;
    this.producerRates[index] = ratePerSecond;
    this.producerEntityIds[index] = entity.id;
    return ownership.playerId;
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
      // (see design_philosophy.html "Producer Buildings Are ON/OFF").
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

  private ensureProducerCapacity(count: number): void {
    if (count <= this.producerPlayerIds.length) return;
    let nextCapacity = this.producerPlayerIds.length;
    while (nextCapacity < count) nextCapacity *= 2;

    const nextPlayerIds = new Uint32Array(nextCapacity);
    nextPlayerIds.set(this.producerPlayerIds);
    this.producerPlayerIds = nextPlayerIds;

    const nextResourceCodes = new Uint32Array(nextCapacity);
    nextResourceCodes.set(this.producerResourceCodes);
    this.producerResourceCodes = nextResourceCodes;

    const nextRates = new Float64Array(nextCapacity);
    nextRates.set(this.producerRates);
    this.producerRates = nextRates;

    const nextEntityIds = new Float64Array(nextCapacity);
    nextEntityIds.set(this.producerEntityIds);
    this.producerEntityIds = nextEntityIds;

    const nextAccepted = new Float64Array(nextCapacity);
    nextAccepted.set(this.producerAccepted);
    this.producerAccepted = nextAccepted;
  }

  private ensureProducerPlayerCapacity(playerId: number): void {
    if (playerId < this.producerEnergyCurrByPlayer.length) return;
    let nextCapacity = this.producerEnergyCurrByPlayer.length;
    while (nextCapacity <= playerId) nextCapacity *= 2;
    this.producerEnergyCurrByPlayer = new Float64Array(nextCapacity);
    this.producerEnergyMaxByPlayer = new Float64Array(nextCapacity);
    this.producerMetalCurrByPlayer = new Float64Array(nextCapacity);
    this.producerMetalMaxByPlayer = new Float64Array(nextCapacity);
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

  private creditResource(
    world: WorldState,
    economy: EconomyState,
    playerId: PlayerId,
    resource: ResourceKind,
    amount: number,
    amountPerSecond: number,
    sourceEntityId: EntityId | null,
    targetEntityId: EntityId | null,
    direction: ResourceMovementDirection,
    reason: ResourceMovementReason,
  ): number {
    return resourceMovementSystem.credit(economy, world, {
      playerId,
      sourceEntityId,
      targetEntityId,
      resource,
      amount,
      amountPerSecond,
      direction,
      reason,
    });
  }

  // Reset all state (call between game sessions)
  reset(): void {
    this.economies.clear();
  }
}

// Singleton instance
export const economyManager = new EconomyManager();
