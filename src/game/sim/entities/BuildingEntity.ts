// BuildingEntity - Static structures (solar panels, factories)
// Extends GameEntity for unified health management

import { GameEntity } from './GameEntity';
import type {
  BuildingType,
  Factory,
  Buildable,
  EntityId,
} from '../types';

export class BuildingEntity extends GameEntity {
  // Building dimensions
  public width: number;
  public height: number;

  // Building type (solar, factory)
  public buildingType: BuildingType;

  // Factory component (for unit production)
  public factory?: Factory;

  // Construction component (for buildings under construction)
  public buildable?: Buildable;

  constructor(
    id: EntityId,
    x: number,
    y: number,
    width: number,
    height: number,
    hp: number,
    buildingType: BuildingType,
    playerId: number
  ) {
    super(id, x, y, hp, hp);
    this.width = width;
    this.height = height;
    this.buildingType = buildingType;
    this.ownership = { playerId };
    this.selectable = { selected: false };
  }

  get entityType(): 'building' {
    return 'building';
  }

  // Check if this is a factory building
  get isFactory(): boolean {
    return this.factory !== undefined;
  }

  // Check if construction is complete
  get isComplete(): boolean {
    return !this.buildable || this.buildable.isComplete;
  }

  // Compatibility layer - return a Building-like object for legacy code
  get building(): {
    hp: number;
    maxHp: number;
    width: number;
    height: number;
  } {
    return {
      hp: this.hp,
      maxHp: this.maxHp,
      width: this.width,
      height: this.height,
    };
  }

  // Allow setting HP through the building property for compatibility
  set building(value: { hp: number; maxHp: number; width: number; height: number }) {
    this.hp = value.hp;
    this.maxHp = value.maxHp;
    this.width = value.width;
    this.height = value.height;
  }
}
