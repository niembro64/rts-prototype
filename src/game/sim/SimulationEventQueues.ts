import type {
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  ProjectileVelocityUpdateEvent,
  SimEvent,
} from './combat';

const EMPTY_VEL_UPDATES: ProjectileVelocityUpdateEvent[] = [];

export function safeVelocityUpdates(value: unknown): ProjectileVelocityUpdateEvent[] {
  return Array.isArray(value) ? value as ProjectileVelocityUpdateEvent[] : EMPTY_VEL_UPDATES;
}

export class SimulationEventQueues {
  private readonly audioA: SimEvent[] = [];
  private readonly audioB: SimEvent[] = [];
  simEvents: SimEvent[] = this.audioA;

  private readonly spawnsA: ProjectileSpawnEvent[] = [];
  private readonly spawnsB: ProjectileSpawnEvent[] = [];
  projectileSpawns: ProjectileSpawnEvent[] = this.spawnsA;

  private readonly despawnsA: ProjectileDespawnEvent[] = [];
  private readonly despawnsB: ProjectileDespawnEvent[] = [];
  projectileDespawns: ProjectileDespawnEvent[] = this.despawnsA;

  projectileVelocityUpdates = new Map<number, ProjectileVelocityUpdateEvent>();
  private readonly velUpdateBufA: ProjectileVelocityUpdateEvent[] = [];
  private readonly velUpdateBufB: ProjectileVelocityUpdateEvent[] = [];
  private readonly velUpdateIds: number[] = [];
  private velUpdateToggle = false;

  getAndClearEvents(): SimEvent[] {
    const events = this.simEvents;
    this.simEvents = events === this.audioA ? this.audioB : this.audioA;
    this.simEvents.length = 0;
    return events;
  }

  getAndClearProjectileSpawns(): ProjectileSpawnEvent[] {
    const events = this.projectileSpawns;
    this.projectileSpawns = events === this.spawnsA ? this.spawnsB : this.spawnsA;
    this.projectileSpawns.length = 0;
    return events;
  }

  getAndClearProjectileDespawns(): ProjectileDespawnEvent[] {
    const events = this.projectileDespawns;
    this.projectileDespawns = events === this.despawnsA ? this.despawnsB : this.despawnsA;
    this.projectileDespawns.length = 0;
    return events;
  }

  getAndClearProjectileVelocityUpdates(): ProjectileVelocityUpdateEvent[] {
    const map = this.projectileVelocityUpdates;
    if (map.size === 0) return EMPTY_VEL_UPDATES;
    const buf = this.velUpdateToggle ? this.velUpdateBufB : this.velUpdateBufA;
    this.velUpdateToggle = !this.velUpdateToggle;
    buf.length = 0;
    const ids = this.velUpdateIds;
    ids.length = 0;
    for (const id of map.keys()) ids.push(id);
    ids.sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      const event = map.get(ids[i]);
      if (event !== undefined) buf.push(event);
    }
    map.clear();
    return buf;
  }

  hasPendingProjectilePresentationEvents(): boolean {
    return (
      this.projectileSpawns.length > 0 ||
      this.projectileDespawns.length > 0 ||
      this.projectileVelocityUpdates.size > 0
    );
  }

  reset(): void {
    this.audioA.length = 0;
    this.audioB.length = 0;
    this.simEvents = this.audioA;
    this.spawnsA.length = 0;
    this.spawnsB.length = 0;
    this.projectileSpawns = this.spawnsA;
    this.despawnsA.length = 0;
    this.despawnsB.length = 0;
    this.projectileDespawns = this.despawnsA;
    this.projectileVelocityUpdates.clear();
    this.velUpdateBufA.length = 0;
    this.velUpdateBufB.length = 0;
    this.velUpdateIds.length = 0;
    this.velUpdateToggle = false;
  }
}
