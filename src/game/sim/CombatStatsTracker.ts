// Combat Stats Tracker - accumulates per-player, per-unit-type combat performance data

import type { EntityId, PlayerId } from './types';
import type { WorldState } from './WorldState';
import { getUnitBlueprint } from './blueprints';

export type { UnitTypeStats, CombatStatsSnapshot } from '@/types/ui';
import type { UnitTypeStats, CombatStatsSnapshot } from '@/types/ui';

function createEmptyStats(): UnitTypeStats {
  return {
    damage: { dealt: { enemy: 0, friendly: 0 }, received: 0 },
    kills: { enemy: 0, friendly: 0 },
    units: { produced: 0, lost: 0, energyCost: 0, manaCost: 0 },
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

  /** Look up target entity's player and unit type, falling back to registry for dead units. */
  private resolveTarget(targetEntityId: EntityId): { playerId: PlayerId; unitType: string } | null {
    const entity = this.world.getEntity(targetEntityId);
    if (entity?.unit?.unitType && entity.ownership) {
      return { playerId: entity.ownership.playerId, unitType: entity.unit.unitType };
    }
    return this.entityRegistry.get(targetEntityId) ?? null;
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
      stats.damage.dealt.friendly += damageAmount;
    } else {
      stats.damage.dealt.enemy += damageAmount;
      // Also record damage received on the target side
      const target = this.resolveTarget(targetEntityId);
      if (target) {
        const targetStats = this.getOrCreate(target.playerId, target.unitType);
        targetStats.damage.received += damageAmount;
      }
    }
  }

  recordKill(sourceEntityId: EntityId, targetEntityId: EntityId): void {
    const source = this.resolveSource(sourceEntityId);
    if (!source) return;
    const stats = this.getOrCreate(source.playerId, source.unitType);
    if (this.isFriendly(source.playerId, targetEntityId)) {
      stats.kills.friendly += 1;
    } else {
      stats.kills.enemy += 1;
    }
  }

  recordUnitProduced(playerId: PlayerId, unitType: string): void {
    let bp;
    try { bp = getUnitBlueprint(unitType); } catch { return; }
    const stats = this.getOrCreate(playerId, unitType);
    stats.units.produced += 1;
    stats.units.energyCost += bp.energyCost;
    stats.units.manaCost += bp.manaCost;
  }

  recordUnitLost(playerId: PlayerId, unitType: string): void {
    const stats = this.getOrCreate(playerId, unitType);
    stats.units.lost += 1;
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
        copy.damage.dealt.enemy = stats.damage.dealt.enemy;
        copy.damage.dealt.friendly = stats.damage.dealt.friendly;
        copy.damage.received = stats.damage.received;
        copy.kills.enemy = stats.kills.enemy;
        copy.kills.friendly = stats.kills.friendly;
        copy.units.produced = stats.units.produced;
        copy.units.lost = stats.units.lost;
        copy.units.energyCost = stats.units.energyCost;
        copy.units.manaCost = stats.units.manaCost;

        // Aggregate into global
        let g = globalMap.get(unitType);
        if (!g) {
          g = createEmptyStats();
          globalMap.set(unitType, g);
        }
        g.damage.dealt.enemy += stats.damage.dealt.enemy;
        g.damage.dealt.friendly += stats.damage.dealt.friendly;
        g.damage.received += stats.damage.received;
        g.kills.enemy += stats.kills.enemy;
        g.kills.friendly += stats.kills.friendly;
        g.units.produced += stats.units.produced;
        g.units.lost += stats.units.lost;
        g.units.energyCost += stats.units.energyCost;
        g.units.manaCost += stats.units.manaCost;
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
