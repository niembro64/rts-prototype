// Combat Stats Tracker - accumulates per-player, per-unit-type combat performance data

import type { EntityId, PlayerId } from './types';
import type { WorldState } from './WorldState';
import { getUnitBlueprint } from './blueprints';

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
  // Entries are pruned every tick to prevent unbounded growth.
  private entityRegistry: Map<EntityId, { playerId: PlayerId; unitType: string }> = new Map();

  // Cached snapshot to avoid allocations — rebuilt in-place each call
  private _snapshot: CombatStatsSnapshot = { players: {}, global: {} };
  private _globalAccum: Map<string, UnitTypeStats> = new Map();

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

  /**
   * Remove registry entries for entities no longer in the world.
   * O(1) map lookup per entry — safe to call every tick.
   */
  pruneRegistry(): void {
    for (const id of this.entityRegistry.keys()) {
      if (!this.world.getEntity(id)) {
        this.entityRegistry.delete(id);
      }
    }
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
    let bp;
    try { bp = getUnitBlueprint(unitType); } catch { return; }
    const stats = this.getOrCreate(playerId, unitType);
    stats.unitsProduced += 1;
    stats.totalCostSpent += bp.baseCost;
  }

  recordUnitLost(playerId: PlayerId, unitType: string): void {
    const stats = this.getOrCreate(playerId, unitType);
    stats.unitsLost += 1;
  }

  getSnapshot(): CombatStatsSnapshot {
    const snap = this._snapshot;
    const globalMap = this._globalAccum;

    // Clear previous snapshot keys
    for (const key in snap.players) delete snap.players[key];
    for (const key in snap.global) delete snap.global[key];
    globalMap.clear();

    for (const [playerId, playerStats] of this.stats) {
      let playerRecord = snap.players[playerId];
      if (!playerRecord) {
        playerRecord = {};
        snap.players[playerId] = playerRecord;
      }
      for (const [unitType, stats] of playerStats) {
        // Copy stats into player record (reuse object if it exists)
        let copy = playerRecord[unitType];
        if (!copy) {
          copy = createEmptyStats();
          playerRecord[unitType] = copy;
        }
        copy.enemyDamageDealt = stats.enemyDamageDealt;
        copy.enemyKills = stats.enemyKills;
        copy.friendlyDamageDealt = stats.friendlyDamageDealt;
        copy.friendlyKills = stats.friendlyKills;
        copy.unitsProduced = stats.unitsProduced;
        copy.unitsLost = stats.unitsLost;
        copy.totalCostSpent = stats.totalCostSpent;

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
    }

    for (const [unitType, stats] of globalMap) {
      snap.global[unitType] = stats;
    }

    return snap;
  }

  reset(): void {
    this.stats.clear();
    this.entityRegistry.clear();
  }
}
