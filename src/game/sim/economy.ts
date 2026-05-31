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

const CONVERTER_RESOURCE_ENERGY = 1;
const CONVERTER_RESOURCE_METAL = 2;

function converterResourceKindFromCode(code: number): ResourceKind | null {
  if (code === CONVERTER_RESOURCE_ENERGY) return 'energy';
  if (code === CONVERTER_RESOURCE_METAL) return 'metal';
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
  private converterPlayerIds = new Uint32Array(16);
  private converterRates = new Float64Array(16);
  private converterRatesByPlayer = new Float64Array(8);
  private converterTransferOut = new Float64Array(4);

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
    const solarRate = getBuildingConfig('buildingSolar').energyProduction ?? 0;
    if (solarRate > 0) {
      for (const entity of world.getSolarBuildings()) {
        if (!this.isOpenProducerBuilding(entity)) continue;
        const ownership = entity.ownership;
        if (ownership === null) continue;
        const economy = this.economies.get(ownership.playerId);
        if (!economy) continue;
        this.creditResource(
          world,
          economy,
          ownership.playerId,
          'energy',
          solarRate * dtSec,
          solarRate,
          entity.id,
          null,
          'inbound',
          'production',
        );
      }
    }

    const windRateBase = getBuildingConfig('buildingWind').energyProduction ?? 0;
    const windRate = windRateBase * windSpeed;
    if (windRate > 0) {
      for (const entity of world.getWindBuildings()) {
        if (!this.isOpenProducerBuilding(entity)) continue;
        const ownership = entity.ownership;
        if (ownership === null) continue;
        const economy = this.economies.get(ownership.playerId);
        if (!economy) continue;
        this.creditResource(
          world,
          economy,
          ownership.playerId,
          'energy',
          windRate * dtSec,
          windRate,
          entity.id,
          null,
          'inbound',
          'production',
        );
      }
    }

    for (const entity of world.getExtractorBuildings()) {
      if (!this.isOpenProducerBuilding(entity)) continue;
      const ownership = entity.ownership;
      if (ownership === null) continue;
      const metalRate = entity.metalExtractionRate ?? 0;
      if (metalRate <= 0) continue;
      const economy = this.economies.get(ownership.playerId);
      if (!economy) continue;
      this.creditResource(
        world,
        economy,
        ownership.playerId,
        'metal',
        metalRate * dtSec,
        metalRate,
        entity.id,
        null,
        'inbound',
        'production',
      );
    }
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
      this.converterRates[converterCount] = ratePerSec;
      converterCount++;
      if (pid > maxPlayerId) maxPlayerId = pid;
    }

    if (converterCount <= 0) return;
    this.ensureConverterPlayerRateCapacity(maxPlayerId);
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('EconomyManager.processConverters: sim-wasm is not initialized');
    }
    const maxExclusive = sim.economyAccumulatePlayerRates(
      this.converterPlayerIds,
      this.converterRates,
      converterCount,
      this.converterRatesByPlayer,
    );

    for (let playerId = 1; playerId < maxExclusive; playerId++) {
      const totalRate = this.converterRatesByPlayer[playerId];
      if (totalRate <= 0) continue;
      const pid = playerId as PlayerId;
      const economy = this.economies.get(pid);
      if (!economy) continue;

      if (sim.economyComputeConverterTransfer(
        economy.stockpile.curr,
        economy.stockpile.max,
        economy.metal.stockpile.curr,
        economy.metal.stockpile.max,
        totalRate,
        dtSec,
        tax,
        this.converterTransferOut,
      ) === 0) {
        throw new Error('EconomyManager.processConverters: economy_compute_converter_transfer rejected its output buffer');
      }
      const consumed = this.converterTransferOut[0];
      const acceptedOutput = this.converterTransferOut[1];
      if (consumed <= 0 || acceptedOutput <= 0) continue;
      const consumedResource = converterResourceKindFromCode(this.converterTransferOut[2]);
      const outputResource = converterResourceKindFromCode(this.converterTransferOut[3]);
      if (consumedResource === null || outputResource === null) {
        throw new Error('EconomyManager.processConverters: economy_compute_converter_transfer returned an unknown resource code');
      }
      this.applyConverterMovements(
        world,
        pid,
        totalRate,
        ratePerSec,
        consumed,
        acceptedOutput,
        consumedResource,
        outputResource,
        dtSec,
      );
    }
  }

  private applyConverterMovements(
    world: WorldState,
    playerId: PlayerId,
    totalRate: number,
    ratePerSec: number,
    consumed: number,
    acceptedOutput: number,
    consumedResource: ResourceKind,
    outputResource: ResourceKind,
    dtSec: number,
  ): void {
    const economy = this.economies.get(playerId);
    if (!economy) return;
    let remainingRate = totalRate;
    let remainingConsumed = consumed;
    let remainingOutput = acceptedOutput;
    for (const entity of world.getConverterBuildings()) {
      if (!this.isActiveConverterForPlayer(entity, playerId)) continue;
      const finalShare = remainingRate <= ratePerSec;
      const consumedShare = finalShare
        ? remainingConsumed
        : Math.min(remainingConsumed, consumed * (ratePerSec / totalRate));
      const outputShare = finalShare
        ? remainingOutput
        : Math.min(remainingOutput, acceptedOutput * (ratePerSec / totalRate));
      if (consumedShare > 0) {
        resourceMovementSystem.debit(economy, world, {
          playerId,
          sourceEntityId: entity.id,
          targetEntityId: null,
          resource: consumedResource,
          amount: consumedShare,
          amountPerSecond: dtSec > 0 ? consumedShare / dtSec : 0,
          direction: 'outbound',
          reason: 'conversion',
        });
        remainingConsumed -= consumedShare;
      }
      if (outputShare > 0) {
        resourceMovementSystem.credit(economy, world, {
          playerId,
          sourceEntityId: entity.id,
          targetEntityId: null,
          resource: outputResource,
          amount: outputShare,
          amountPerSecond: dtSec > 0 ? outputShare / dtSec : 0,
          direction: 'inbound',
          reason: 'conversion',
        });
        remainingOutput -= outputShare;
      }
      remainingRate -= ratePerSec;
      if (remainingRate <= 0) break;
    }
  }

  private isActiveConverterForPlayer(entity: Entity, playerId: PlayerId): boolean {
    const ownership = entity.ownership;
    const building = entity.building;
    if (ownership === null || building === null) return false;
    const activeState = building.activeState;
    return ownership.playerId === playerId
      && building.hp > 0
      && isEntityActive(entity)
      && (activeState === null || activeState.open);
  }

  private ensureConverterCapacity(count: number): void {
    if (count <= this.converterPlayerIds.length) return;
    let nextCapacity = this.converterPlayerIds.length;
    while (nextCapacity < count) nextCapacity *= 2;

    const nextPlayerIds = new Uint32Array(nextCapacity);
    nextPlayerIds.set(this.converterPlayerIds);
    this.converterPlayerIds = nextPlayerIds;

    const nextRates = new Float64Array(nextCapacity);
    nextRates.set(this.converterRates);
    this.converterRates = nextRates;
  }

  private ensureConverterPlayerRateCapacity(playerId: number): void {
    if (playerId < this.converterRatesByPlayer.length) return;
    let nextCapacity = this.converterRatesByPlayer.length;
    while (nextCapacity <= playerId) nextCapacity *= 2;
    this.converterRatesByPlayer = new Float64Array(nextCapacity);
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
