import type { ClientCommandSink } from '../input/ClientCommandSink';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import {
  entityCanBarAttackTarget,
  entityHasBarSetTargetCommand,
} from '../sim/unitCommandCapabilities';

const BAR_TARGET_TYPE_POLL_TICKS = 15;
const BAR_TARGET_TYPE_RANGE_MULTIPLIER = 1.5;
const BAR_TARGET_TYPE_SNAP_RADIUS = 100;

type TargetTypeEntitySource = {
  getUnits: () => Entity[];
  getEntity: (id: EntityId) => Entity | undefined;
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean;
};

type Input3DTargetTypeTrackerConfig = {
  getEntitySource: () => TargetTypeEntitySource;
  commandQueue: ClientCommandSink;
  getTick: () => number;
  getActivePlayerId: () => PlayerId;
  getSelectedTargetableEntities: () => readonly Entity[];
};

export class Input3DTargetTypeTracker {
  private readonly trackedTargetBlueprintByHostId = new Map<EntityId, string>();
  private lastPollTick = -1;

  constructor(private readonly config: Input3DTargetTypeTrackerConfig) {}

  trackSelectedTargetType(targetId: EntityId): boolean {
    const source = this.config.getEntitySource();
    const target = source.getEntity(targetId);
    if (!isAliveUnit(target)) return false;
    const targetBlueprintId = target.unit.unitBlueprintId;
    let tracked = false;
    const hosts = this.config.getSelectedTargetableEntities();
    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i];
      if (!this.canTrackHostAgainstTarget(host, target)) continue;
      this.trackedTargetBlueprintByHostId.set(host.id, targetBlueprintId);
      tracked = true;
    }
    return tracked;
  }

  trackNearestEnemyTypeAt(point: { x: number; y: number }, radius = BAR_TARGET_TYPE_SNAP_RADIUS): EntityId | null {
    const source = this.config.getEntitySource();
    const target = this.findNearestEnemyUnitToActivePlayer(point, radius, source);
    if (target === null) {
      this.clearSelected();
      return null;
    }
    return this.trackSelectedTargetType(target.id) ? target.id : null;
  }

  clearSelected(): void {
    const hosts = this.config.getSelectedTargetableEntities();
    for (let i = 0; i < hosts.length; i++) {
      this.trackedTargetBlueprintByHostId.delete(hosts[i].id);
    }
  }

  tick(): void {
    const tick = this.config.getTick();
    if (tick === this.lastPollTick || tick % BAR_TARGET_TYPE_POLL_TICKS !== 0) return;
    this.lastPollTick = tick;
    if (this.trackedTargetBlueprintByHostId.size === 0) return;

    const source = this.config.getEntitySource();
    for (const [hostId, targetBlueprintId] of this.trackedTargetBlueprintByHostId) {
      const host = source.getEntity(hostId);
      if (!this.isTrackableHost(host)) {
        this.trackedTargetBlueprintByHostId.delete(hostId);
        continue;
      }
      const target = this.findBestTargetForHost(source, host, targetBlueprintId);
      if (target === null || host.combat?.priorityTargetId === target.id) continue;
      this.config.commandQueue.enqueue({
        type: 'setTowerTarget',
        tick,
        entityIds: [host.id],
        targetId: target.id,
      });
    }
  }

  private canTrackHostAgainstTarget(host: Entity, target: Entity): boolean {
    return this.isTrackableHost(host) &&
      target.ownership !== null &&
      areHostAndTargetEnemies(host, target, this.config.getEntitySource()) &&
      entityCanBarAttackTarget(host, target);
  }

  private isTrackableHost(host: Entity | undefined): host is Entity {
    return host !== undefined &&
      host.ownership !== null &&
      host.combat !== null &&
      entityHasBarSetTargetCommand(host);
  }

  private findBestTargetForHost(
    source: TargetTypeEntitySource,
    host: Entity,
    targetBlueprintId: string,
  ): Entity | null {
    const range = maxTargetTypeRange(host);
    if (range <= 0) return null;
    const maxRange = range * BAR_TARGET_TYPE_RANGE_MULTIPLIER;
    const maxDistSq = maxRange * maxRange;
    const units = source.getUnits();
    let best: Entity | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;
    for (let i = 0; i < units.length; i++) {
      const candidate = units[i];
      if (!isAliveUnit(candidate)) continue;
      if (candidate.unit.unitBlueprintId !== targetBlueprintId) continue;
      if (!areHostAndTargetEnemies(host, candidate, source)) continue;
      if (!entityCanBarAttackTarget(host, candidate)) continue;
      const distSq = horizontalDistanceSq(host, candidate);
      if (distSq > maxDistSq || distSq >= bestDistSq) continue;
      best = candidate;
      bestDistSq = distSq;
    }
    return best;
  }

  private findNearestEnemyUnitToActivePlayer(
    point: { x: number; y: number },
    radius: number,
    source: TargetTypeEntitySource,
  ): Entity | null {
    const playerId = this.config.getActivePlayerId();
    const radiusSq = radius * radius;
    const units = source.getUnits();
    let best: Entity | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;
    for (let i = 0; i < units.length; i++) {
      const candidate = units[i];
      if (!isAliveUnit(candidate) || candidate.ownership === null) continue;
      if (candidate.ownership.playerId === playerId) continue;
      if (source.arePlayersAllied?.(playerId, candidate.ownership.playerId) === true) continue;
      const dx = candidate.transform.x - point.x;
      const dy = candidate.transform.y - point.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > radiusSq || distSq >= bestDistSq) continue;
      best = candidate;
      bestDistSq = distSq;
    }
    return best;
  }
}

function isAliveUnit(entity: Entity | null | undefined): entity is Entity & { unit: NonNullable<Entity['unit']> } {
  return entity !== null &&
    entity !== undefined &&
    entity.unit !== null &&
    entity.unit.hp > 0;
}

function areHostAndTargetEnemies(
  host: Entity,
  target: Entity,
  source: TargetTypeEntitySource,
): boolean {
  const hostPlayerId = host.ownership?.playerId;
  const targetPlayerId = target.ownership?.playerId;
  if (hostPlayerId === undefined || targetPlayerId === undefined) return false;
  if (hostPlayerId === targetPlayerId) return false;
  return source.arePlayersAllied?.(hostPlayerId, targetPlayerId) !== true;
}

function horizontalDistanceSq(a: Entity, b: Entity): number {
  const dx = b.transform.x - a.transform.x;
  const dy = b.transform.y - a.transform.y;
  return dx * dx + dy * dy;
}

function maxTargetTypeRange(entity: Entity): number {
  const turrets = entity.combat?.turrets ?? [];
  let range = 0;
  for (let i = 0; i < turrets.length; i++) {
    const config = turrets[i].config;
    if (
      config.visualOnly ||
      config.passive ||
      config.shot === null ||
      config.shot === undefined ||
      config.shot.type === 'shield'
    ) continue;
    range = Math.max(range, config.range);
  }
  return range;
}
