import type { Entity, EntityId, EntityType } from './types';

// Seeded random number generator for determinism
export class SeededRNG {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  // Simple mulberry32 PRNG
  next(): number {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Random in range [min, max)
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  // Get current seed for state saving
  getSeed(): number {
    return this.seed;
  }

  // Set seed for state restoration
  setSeed(seed: number): void {
    this.seed = seed;
  }
}

// World state holds all entities and game state
export class WorldState {
  private entities: Map<EntityId, Entity> = new Map();
  private nextEntityId: EntityId = 1;
  private tick: number = 0;
  public rng: SeededRNG;

  // Map dimensions
  public readonly mapWidth: number = 2000;
  public readonly mapHeight: number = 2000;

  constructor(seed: number = 12345) {
    this.rng = new SeededRNG(seed);
  }

  // Generate next deterministic entity ID
  generateEntityId(): EntityId {
    return this.nextEntityId++;
  }

  // Get current tick
  getTick(): number {
    return this.tick;
  }

  // Increment tick
  incrementTick(): void {
    this.tick++;
  }

  // Add entity to world
  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
  }

  // Remove entity from world
  removeEntity(id: EntityId): void {
    this.entities.delete(id);
  }

  // Get entity by ID
  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  // Get all entities
  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  // Get entities by type
  getEntitiesByType(type: EntityType): Entity[] {
    return this.getAllEntities().filter((e) => e.type === type);
  }

  // Get all units
  getUnits(): Entity[] {
    return this.getEntitiesByType('unit');
  }

  // Get all buildings
  getBuildings(): Entity[] {
    return this.getEntitiesByType('building');
  }

  // Get selected entities
  getSelectedEntities(): Entity[] {
    return this.getAllEntities().filter((e) => e.selectable?.selected);
  }

  // Get selected units
  getSelectedUnits(): Entity[] {
    return this.getUnits().filter((e) => e.selectable?.selected);
  }

  // Entity count
  getEntityCount(): number {
    return this.entities.size;
  }

  // Clear all selections
  clearSelection(): void {
    for (const entity of this.entities.values()) {
      if (entity.selectable) {
        entity.selectable.selected = false;
      }
    }
  }

  // Select entities by IDs
  selectEntities(ids: EntityId[]): void {
    for (const id of ids) {
      const entity = this.entities.get(id);
      if (entity?.selectable) {
        entity.selectable.selected = true;
      }
    }
  }

  // Create a unit entity
  createUnit(x: number, y: number, radius: number = 15, moveSpeed: number = 100): Entity {
    const id = this.generateEntityId();
    const entity: Entity = {
      id,
      type: 'unit',
      transform: { x, y, rotation: 0 },
      selectable: { selected: false },
      unit: {
        moveSpeed,
        radius,
        hp: 100,
        maxHp: 100,
        targetX: null,
        targetY: null,
      },
    };
    return entity;
  }

  // Create a building entity
  createBuilding(x: number, y: number, width: number, height: number): Entity {
    const id = this.generateEntityId();
    const entity: Entity = {
      id,
      type: 'building',
      transform: { x, y, rotation: 0 },
      building: {
        width,
        height,
        hp: 500,
        maxHp: 500,
      },
    };
    return entity;
  }
}
