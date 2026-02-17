// Combat Stats Tracker - accumulates per-player, per-unit-type combat performance data

import type { EntityId, PlayerId } from './types';
import type { WorldState } from './WorldState';
import { UNIT_DEFINITIONS } from './unitDefinitions';

export interface UnitTypeStats {
  enemyDamageDealt: number;
  enemyKills: number;
  friendlyDamageDealt: number;
  friendlyKills: number;
  unitsProduced: number;
  unitsLost: number;
  totalCostSpent: number;
}

export interface CombatStatsSnapshot {
  players: Record<number, Record<string, UnitTypeStats>>;
  global: Record<string, UnitTypeStats>;
}

function createEmptyStats(): UnitTypeStats {
  return {
    enemyDamageDealt: 0, enemyKills: 0,
    friendlyDamageDealt: 0, friendlyKills: 0,
    unitsProduced: 0, unitsLost: 0, totalCostSpent: 0,
  };
}

export class CombatStatsTracker {
  private stats: Map<PlayerId, Map<string, UnitTypeStats>> = new Map();
  private world: WorldState;
  // Registry persists entity identity after death so posthumous projectile
  // damage can still be attributed to the correct player + unit type.
  private entityRegistry: Map<EntityId, { playerId: PlayerId; unitType: string }> = new Map();

  constructor(world: WorldState) {
    this.world = world;
  }

  private getOrCreate(playerId: PlayerId, unitType: string): UnitTypeStats {
    let playerStats = this.stats.get(playerId);
    if (!playerStats) {
      playerStats = new Map();
      this.stats.set(playerId, playerStats);
    }
    let typeStats = playerStats.get(unitType);
    if (!typeStats) {
      typeStats = createEmptyStats();
      playerStats.set(unitType, typeStats);
    }
    return typeStats;
  }

  /** Look up source entity's player and unit type, falling back to registry for dead units. */
  private resolveSource(sourceEntityId: EntityId): { playerId: PlayerId; unitType: string } | null {
    const entity = this.world.getEntity(sourceEntityId);
    if (entity?.unit?.unitType && entity.ownership) {
      return { playerId: entity.ownership.playerId, unitType: entity.unit.unitType };
    }
    return this.entityRegistry.get(sourceEntityId) ?? null;
  }

  private isFriendly(sourcePlayerId: PlayerId, targetEntityId: EntityId): boolean {
    const target = this.world.getEntity(targetEntityId);
    return target?.ownership?.playerId === sourcePlayerId;
  }

  /** Register an entity so its identity survives removal from the world. */
  registerEntity(entityId: EntityId, playerId: PlayerId, unitType: string): void {
    this.entityRegistry.set(entityId, { playerId, unitType });
  }

  recordDamage(sourceEntityId: EntityId, targetEntityId: EntityId, damageAmount: number): void {
    const source = this.resolveSource(sourceEntityId);
    if (!source) return;
    const stats = this.getOrCreate(source.playerId, source.unitType);
    if (this.isFriendly(source.playerId, targetEntityId)) {
      stats.friendlyDamageDealt += damageAmount;
    } else {
      stats.enemyDamageDealt += damageAmount;
    }
  }

  recordKill(sourceEntityId: EntityId, targetEntityId: EntityId): void {
    const source = this.resolveSource(sourceEntityId);
    if (!source) return;
    const stats = this.getOrCreate(source.playerId, source.unitType);
    if (this.isFriendly(source.playerId, targetEntityId)) {
      stats.friendlyKills += 1;
    } else {
      stats.enemyKills += 1;
    }
  }

  recordUnitProduced(playerId: PlayerId, unitType: string): void {
    const def = UNIT_DEFINITIONS[unitType];
    if (!def) return;
    const stats = this.getOrCreate(playerId, unitType);
    stats.unitsProduced += 1;
    stats.totalCostSpent += def.energyCost;
  }

  recordUnitLost(playerId: PlayerId, unitType: string): void {
    const stats = this.getOrCreate(playerId, unitType);
    stats.unitsLost += 1;
  }

  getSnapshot(): CombatStatsSnapshot {
    const players: Record<number, Record<string, UnitTypeStats>> = {};
    const globalMap = new Map<string, UnitTypeStats>();

    for (const [playerId, playerStats] of this.stats) {
      const playerRecord: Record<string, UnitTypeStats> = {};
      for (const [unitType, stats] of playerStats) {
        playerRecord[unitType] = { ...stats };

        // Aggregate into global
        let g = globalMap.get(unitType);
        if (!g) {
          g = createEmptyStats();
          globalMap.set(unitType, g);
        }
        g.enemyDamageDealt += stats.enemyDamageDealt;
        g.enemyKills += stats.enemyKills;
        g.friendlyDamageDealt += stats.friendlyDamageDealt;
        g.friendlyKills += stats.friendlyKills;
        g.unitsProduced += stats.unitsProduced;
        g.unitsLost += stats.unitsLost;
        g.totalCostSpent += stats.totalCostSpent;
      }
      players[playerId] = playerRecord;
    }

    const global: Record<string, UnitTypeStats> = {};
    for (const [unitType, stats] of globalMap) {
      global[unitType] = stats;
    }

    return { players, global };
  }
}
