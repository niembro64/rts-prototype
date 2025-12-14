// Entity ID type for deterministic identification
export type EntityId = number;

// Transform component - position and rotation in world space
export interface Transform {
  x: number;
  y: number;
  rotation: number;
}

// Body component - reference to Matter.js body
export interface Body {
  matterBody: MatterJS.BodyType;
}

// Selectable tag component
export interface Selectable {
  selected: boolean;
}

// Unit component - movable entities
export interface Unit {
  moveSpeed: number;
  radius: number;
  hp: number;
  maxHp: number;
  targetX: number | null;
  targetY: number | null;
}

// Building component - static structures
export interface Building {
  width: number;
  height: number;
  hp: number;
  maxHp: number;
}

// Weapon types for future implementation
export type WeaponType = 'laser' | 'minigun' | 'shotgun' | 'cannon' | 'grenade';

// Weapon component placeholder
export interface Weapon {
  type: WeaponType;
  damage: number;
  range: number;
  cooldown: number;
  currentCooldown: number;
}

// Projectile component placeholder
export interface Projectile {
  weaponType: WeaponType;
  damage: number;
  targetX: number;
  targetY: number;
  speed: number;
  splashRadius?: number;
}

// Entity type discriminator
export type EntityType = 'unit' | 'building';

// Full entity data (components are optional based on entity type)
export interface Entity {
  id: EntityId;
  type: EntityType;
  transform: Transform;
  body?: Body;
  selectable?: Selectable;
  unit?: Unit;
  building?: Building;
  weapon?: Weapon;
}
