// UnitEntity - Movable combat entities with weapons
// Extends GameEntity for unified health management

import { GameEntity } from './GameEntity';
import type {
  Turret,
  UnitAction,
  Body,
  EntityId,
  Buildable,
  Builder,
  Commander,
  DGunProjectile,
  UnitLocomotion,
} from '../types';

export class UnitEntity extends GameEntity {
  // Movement properties
  public locomotion: UnitLocomotion;
  public unitRadiusCollider: { scale: number; shot: number; push: number };
  public bodyCenterHeight: number;
  public velocityX: number = 0;
  public velocityY: number = 0;

  // Action queue
  public actions: UnitAction[] = [];
  public patrolStartIndex: number | null = null;

  // Turrets array - each turret is independent
  public turrets: Turret[] = [];

  // Physics body (optional - set externally by physics system)
  public body?: Body;

  // Construction component (for units being built)
  public buildable?: Buildable;

  // Builder component (for commander units)
  public builder?: Builder;

  // Commander component (for commander special abilities)
  public commander?: Commander;

  // D-gun projectile marker
  public dgunProjectile?: DGunProjectile;

  constructor(
    id: EntityId,
    x: number,
    y: number,
    hp: number,
    locomotion: UnitLocomotion,
    unitRadiusCollider: { scale: number; shot: number; push: number },
    bodyCenterHeight: number,
    playerId: number
  ) {
    super(id, x, y, hp, hp);
    this.locomotion = { ...locomotion };
    this.unitRadiusCollider = { ...unitRadiusCollider };
    this.bodyCenterHeight = bodyCenterHeight;
    this.ownership = { playerId };
    this.selectable = { selected: false };
  }

  get entityType(): 'unit' {
    return 'unit';
  }

  // Check if this is a commander unit
  get isCommander(): boolean {
    return this.commander !== undefined;
  }

  // Check if this is a builder unit (has builder component)
  get isBuilder(): boolean {
    return this.builder !== undefined;
  }

  // Compatibility layer - return a Unit-like object for legacy code
  get unit(): {
    hp: number;
    maxHp: number;
    locomotion: UnitLocomotion;
    unitRadiusCollider: { scale: number; shot: number; push: number };
    bodyCenterHeight: number;
    actions: UnitAction[];
    patrolStartIndex: number | null;
    velocityX: number;
    velocityY: number;
  } {
    return {
      hp: this.hp,
      maxHp: this.maxHp,
      locomotion: this.locomotion,
      unitRadiusCollider: this.unitRadiusCollider,
      bodyCenterHeight: this.bodyCenterHeight,
      actions: this.actions,
      patrolStartIndex: this.patrolStartIndex,
      velocityX: this.velocityX,
      velocityY: this.velocityY,
    };
  }

  // Allow setting HP through the unit property for compatibility
  set unit(value: { hp: number; maxHp: number; locomotion: UnitLocomotion; unitRadiusCollider: { scale: number; shot: number; push: number }; bodyCenterHeight?: number; actions: UnitAction[]; patrolStartIndex: number | null; velocityX?: number; velocityY?: number }) {
    this.hp = value.hp;
    this.maxHp = value.maxHp;
    this.locomotion = { ...value.locomotion };
    this.unitRadiusCollider = value.unitRadiusCollider;
    this.bodyCenterHeight = value.bodyCenterHeight ?? value.unitRadiusCollider.push;
    this.actions = value.actions;
    this.patrolStartIndex = value.patrolStartIndex;
    this.velocityX = value.velocityX ?? 0;
    this.velocityY = value.velocityY ?? 0;
  }
}
