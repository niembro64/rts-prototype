import type {
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  SimEvent,
} from './combat';

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

  hasPendingProjectilePresentationEvents(): boolean {
    return (
      this.projectileSpawns.length > 0 ||
      this.projectileDespawns.length > 0
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
  }
}
