import type {
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  ProjectileMotionUpdateEvent,
  SimEvent,
} from './combat';

const EMPTY_MOTION_UPDATES: ProjectileMotionUpdateEvent[] = [];

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

  projectileMotionUpdates = new Map<number, ProjectileMotionUpdateEvent>();
  private readonly motionUpdateBufA: ProjectileMotionUpdateEvent[] = [];
  private readonly motionUpdateBufB: ProjectileMotionUpdateEvent[] = [];
  private readonly motionUpdateIds: number[] = [];
  private motionUpdateToggle = false;

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

  getAndClearProjectileMotionUpdates(): ProjectileMotionUpdateEvent[] {
    const map = this.projectileMotionUpdates;
    if (map.size === 0) return EMPTY_MOTION_UPDATES;
    const buf = this.motionUpdateToggle ? this.motionUpdateBufB : this.motionUpdateBufA;
    this.motionUpdateToggle = !this.motionUpdateToggle;
    buf.length = 0;
    const ids = this.motionUpdateIds;
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
      this.projectileMotionUpdates.size > 0
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
    this.projectileMotionUpdates.clear();
    this.motionUpdateBufA.length = 0;
    this.motionUpdateBufB.length = 0;
    this.motionUpdateIds.length = 0;
    this.motionUpdateToggle = false;
  }
}
