// Abstract base class for all game entities with health (units and buildings)
// Provides unified HP management, death checks, and damage/heal methods

import type { Transform, Ownership, Selectable, EntityId } from '../types';

export abstract class GameEntity {
  public readonly id: EntityId;
  public transform: Transform;
  public ownership?: Ownership;
  public selectable?: Selectable;

  // Unified health - THE source of truth for all damageable entities
  protected _hp: number;
  protected _maxHp: number;

  constructor(id: EntityId, x: number, y: number, hp: number, maxHp: number) {
    this.id = id;
    this.transform = { x, y, rotation: 0 };
    this._hp = hp;
    this._maxHp = maxHp;
  }

  // Health accessors
  get hp(): number {
    return this._hp;
  }

  set hp(value: number) {
    this._hp = Math.max(0, Math.min(value, this._maxHp));
  }

  get maxHp(): number {
    return this._maxHp;
  }

  set maxHp(value: number) {
    this._maxHp = value;
    // Ensure current HP doesn't exceed new max
    if (this._hp > this._maxHp) {
      this._hp = this._maxHp;
    }
  }

  // Death checks - SINGLE SOURCE OF TRUTH
  isAlive(): boolean {
    return this._hp > 0;
  }

  isDead(): boolean {
    return this._hp <= 0;
  }

  // Damage method - returns true if this damage killed the entity
  takeDamage(amount: number): boolean {
    if (this.isDead()) return false;
    this._hp -= amount;
    return this.isDead();
  }

  // Heal method - cannot exceed maxHp
  heal(amount: number): void {
    if (this.isDead()) return; // Can't heal dead entities
    this._hp = Math.min(this._hp + amount, this._maxHp);
  }

  // Entity type discriminator
  abstract get entityType(): 'unit' | 'building';
}
