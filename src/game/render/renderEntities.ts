import Phaser from 'phaser';
import type { Entity, WaypointType, ActionType, EntityId } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';
import type { SprayTarget } from '../sim/commanderAbilities';
import { ArachnidLeg, type LegConfig } from './ArachnidLeg';
import {
  type TankTreadSetup,
  type VehicleWheelSetup,
  createTankTreads,
  createBrawlTreads,
  createScoutWheelSetup,
  createBurstWheelSetup,
  createMortarWheelSetup,
  createFourWheelSetup,
} from './Tread';

/**
 * EntitySource - Interface that both WorldState and ClientViewState implement
 * Allows the renderer to work with either source transparently
 */
export interface EntitySource {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  getProjectiles(): Entity[];
  getEntity(id: EntityId): Entity | undefined;
}

// Explosion effect data
export interface ExplosionEffect {
  x: number;
  y: number;
  radius: number; // Maximum radius of explosion
  color: number; // Base color
  lifetime: number; // Total lifetime in ms
  elapsed: number; // Time elapsed in ms
  type: 'impact' | 'death'; // Type affects visual style
}

// Colors
const UNIT_SELECTED_COLOR = 0x00ff88;
const BUILDING_COLOR = 0x886644;
const BUILDING_OUTLINE_COLOR = 0xaa8866;
const HEALTH_BAR_BG = 0x333333;
const HEALTH_BAR_FG = 0x44dd44;
const HEALTH_BAR_LOW = 0xff4444;
const BUILD_BAR_FG = 0xffcc00; // Yellow for build progress
const GHOST_COLOR = 0x88ff88; // Green tint for placement ghost
const COMMANDER_COLOR = 0xffd700; // Gold for commander indicator

// Leg style configuration - thickness and foot size multipliers
const LEG_STYLE_CONFIG = {
  arachnid: { thickness: 5, footSizeMultiplier: 0.1 },
  daddy: { thickness: 2, footSizeMultiplier: 0.14 },
  insect: { thickness: 4, footSizeMultiplier: 0.12 },
} as const;

// Waypoint colors by type (legacy - for factories)
const WAYPOINT_COLORS: Record<WaypointType, number> = {
  move: 0x00ff00, // Green
  patrol: 0x0088ff, // Blue
  fight: 0xff4444, // Red
};

// Action colors by type (for unit action queue)
const ACTION_COLORS: Record<ActionType, number> = {
  move: 0x00ff00, // Green
  patrol: 0x0088ff, // Blue
  fight: 0xff4444, // Red
  build: 0xffcc00, // Yellow for building
  repair: 0x44ff44, // Light green for repair
};

// Spray effect colors
const SPRAY_BUILD_COLOR = 0x44ff44; // Green for building
const SPRAY_HEAL_COLOR = 0x4488ff; // Blue for healing

// Range circle colors
const VISION_RANGE_COLOR = 0xffff88; // Yellow for vision range
const WEAPON_RANGE_COLOR = 0xff4444; // Red for weapon range
const BUILD_RANGE_COLOR = 0x44ff44; // Green for build range

// Unit display names by weapon ID
const UNIT_NAMES: Record<string, string> = {
  scout: 'Scout',
  burst: 'Burst',
  beam: 'Beam',
  brawl: 'Brawl',
  mortar: 'Mortar',
  snipe: 'Snipe',
  tank: 'Tank',
  arachnid: 'Arachnid',
  sonic: 'Sonic',
};

export class EntityRenderer {
  private scene: Phaser.Scene;
  private graphics: Phaser.GameObjects.Graphics;
  private entitySource: EntitySource;
  private sprayTargets: SprayTarget[] = [];
  private sprayParticleTime: number = 0;

  // Text labels for selected entities
  private labelPool: Phaser.GameObjects.Text[] = [];
  private activeLabelCount: number = 0;

  // Explosion effects
  private explosions: ExplosionEffect[] = [];

  // Arachnid legs storage (entity ID -> array of 8 legs)
  private arachnidLegs: Map<EntityId, ArachnidLeg[]> = new Map();

  // Tank treads storage (entity ID -> left/right tread pair)
  private tankTreads: Map<EntityId, TankTreadSetup> = new Map();

  // Vehicle wheels storage (entity ID -> wheel array)
  private vehicleWheels: Map<EntityId, VehicleWheelSetup> = new Map();

  // Rendering mode flags
  private skipTurrets: boolean = false;
  private turretsOnly: boolean = false;

  constructor(scene: Phaser.Scene, entitySource: EntitySource) {
    this.scene = scene;
    this.graphics = scene.add.graphics();
    this.entitySource = entitySource;
  }

  // Get or create legs for a legged unit
  // Styles: 'arachnid' (8 chunky), 'daddy' (8 long thin), 'insect' (6 medium)
  private getOrCreateLegs(
    entity: Entity,
    legStyle: 'arachnid' | 'daddy' | 'insect' = 'arachnid'
  ): ArachnidLeg[] {
    const existing = this.arachnidLegs.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 40;

    // Define left side legs only, then mirror to create right side
    let leftSideConfigs: LegConfig[];

    if (legStyle === 'daddy') {
      // Daddy long legs: 4 very long thin legs per side
      // Much longer legs relative to body size
      const legLength = radius * 10;
      const upperLen = legLength * 0.3;
      const lowerLen = legLength * 0.6;

      leftSideConfigs = [
        {
          attachOffsetX: radius * 0.3,
          attachOffsetY: -radius * 0.4,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.3,
          snapTargetAngle: -Math.PI * 0.2,
          snapDistanceMultiplier: 0.9,
          extensionThreshold: 0.82,
        },
        {
          attachOffsetX: radius * 0.1,
          attachOffsetY: -radius * 0.45,
          upperLegLength: upperLen * 0.95,
          lowerLegLength: lowerLen * 0.95,
          snapTriggerAngle: Math.PI * 0.55,
          snapTargetAngle: -Math.PI * 0.25,
          snapDistanceMultiplier: 0.9,
          extensionThreshold: 0.84,
        },
        {
          attachOffsetX: -radius * 0.1,
          attachOffsetY: -radius * 0.45,
          upperLegLength: upperLen * 0.95,
          lowerLegLength: lowerLen * 0.95,
          snapTriggerAngle: Math.PI * 0.85,
          snapTargetAngle: -Math.PI * 0.45,
          snapDistanceMultiplier: 0.85,
          extensionThreshold: 0.9,
        },
        {
          attachOffsetX: -radius * 0.3,
          attachOffsetY: -radius * 0.4,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.99,
          snapTargetAngle: -Math.PI * 0.65,
          snapDistanceMultiplier: 0.55,
          extensionThreshold: 0.99,
        },
      ];
    } else if (legStyle === 'insect') {
      // Insect: 3 legs per side (front to back)
      const legLength = radius * 1.9;
      const upperLen = legLength * 0.55;
      const lowerLen = legLength * 0.55;

      leftSideConfigs = [
        {
          attachOffsetX: radius * 0.5,
          attachOffsetY: -radius * 0.35,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.5,
          snapTargetAngle: -Math.PI * 0.2,
          snapDistanceMultiplier: 0.9,
          extensionThreshold: 0.99,
        },
        {
          attachOffsetX: 0,
          attachOffsetY: -radius * 0.4,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.8,
          snapTargetAngle: -Math.PI * 0.3,
          snapDistanceMultiplier: 0.9,
          extensionThreshold: 0.99,
        },
        {
          attachOffsetX: -radius * 0.5,
          attachOffsetY: -radius * 0.35,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.944,
          snapTargetAngle: -Math.PI * 0.5,
          snapDistanceMultiplier: 0.5,
          extensionThreshold: 0.99,
        },
      ];
    } else {
      // Arachnid: 4 chunky legs per side (front to back)
      const legLength = radius * 1.9;
      const upperLen = legLength * 0.55;
      const lowerLen = legLength * 0.55;

      leftSideConfigs = [
        {
          attachOffsetX: radius * 0.6,
          attachOffsetY: -radius * 0.5,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.5,
          snapTargetAngle: -Math.PI * 0.1,
          snapDistanceMultiplier: 0.99,
          extensionThreshold: 0.88,
        },
        {
          attachOffsetX: radius * 0.25,
          attachOffsetY: -radius * 0.5,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.65,
          snapTargetAngle: -Math.PI * 0.33,
          snapDistanceMultiplier: 0.88,
          extensionThreshold: 0.89,
        },
        {
          attachOffsetX: -radius * 0.2,
          attachOffsetY: -radius * 0.5,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.8,
          snapTargetAngle: -Math.PI * 0.55,
          snapDistanceMultiplier: 0.82,
          extensionThreshold: 0.9,
        },
        {
          attachOffsetX: -radius * 0.55,
          attachOffsetY: -radius * 0.5,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.99,
          snapTargetAngle: -Math.PI * 0.7,
          snapDistanceMultiplier: 0.5,
          extensionThreshold: 0.98,
        },
      ];
    }

    // Mirror left side to create right side (flip Y offset and snap target angle)
    const rightSideConfigs: LegConfig[] = leftSideConfigs.map((leg) => ({
      ...leg,
      attachOffsetY: -leg.attachOffsetY,
      snapTargetAngle: -leg.snapTargetAngle,
    }));

    const legConfigs = [...leftSideConfigs, ...rightSideConfigs];

    const legs = legConfigs.map((config) => new ArachnidLeg(config));

    // Initialize all legs at the unit's current position to prevent flickering
    const unitX = entity.transform.x;
    const unitY = entity.transform.y;
    const unitRotation = entity.transform.rotation;
    for (const leg of legs) {
      leg.initializeAt(unitX, unitY, unitRotation);
    }

    this.arachnidLegs.set(entity.id, legs);
    return legs;
  }

  // Update all legged unit legs (call each frame with dtMs)
  updateArachnidLegs(dtMs: number): void {
    // Clean up legs for entities that no longer exist
    const existingIds = new Set(this.entitySource.getUnits().map((e) => e.id));
    for (const id of this.arachnidLegs.keys()) {
      if (!existingIds.has(id)) {
        this.arachnidLegs.delete(id);
      }
    }

    // Update legs for all legged units (arachnid: 8 chunky, beam: 8 daddy long legs, sonic: 6 insect)
    for (const entity of this.entitySource.getUnits()) {
      if (!entity.unit || !entity.weapons || entity.weapons.length === 0)
        continue;

      // Check if this is an arachnid, beam unit, or sonic unit
      const isArachnid = entity.weapons.length > 1;
      const isBeam =
        entity.weapons.length === 1 && entity.weapons[0].config.id === 'beam';
      const isSonic =
        entity.weapons.length === 1 && entity.weapons[0].config.id === 'sonic';

      if (!isArachnid && !isBeam && !isSonic) continue;

      const legStyle = isArachnid ? 'arachnid' : isBeam ? 'daddy' : 'insect';
      const legs = this.getOrCreateLegs(entity, legStyle);
      const velX = entity.unit.velocityX ?? 0;
      const velY = entity.unit.velocityY ?? 0;

      for (const leg of legs) {
        leg.update(
          entity.transform.x,
          entity.transform.y,
          entity.transform.rotation,
          velX,
          velY,
          dtMs
        );
      }
    }
  }

  // Get or create treads for a tracked unit (tank or brawl)
  private getOrCreateTreads(
    entity: Entity,
    unitType: 'tank' | 'brawl'
  ): TankTreadSetup {
    const existing = this.tankTreads.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 24;
    const treads =
      unitType === 'tank'
        ? createTankTreads(radius, 2.0)
        : createBrawlTreads(radius, 2.0);

    // Initialize treads at the unit's current position
    treads.leftTread.initializeAt(
      entity.transform.x,
      entity.transform.y,
      entity.transform.rotation
    );
    treads.rightTread.initializeAt(
      entity.transform.x,
      entity.transform.y,
      entity.transform.rotation
    );

    this.tankTreads.set(entity.id, treads);
    return treads;
  }

  // Convenience method for tank treads (used by drawTankUnit)
  getTankTreads(entityId: EntityId): TankTreadSetup | undefined {
    return this.tankTreads.get(entityId);
  }

  // Get or create vehicle wheels based on unit type
  private getOrCreateVehicleWheels(entity: Entity): VehicleWheelSetup | null {
    const existing = this.vehicleWheels.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 10;
    const weaponId = entity.weapons?.[0]?.config.id;

    let wheelSetup: VehicleWheelSetup | null = null;

    switch (weaponId) {
      case 'scout':
        wheelSetup = createScoutWheelSetup(radius, 2.0);
        break;
      case 'burst':
        wheelSetup = createBurstWheelSetup(radius, 2.0);
        break;
      case 'mortar':
        wheelSetup = createMortarWheelSetup(radius, 2.0);
        break;
      case 'snipe':
        wheelSetup = createFourWheelSetup(radius, 2.0);
        break;
      default:
        return null;
    }

    // Initialize wheels at the unit's current position
    for (const wheel of wheelSetup.wheels) {
      wheel.initializeAt(
        entity.transform.x,
        entity.transform.y,
        entity.transform.rotation
      );
    }

    this.vehicleWheels.set(entity.id, wheelSetup);
    return wheelSetup;
  }

  // Update all tank treads and vehicle wheels (call each frame with dtMs)
  updateTreads(dtMs: number): void {
    // Clean up treads/wheels for entities that no longer exist
    const existingIds = new Set(this.entitySource.getUnits().map((e) => e.id));
    for (const id of this.tankTreads.keys()) {
      if (!existingIds.has(id)) {
        this.tankTreads.delete(id);
      }
    }
    for (const id of this.vehicleWheels.keys()) {
      if (!existingIds.has(id)) {
        this.vehicleWheels.delete(id);
      }
    }

    // Update treads for all tracked/wheeled units
    for (const entity of this.entitySource.getUnits()) {
      if (!entity.unit || !entity.weapons || entity.weapons.length === 0)
        continue;

      const weaponId = entity.weapons[0].config.id;

      // Handle tracked vehicles (tank and brawl)
      if (weaponId === 'tank' || weaponId === 'brawl') {
        const unitType = weaponId as 'tank' | 'brawl';
        const treads = this.getOrCreateTreads(entity, unitType);
        treads.leftTread.update(
          entity.transform.x,
          entity.transform.y,
          entity.transform.rotation,
          dtMs
        );
        treads.rightTread.update(
          entity.transform.x,
          entity.transform.y,
          entity.transform.rotation,
          dtMs
        );
        continue;
      }

      // Handle wheeled vehicles
      const wheelSetup = this.getOrCreateVehicleWheels(entity);
      if (wheelSetup) {
        for (const wheel of wheelSetup.wheels) {
          wheel.update(
            entity.transform.x,
            entity.transform.y,
            entity.transform.rotation,
            dtMs
          );
        }
      }
    }
  }

  // Get vehicle wheels for rendering (used by draw methods)
  getVehicleWheels(entityId: EntityId): VehicleWheelSetup | undefined {
    return this.vehicleWheels.get(entityId);
  }

  // Add a new explosion effect
  addExplosion(
    x: number,
    y: number,
    radius: number,
    color: number,
    type: 'impact' | 'death'
  ): void {
    // Base lifetime scales with radius - larger explosions last longer
    // Base: 150ms for a radius of 8, scales proportionally
    const baseRadius = 8;
    const baseLifetime = type === 'death' ? 600 : 150;
    const radiusScale = Math.sqrt(radius / baseRadius); // Square root for less extreme scaling
    const lifetime = baseLifetime * radiusScale;

    this.explosions.push({
      x,
      y,
      radius,
      color,
      lifetime,
      elapsed: 0,
      type,
    });
  }

  // Update explosion effects (call each frame with dtMs)
  updateExplosions(dtMs: number): void {
    // Update elapsed time and remove expired explosions
    this.explosions = this.explosions.filter((exp) => {
      exp.elapsed += dtMs;
      return exp.elapsed < exp.lifetime;
    });
  }

  // Get or create a text label from the pool
  private getLabel(): Phaser.GameObjects.Text {
    if (this.activeLabelCount < this.labelPool.length) {
      const label = this.labelPool[this.activeLabelCount];
      label.setVisible(true);
      this.activeLabelCount++;
      return label;
    }

    // Create new label
    const label = this.scene.add.text(0, 0, '', {
      fontSize: '12px',
      fontFamily: 'monospace',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
      align: 'center',
    });
    label.setOrigin(0.5, 1); // Center horizontally, anchor at bottom
    label.setDepth(1000); // Above everything
    this.labelPool.push(label);
    this.activeLabelCount++;
    return label;
  }

  // Reset label pool for next frame
  private resetLabels(): void {
    for (let i = 0; i < this.activeLabelCount; i++) {
      this.labelPool[i].setVisible(false);
    }
    this.activeLabelCount = 0;
  }

  /**
   * Set the entity source for rendering
   * Allows switching between WorldState (simulation view) and ClientViewState (client view)
   */
  setEntitySource(
    source: EntitySource,
    sourceType: 'world' | 'clientView' = 'world'
  ): void {
    this.entitySource = source;
    console.log(`[Render] Entity source switched to: ${sourceType}`);
  }

  // Set spray targets for rendering
  setSprayTargets(targets: SprayTarget[]): void {
    this.sprayTargets = targets;
  }

  // Render all entities
  render(): void {
    this.graphics.clear();
    this.resetLabels(); // Reset text labels for this frame

    // Update particle time for spray animation
    this.sprayParticleTime += 16; // ~60fps

    // 1. Render buildings first (bottom layer)
    for (const entity of this.entitySource.getBuildings()) {
      this.renderBuilding(entity);
    }

    // Render waypoints for selected units (below units)
    for (const entity of this.entitySource.getUnits()) {
      if (entity.selectable?.selected) {
        this.renderWaypoints(entity);
      }
    }

    // Render waypoints for selected factories
    for (const entity of this.entitySource.getBuildings()) {
      if (entity.selectable?.selected && entity.factory) {
        this.renderFactoryWaypoints(entity);
      }
    }

    // Render range circles for selected units (below unit bodies)
    for (const entity of this.entitySource.getUnits()) {
      if (entity.selectable?.selected) {
        this.renderRangeCircles(entity);
      }
    }

    // 2. Render unit bodies (no turrets)
    this.skipTurrets = true;
    this.turretsOnly = false;
    for (const entity of this.entitySource.getUnits()) {
      this.renderUnit(entity);
    }

    // 3. Render turrets only (above unit bodies)
    this.skipTurrets = false;
    this.turretsOnly = true;
    for (const entity of this.entitySource.getUnits()) {
      this.renderUnit(entity);
    }
    this.turretsOnly = false;

    // 4. Render projectiles and lasers
    for (const entity of this.entitySource.getProjectiles()) {
      this.renderProjectile(entity);
    }

    // Render spray effects (lasers for building/healing)
    for (const target of this.sprayTargets) {
      this.renderSprayEffect(target);
    }

    // 5. Render explosion effects (above everything except labels)
    for (const explosion of this.explosions) {
      this.renderExplosion(explosion);
    }

    // Render labels for selected entities (last, on top of everything)
    this.renderSelectedLabels();
  }

  // Render an explosion effect
  private renderExplosion(exp: ExplosionEffect): void {
    const progress = exp.elapsed / exp.lifetime;

    if (exp.type === 'death') {
      // Death explosion - expanding ring with particles
      const currentRadius = exp.radius * (0.3 + progress * 0.7);
      const alpha = 1 - progress;

      // Outer glow
      this.graphics.fillStyle(exp.color, alpha * 0.3);
      this.graphics.fillCircle(exp.x, exp.y, currentRadius * 1.3);

      // Main explosion
      this.graphics.fillStyle(exp.color, alpha * 0.6);
      this.graphics.fillCircle(exp.x, exp.y, currentRadius);

      // Hot core (orange to white)
      const coreProgress = Math.min(1, progress * 2);
      const coreRadius = currentRadius * (0.6 - coreProgress * 0.4);
      if (coreRadius > 0) {
        this.graphics.fillStyle(0xff6600, alpha * 0.8);
        this.graphics.fillCircle(exp.x, exp.y, coreRadius);
        this.graphics.fillStyle(0xffffff, alpha * (1 - coreProgress));
        this.graphics.fillCircle(exp.x, exp.y, coreRadius * 0.5);
      }

      // Expanding ring
      const ringAlpha = alpha * 0.5;
      const ringRadius = exp.radius * (0.5 + progress);
      this.graphics.lineStyle(3 * (1 - progress) + 1, exp.color, ringAlpha);
      this.graphics.strokeCircle(exp.x, exp.y, ringRadius);

      // Debris particles
      const particleCount = 8;
      for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2 + progress * 2;
        const particleDist = exp.radius * (0.3 + progress * 1.2);
        const px = exp.x + Math.cos(angle) * particleDist;
        const py = exp.y + Math.sin(angle) * particleDist;
        const particleSize = 3 * (1 - progress);
        if (particleSize > 0.5) {
          this.graphics.fillStyle(exp.color, alpha * 0.7);
          this.graphics.fillCircle(px, py, particleSize);
        }
      }
    } else {
      // Impact explosion - quick flash
      const currentRadius = exp.radius * (0.5 + progress * 0.5);
      const alpha = 1 - progress * progress; // Faster fadeout

      // Outer flash
      this.graphics.fillStyle(exp.color, alpha * 0.4);
      this.graphics.fillCircle(exp.x, exp.y, currentRadius * 1.2);

      // Core flash
      this.graphics.fillStyle(0xffffff, alpha * 0.8);
      this.graphics.fillCircle(exp.x, exp.y, currentRadius * 0.4);

      // Colored middle
      this.graphics.fillStyle(exp.color, alpha * 0.7);
      this.graphics.fillCircle(exp.x, exp.y, currentRadius * 0.7);
    }
  }

  // Render labels above selected units and buildings
  private renderSelectedLabels(): void {
    // Labels for selected units
    for (const entity of this.entitySource.getUnits()) {
      if (entity.selectable?.selected && entity.unit) {
        const { x, y } = entity.transform;
        const { collisionRadius } = entity.unit;
        // Detect unit type by checking all weapons
        const weapons = entity.weapons ?? [];
        let weaponId = 'scout'; // default
        if (weapons.length > 1) {
          weaponId = 'arachnid';
        } else {
          // Loop through all weapons to get type
          for (const weapon of weapons) {
            weaponId = weapon.config.id;
          }
        }

        // Commander gets special label
        const name = entity.commander
          ? 'Commander'
          : UNIT_NAMES[weaponId] ?? weaponId;

        const label = this.getLabel();
        label.setText(name);
        label.setPosition(x, y - collisionRadius - 18); // Above health bar
      }
    }

    // Labels for selected buildings
    for (const entity of this.entitySource.getBuildings()) {
      if (entity.selectable?.selected && entity.building) {
        const { x, y } = entity.transform;
        const { height } = entity.building;

        // Determine building type using buildingType property
        let name = 'Building';
        if (entity.buildingType === 'factory') {
          name = 'Factory';
        } else if (entity.buildingType === 'solar') {
          name = 'Solar';
        }

        const label = this.getLabel();
        label.setText(name);
        label.setPosition(x, y - height / 2 - 14); // Above building
      }
    }
  }

  // Render range circles for selected units
  private renderRangeCircles(entity: Entity): void {
    if (!entity.unit) return;

    const { transform, weapons, builder } = entity;
    const { x, y } = transform;

    // Vision/tracking range (outermost - yellow) - show max seeRange from all weapons
    if (weapons && weapons.length > 0) {
      const maxSeeRange = Math.max(...weapons.map((w) => w.seeRange));
      this.graphics.lineStyle(1, VISION_RANGE_COLOR, 0.3);
      this.graphics.strokeCircle(x, y, maxSeeRange);

      // Fire range (red) - show max fireRange from all weapons
      const maxFireRange = Math.max(...weapons.map((w) => w.fireRange));
      this.graphics.lineStyle(1.5, WEAPON_RANGE_COLOR, 0.4);
      this.graphics.strokeCircle(x, y, maxFireRange);
    }

    // Build range (green) - only for builders
    if (builder) {
      this.graphics.lineStyle(1.5, BUILD_RANGE_COLOR, 0.4);
      this.graphics.strokeCircle(x, y, builder.buildRange);
    }
  }

  // ==================== COLOR PALETTE SYSTEM ====================
  // Each unit has access to: white, black, gray, base, light, dark

  private readonly WHITE = 0xf0f0f0;
  private readonly BLACK = 0x1a1a1a;
  private readonly GRAY = 0x606060;
  private readonly GRAY_LIGHT = 0x909090;

  // Get player color
  private getPlayerColor(playerId: number | undefined): number {
    if (playerId === undefined) return 0x888888;
    return PLAYER_COLORS[playerId]?.primary ?? 0x888888;
  }

  // Get light variant of a color (blend toward white)
  private getColorLight(baseColor: number): number {
    const r = (baseColor >> 16) & 0xff;
    const g = (baseColor >> 8) & 0xff;
    const b = baseColor & 0xff;
    const blend = 0.45;
    return (
      (Math.round(r + (240 - r) * blend) << 16) |
      (Math.round(g + (240 - g) * blend) << 8) |
      Math.round(b + (240 - b) * blend)
    );
  }

  // Get dark variant of a color (blend toward black)
  private getColorDark(baseColor: number): number {
    const r = (baseColor >> 16) & 0xff;
    const g = (baseColor >> 8) & 0xff;
    const b = baseColor & 0xff;
    const blend = 0.45;
    return (
      (Math.round(r * (1 - blend)) << 16) |
      (Math.round(g * (1 - blend)) << 8) |
      Math.round(b * (1 - blend))
    );
  }

  // Get projectile color (bright version of base color for visibility)
  private getProjectileColor(baseColor: number): number {
    return this.getColorLight(baseColor);
  }

  // Render a unit with unique visual style per weapon type
  // All draw methods receive the full entity and loop through all weapons
  private renderUnit(entity: Entity): void {
    if (!entity.unit) return;

    const { transform, unit, selectable, ownership } = entity;
    const { x, y, rotation } = transform;
    const { collisionRadius: radius, hp, maxHp } = unit;
    const isSelected = selectable?.selected ?? false;
    const playerId = ownership?.playerId;

    // Detect unit type by checking weapon configuration
    // Multi-weapon units (>1 weapon) are arachnids
    // Single-weapon units are identified by checking all weapons (which will all have same type)
    const weapons = entity.weapons ?? [];
    const weaponCount = weapons.length;
    let weaponId = 'scout'; // default
    if (weaponCount > 1) {
      weaponId = 'arachnid';
    } else if (weaponCount > 0) {
      // Check all weapons (for single-weapon units, this loops once)
      for (const weapon of weapons) {
        weaponId = weapon.config.id;
        break; // Use type from any weapon
      }
    }

    // Get color palette for this player
    const base = this.getPlayerColor(playerId);
    const light = this.getColorLight(base);
    const dark = this.getColorDark(base);

    // Selection ring (only on body pass)
    if (isSelected && !this.turretsOnly) {
      this.graphics.lineStyle(3, UNIT_SELECTED_COLOR, 1);
      this.graphics.strokeCircle(x, y, radius + 5);
    }

    // Draw unit based on weapon type - each draw method loops through all weapons
    switch (weaponId) {
      case 'scout':
        this.drawScoutUnit(
          x,
          y,
          radius,
          rotation,
          base,
          light,
          dark,
          isSelected,
          entity
        );
        break;
      case 'burst':
        this.drawBurstUnit(
          x,
          y,
          radius,
          rotation,
          base,
          light,
          dark,
          isSelected,
          entity
        );
        break;
      case 'beam':
        this.drawBeamUnit(
          x,
          y,
          radius,
          rotation,
          base,
          light,
          dark,
          isSelected,
          entity
        );
        break;
      case 'brawl':
        this.drawBrawlUnit(
          x,
          y,
          radius,
          rotation,
          base,
          light,
          dark,
          isSelected,
          entity
        );
        break;
      case 'mortar':
        this.drawMortarUnit(
          x,
          y,
          radius,
          rotation,
          base,
          light,
          dark,
          isSelected,
          entity
        );
        break;
      case 'snipe':
        this.drawSnipeUnit(
          x,
          y,
          radius,
          rotation,
          base,
          light,
          dark,
          isSelected,
          entity
        );
        break;
      case 'tank':
        this.drawTankUnit(
          x,
          y,
          radius,
          rotation,
          base,
          light,
          dark,
          isSelected,
          entity
        );
        break;
      case 'arachnid':
        this.drawArachnidUnit(
          x,
          y,
          radius,
          rotation,
          base,
          light,
          dark,
          isSelected,
          entity
        );
        break;
      case 'sonic':
        this.drawSonicUnit(
          x,
          y,
          radius,
          rotation,
          base,
          light,
          dark,
          isSelected,
          entity
        );
        break;
      default:
        this.drawScoutUnit(
          x,
          y,
          radius,
          rotation,
          base,
          light,
          dark,
          isSelected,
          entity
        );
    }

    // Commander indicator, health bar, target lines (only on body pass)
    if (!this.turretsOnly) {
      // Commander indicator (gold star/crown)
      if (entity.commander) {
        this.renderCommanderCrown(x, y, radius);
      }

      // Health bar (only show if damaged)
      const healthPercent = hp / maxHp;
      if (healthPercent < 1) {
        this.renderHealthBar(x, y - radius - 10, radius * 2, 4, healthPercent);
      }

      // Target lines when selected - show for all weapons
      if (entity.weapons && isSelected) {
        for (const weapon of entity.weapons) {
          if (weapon.targetEntityId != null) {
            const target = this.entitySource.getEntity(weapon.targetEntityId);
            if (target) {
              this.graphics.lineStyle(1, 0xff0000, 0.3);
              this.graphics.lineBetween(
                x,
                y,
                target.transform.x,
                target.transform.y
              );
            }
          }
        }
      }
    }
  }

  // ==================== UNIT TYPE RENDERERS ====================

  // Scout: Fast recon unit - 4 small treads, sleek diamond body
  private drawScoutUnit(
    x: number,
    y: number,
    r: number,
    bodyRot: number,
    base: number,
    light: number,
    dark: number,
    selected: boolean,
    entity: Entity
  ): void {
    // Body pass
    if (!this.turretsOnly) {
      const cos = Math.cos(bodyRot);
      const sin = Math.sin(bodyRot);

      // Get tread animation data
      const wheelSetup = this.getVehicleWheels(entity.id);

      // Four treads at corners
      const treadDistX = r * 0.6;
      const treadDistY = r * 0.7;
      const treadLength = r * 0.5;
      const treadWidth = r * 0.22;

      const treadPositions = [
        { dx: treadDistX, dy: treadDistY }, // Front right
        { dx: treadDistX, dy: -treadDistY }, // Front left
        { dx: -treadDistX, dy: treadDistY }, // Rear right
        { dx: -treadDistX, dy: -treadDistY }, // Rear left
      ];

      for (let i = 0; i < treadPositions.length; i++) {
        const tp = treadPositions[i];
        const tx = x + cos * tp.dx - sin * tp.dy;
        const ty = y + sin * tp.dx + cos * tp.dy;
        const treadRotation = wheelSetup?.wheels[i]?.getRotation() ?? 0;
        this.drawAnimatedTread(
          tx,
          ty,
          treadLength,
          treadWidth,
          bodyRot,
          treadRotation,
          this.BLACK,
          this.GRAY_LIGHT
        );
      }

      // Main body (diamond/rhombus shape) - light colored
      const bodyColor = selected ? UNIT_SELECTED_COLOR : light;
      this.graphics.fillStyle(bodyColor, 0.95);
      this.drawPolygon(x, y, r * 0.55, 4, bodyRot + Math.PI / 4);

      // Inner accent (base color)
      this.graphics.fillStyle(base, 0.85);
      this.drawPolygon(x, y, r * 0.35, 4, bodyRot + Math.PI / 4);

      // Center hub (dark)
      this.graphics.fillStyle(dark, 0.9);
      this.graphics.fillCircle(x, y, r * 0.15);

      // Turret mount (white)
      this.graphics.fillStyle(this.WHITE, 0.95);
      this.graphics.fillCircle(x, y, r * 0.1);
    }

    // Turret pass
    if (!this.skipTurrets) {
      const weapons = entity.weapons ?? [];
      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;
        // Triple rapid-fire barrels
        const turretLen = r * 1.0;
        this.graphics.lineStyle(1.5, dark, 0.9);
        for (let i = -1; i <= 1; i++) {
          const offset = i * 2;
          const perpX = Math.cos(turretRot + Math.PI / 2) * offset;
          const perpY = Math.sin(turretRot + Math.PI / 2) * offset;
          const endX = x + Math.cos(turretRot) * turretLen + perpX;
          const endY = y + Math.sin(turretRot) * turretLen + perpY;
          this.graphics.lineBetween(x + perpX, y + perpY, endX, endY);
        }
      }
    }
  }

  // Burst: Aggressive striker - 4 treads, angular wedge body
  private drawBurstUnit(
    x: number,
    y: number,
    r: number,
    bodyRot: number,
    base: number,
    light: number,
    dark: number,
    selected: boolean,
    entity: Entity
  ): void {
    // Body pass
    if (!this.turretsOnly) {
      const cos = Math.cos(bodyRot);
      const sin = Math.sin(bodyRot);

      // Get tread animation data
      const wheelSetup = this.getVehicleWheels(entity.id);

      // Four treads at corners
      const treadDistX = r * 0.65;
      const treadDistY = r * 0.75;
      const treadLength = r * 0.55;
      const treadWidth = r * 0.24;

      const treadPositions = [
        { dx: treadDistX, dy: treadDistY },
        { dx: treadDistX, dy: -treadDistY },
        { dx: -treadDistX, dy: treadDistY },
        { dx: -treadDistX, dy: -treadDistY },
      ];

      for (let i = 0; i < treadPositions.length; i++) {
        const tp = treadPositions[i];
        const tx = x + cos * tp.dx - sin * tp.dy;
        const ty = y + sin * tp.dx + cos * tp.dy;
        const treadRotation = wheelSetup?.wheels[i]?.getRotation() ?? 0;
        this.drawAnimatedTread(
          tx,
          ty,
          treadLength,
          treadWidth,
          bodyRot,
          treadRotation,
          this.BLACK,
          this.GRAY_LIGHT
        );
      }

      // Main body (aggressive triangle pointing forward) - dark colored
      const bodyColor = selected ? UNIT_SELECTED_COLOR : dark;
      this.graphics.fillStyle(bodyColor, 0.95);
      this.drawPolygon(x, y, r * 0.6, 3, bodyRot);

      // Inner wedge accent (base color)
      this.graphics.fillStyle(base, 0.85);
      this.drawPolygon(x, y, r * 0.38, 3, bodyRot);

      // Aggressive front stripe (light)
      this.graphics.fillStyle(light, 0.8);
      const stripeX = x + cos * r * 0.25;
      const stripeY = y + sin * r * 0.25;
      this.drawOrientedRect(stripeX, stripeY, r * 0.15, r * 0.35, bodyRot);

      // Turret mount (white)
      this.graphics.fillStyle(this.WHITE, 0.95);
      this.graphics.fillCircle(x, y, r * 0.12);
    }

    // Turret pass
    if (!this.skipTurrets) {
      const weapons = entity.weapons ?? [];
      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;
        // Dual burst cannons
        const turretLen = r * 1.1;
        this.graphics.lineStyle(2.5, base, 0.95);
        const perpDist = 3;
        const perpX = Math.cos(turretRot + Math.PI / 2) * perpDist;
        const perpY = Math.sin(turretRot + Math.PI / 2) * perpDist;
        const endX = x + Math.cos(turretRot) * turretLen;
        const endY = y + Math.sin(turretRot) * turretLen;
        this.graphics.lineBetween(
          x + perpX,
          y + perpY,
          endX + perpX,
          endY + perpY
        );
        this.graphics.lineBetween(
          x - perpX,
          y - perpY,
          endX - perpX,
          endY - perpY
        );
      }
    }
  }

  // Beam/Insect: 6-legged insect with a single beam laser
  private drawBeamUnit(
    x: number,
    y: number,
    r: number,
    bodyRot: number,
    base: number,
    light: number,
    dark: number,
    selected: boolean,
    entity: Entity
  ): void {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Body pass
    if (!this.turretsOnly) {
      const legConfig = LEG_STYLE_CONFIG.daddy;
      const legThickness = legConfig.thickness;
      const footSize = r * legConfig.footSizeMultiplier;

      // Get legs for this entity (creates them if they don't exist)
      const legs = this.getOrCreateLegs(entity, 'daddy');

      // Draw all 8 legs using the Leg class positions (daddy long legs style)
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const side = i < 4 ? -1 : 1; // First 4 legs are left side, last 4 are right side

        // Get positions from leg class
        const attach = leg.getAttachmentPoint(x, y, bodyRot);
        const foot = leg.getFootPosition();
        const knee = leg.getKneePosition(attach.x, attach.y, side);

        // Draw leg segments (both use dark team color)
        // Upper leg (slightly thicker)
        this.graphics.lineStyle(legThickness + 0.5, dark, 0.95);
        this.graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

        // Lower leg
        this.graphics.lineStyle(legThickness, dark, 0.9);
        this.graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

        // Knee joint (light team color)
        this.graphics.fillStyle(light, 0.9);
        this.graphics.fillCircle(knee.x, knee.y, legThickness);

        // Foot (light team color)
        this.graphics.fillStyle(light, 0.9);
        this.graphics.fillCircle(foot.x, foot.y, footSize);
      }

      // Body (hexagonal insect shape)
      const bodyColor = selected ? UNIT_SELECTED_COLOR : base;
      this.graphics.fillStyle(bodyColor, 0.95);

      // Draw body as elongated hexagon (insect-like)
      const bodyLength = r * 0.9;
      const bodyWidth = r * 0.55;
      const bodyPoints = [
        {
          x: x + cos * bodyLength - sin * bodyWidth * 0.3,
          y: y + sin * bodyLength + cos * bodyWidth * 0.3,
        },
        {
          x: x + cos * bodyLength * 0.4 - sin * bodyWidth,
          y: y + sin * bodyLength * 0.4 + cos * bodyWidth,
        },
        {
          x: x - cos * bodyLength * 0.5 - sin * bodyWidth * 0.7,
          y: y - sin * bodyLength * 0.5 + cos * bodyWidth * 0.7,
        },
        {
          x: x - cos * bodyLength - sin * bodyWidth * 0.3,
          y: y - sin * bodyLength + cos * bodyWidth * 0.3,
        },
        {
          x: x - cos * bodyLength + sin * bodyWidth * 0.3,
          y: y - sin * bodyLength - cos * bodyWidth * 0.3,
        },
        {
          x: x - cos * bodyLength * 0.5 + sin * bodyWidth * 0.7,
          y: y - sin * bodyLength * 0.5 - cos * bodyWidth * 0.7,
        },
        {
          x: x + cos * bodyLength * 0.4 + sin * bodyWidth,
          y: y + sin * bodyLength * 0.4 - cos * bodyWidth,
        },
        {
          x: x + cos * bodyLength + sin * bodyWidth * 0.3,
          y: y + sin * bodyLength - cos * bodyWidth * 0.3,
        },
      ];
      this.graphics.fillPoints(bodyPoints, true);

      // Inner carapace pattern (dark)
      this.graphics.fillStyle(dark, 0.8);
      this.drawPolygon(x, y, r * 0.4, 6, bodyRot);

      // Central eye/sensor (light glow)
      this.graphics.fillStyle(light, 0.9);
      this.graphics.fillCircle(x, y, r * 0.2);
      this.graphics.fillStyle(this.WHITE, 0.95);
      this.graphics.fillCircle(x, y, r * 0.1);
    }

    // Turret pass - single beam emitter at front
    if (!this.skipTurrets) {
      const weapons = entity.weapons ?? [];
      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;

        // Beam emitter mounted at front of body
        const emitterForwardOffset = r * 0.6;
        const emitterX = x + cos * emitterForwardOffset;
        const emitterY = y + sin * emitterForwardOffset;

        // Beam emitter base (glowing orb)
        this.graphics.fillStyle(light, 0.9);
        this.graphics.fillCircle(emitterX, emitterY, r * 0.18);

        // Beam barrel
        const beamLen = r * 0.7;
        const beamEndX = emitterX + Math.cos(turretRot) * beamLen;
        const beamEndY = emitterY + Math.sin(turretRot) * beamLen;
        this.graphics.lineStyle(4, light, 0.8);
        this.graphics.lineBetween(emitterX, emitterY, beamEndX, beamEndY);

        // Emitter glow at tip
        this.graphics.fillStyle(this.WHITE, 0.95);
        this.graphics.fillCircle(beamEndX, beamEndY, r * 0.12);
      }
    }
  }

  // Brawl: Heavy treaded unit - wide treads, bulky dark body, gray armor
  private drawBrawlUnit(
    x: number,
    y: number,
    r: number,
    bodyRot: number,
    base: number,
    light: number,
    dark: number,
    selected: boolean,
    entity: Entity
  ): void {
    // Body pass
    if (!this.turretsOnly) {
      const cos = Math.cos(bodyRot);
      const sin = Math.sin(bodyRot);

      // Get tread animation data
      const treads = this.getTankTreads(entity.id);

      // Two large treads on left and right sides (brawl is shorter than tank)
      const treadOffset = r * 0.85; // Distance from center to tread
      const treadLength = r * 1.7; // Slightly shorter than tank
      const treadWidth = r * 0.55; // Wide treads

      for (const side of [-1, 1]) {
        const offsetX = -sin * treadOffset * side;
        const offsetY = cos * treadOffset * side;

        // Get tread rotation for this side
        const tread = side === -1 ? treads?.leftTread : treads?.rightTread;
        const treadRotation = tread?.getRotation() ?? 0;

        // Draw animated tread
        const tx = x + offsetX;
        const ty = y + offsetY;
        this.drawAnimatedTread(
          tx,
          ty,
          treadLength,
          treadWidth,
          bodyRot,
          treadRotation,
          this.BLACK,
          this.GRAY_LIGHT
        );
      }

      // Body (pentagon) - dark with gray armor plates
      const bodyColor = selected ? UNIT_SELECTED_COLOR : dark;
      this.graphics.fillStyle(bodyColor, 0.95);
      this.drawPolygon(x, y, r * 0.8, 5, bodyRot);

      // Gray armor plate
      this.graphics.fillStyle(this.GRAY, 0.8);
      this.drawPolygon(x, y, r * 0.5, 5, bodyRot);

      // Base color accent ring
      this.graphics.lineStyle(2, base, 0.9);
      this.graphics.strokeCircle(x, y, r * 0.35);

      // White muzzle
      this.graphics.fillStyle(this.WHITE, 0.9);
      this.graphics.fillCircle(x, y, r * 0.18);
    }

    // Turret pass
    if (!this.skipTurrets) {
      const weapons = entity.weapons ?? [];
      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;
        // Wide shotgun barrel (light)
        const turretLen = r * 1.0;
        const endX = x + Math.cos(turretRot) * turretLen;
        const endY = y + Math.sin(turretRot) * turretLen;
        this.graphics.lineStyle(5, light, 0.85);
        this.graphics.lineBetween(
          x,
          y,
          endX * 0.9 + x * 0.1,
          endY * 0.9 + y * 0.1
        );
      }
    }
  }

  // Mortar: Artillery platform - 4 treads, hexagonal base, mortar tube
  private drawMortarUnit(
    x: number,
    y: number,
    r: number,
    bodyRot: number,
    base: number,
    light: number,
    dark: number,
    selected: boolean,
    entity: Entity
  ): void {
    // Body pass
    if (!this.turretsOnly) {
      const cos = Math.cos(bodyRot);
      const sin = Math.sin(bodyRot);

      // Get tread animation data
      const wheelSetup = this.getVehicleWheels(entity.id);

      // Four treads at corners
      const treadDistX = r * 0.65;
      const treadDistY = r * 0.7;
      const treadLength = r * 0.5;
      const treadWidth = r * 0.22;

      const treadPositions = [
        { dx: treadDistX, dy: treadDistY },
        { dx: treadDistX, dy: -treadDistY },
        { dx: -treadDistX, dy: treadDistY },
        { dx: -treadDistX, dy: -treadDistY },
      ];

      for (let i = 0; i < treadPositions.length; i++) {
        const tp = treadPositions[i];
        const tx = x + cos * tp.dx - sin * tp.dy;
        const ty = y + sin * tp.dx + cos * tp.dy;
        const treadRotation = wheelSetup?.wheels[i]?.getRotation() ?? 0;
        this.drawAnimatedTread(
          tx,
          ty,
          treadLength,
          treadWidth,
          bodyRot,
          treadRotation,
          this.BLACK,
          this.GRAY_LIGHT
        );
      }

      // Main body (hexagon) - gray base
      const bodyColor = selected ? UNIT_SELECTED_COLOR : this.GRAY;
      this.graphics.fillStyle(bodyColor, 0.95);
      this.drawPolygon(x, y, r * 0.55, 6, bodyRot);

      // Inner platform (base color)
      this.graphics.fillStyle(base, 0.85);
      this.drawPolygon(x, y, r * 0.4, 6, bodyRot);

      // Artillery base plate (dark)
      this.graphics.fillStyle(dark, 0.9);
      this.graphics.fillCircle(x, y, r * 0.25);

      // Turret pivot (white)
      this.graphics.fillStyle(this.WHITE, 0.95);
      this.graphics.fillCircle(x, y, r * 0.12);
    }

    // Turret pass
    if (!this.skipTurrets) {
      const weapons = entity.weapons ?? [];
      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;
        // Thick mortar tube
        const turretLen = r * 0.75;
        const endX = x + Math.cos(turretRot) * turretLen;
        const endY = y + Math.sin(turretRot) * turretLen;
        this.graphics.lineStyle(6, light, 0.9);
        this.graphics.lineBetween(x, y, endX, endY);

        // Muzzle ring (white)
        this.graphics.lineStyle(2, this.WHITE, 0.95);
        this.graphics.strokeCircle(endX, endY, r * 0.12);
      }
    }
  }

  // Snipe: Long-range sniper platform - 4 treads, elongated body, precision barrel
  private drawSnipeUnit(
    x: number,
    y: number,
    r: number,
    bodyRot: number,
    base: number,
    light: number,
    dark: number,
    selected: boolean,
    entity: Entity
  ): void {
    // Body pass
    if (!this.turretsOnly) {
      const cos = Math.cos(bodyRot);
      const sin = Math.sin(bodyRot);

      // Get tread animation data
      const wheelSetup = this.getVehicleWheels(entity.id);

      // Four treads at corners
      const treadDistX = r * 0.7;
      const treadDistY = r * 0.6;
      const treadLength = r * 0.55;
      const treadWidth = r * 0.2;

      const treadPositions = [
        { dx: treadDistX, dy: treadDistY },
        { dx: treadDistX, dy: -treadDistY },
        { dx: -treadDistX, dy: treadDistY },
        { dx: -treadDistX, dy: -treadDistY },
      ];

      for (let i = 0; i < treadPositions.length; i++) {
        const tp = treadPositions[i];
        const tx = x + cos * tp.dx - sin * tp.dy;
        const ty = y + sin * tp.dx + cos * tp.dy;
        const treadRotation = wheelSetup?.wheels[i]?.getRotation() ?? 0;
        this.drawAnimatedTread(
          tx,
          ty,
          treadLength,
          treadWidth,
          bodyRot,
          treadRotation,
          this.BLACK,
          this.GRAY_LIGHT
        );
      }

      // Main body (elongated rectangle) - light colored, high-tech
      const bodyColor = selected ? UNIT_SELECTED_COLOR : light;
      this.graphics.fillStyle(bodyColor, 0.95);
      this.drawOrientedRect(x, y, r * 1.2, r * 0.5, bodyRot);

      // Dark tech core
      this.graphics.fillStyle(dark, 0.85);
      this.drawOrientedRect(x, y, r * 0.8, r * 0.35, bodyRot);

      // Base color targeting stripe
      this.graphics.fillStyle(base, 0.9);
      this.drawOrientedRect(
        x - cos * r * 0.25,
        y - sin * r * 0.25,
        r * 0.1,
        r * 0.3,
        bodyRot
      );

      // Scope/sensor array (white)
      this.graphics.fillStyle(this.WHITE, 0.95);
      this.graphics.fillCircle(x, y, r * 0.1);
    }

    // Turret pass
    if (!this.skipTurrets) {
      const weapons = entity.weapons ?? [];
      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;
        // Long precision sniper barrel
        const turretLen = r * 1.6;
        const endX = x + Math.cos(turretRot) * turretLen;
        const endY = y + Math.sin(turretRot) * turretLen;
        this.graphics.lineStyle(2.5, this.GRAY, 0.95);
        this.graphics.lineBetween(x, y, endX, endY);

        // Muzzle tip (light)
        this.graphics.fillStyle(light, 0.9);
        this.graphics.fillCircle(endX, endY, r * 0.08);
      }
    }
  }

  // Tank: Heavy tracked unit - massive treads, square turret, thick cannon
  private drawTankUnit(
    x: number,
    y: number,
    r: number,
    bodyRot: number,
    base: number,
    light: number,
    dark: number,
    selected: boolean,
    entity: Entity
  ): void {
    // Body pass
    if (!this.turretsOnly) {
      const cos = Math.cos(bodyRot);
      const sin = Math.sin(bodyRot);

      // Get tread rotation for animation
      const treads = this.getTankTreads(entity.id);

      // Two massive treads on left and right sides
      const treadOffset = r * 0.9; // Distance from center to tread
      const treadLength = r * 2.0; // Very long treads
      const treadWidth = r * 0.6; // Wide treads

      for (const side of [-1, 1]) {
        const offsetX = -sin * treadOffset * side;
        const offsetY = cos * treadOffset * side;

        // Get tread rotation for this side
        const tread = side === -1 ? treads?.leftTread : treads?.rightTread;
        const treadRotation = tread?.getRotation() ?? 0;

        // Draw animated tread
        const tx = x + offsetX;
        const ty = y + offsetY;
        this.drawAnimatedTread(
          tx,
          ty,
          treadLength,
          treadWidth,
          bodyRot,
          treadRotation,
          this.BLACK,
          this.GRAY_LIGHT
        );
      }

      // Hull (square) - base color
      const bodyColor = selected ? UNIT_SELECTED_COLOR : base;
      this.graphics.fillStyle(bodyColor, 0.95);
      this.drawPolygon(x, y, r * 0.85, 4, bodyRot);

      // Gray armor plate on hull
      this.graphics.fillStyle(this.GRAY, 0.85);
      this.drawPolygon(x, y, r * 0.55, 4, bodyRot);

      // Black inner
      this.graphics.fillStyle(this.BLACK, 0.8);
      this.graphics.fillCircle(x, y, r * 0.28);

      // Turret pivot (white)
      this.graphics.fillStyle(this.WHITE, 0.9);
      this.graphics.fillCircle(x, y, r * 0.18);
    }

    // Turret pass
    if (!this.skipTurrets) {
      const weapons = entity.weapons ?? [];
      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;
        // Heavy cannon barrel (light with dark muzzle)
        const turretLen = r * 1.4;
        const endX = x + Math.cos(turretRot) * turretLen;
        const endY = y + Math.sin(turretRot) * turretLen;
        this.graphics.lineStyle(7, light, 0.9);
        this.graphics.lineBetween(x, y, endX, endY);

        // Muzzle brake (dark)
        this.graphics.fillStyle(dark, 1);
        this.graphics.fillCircle(endX, endY, r * 0.2);
      }
    }
  }

  // Arachnid: Titan spider unit - 8 animated legs, 8 beam weapons
  private drawArachnidUnit(
    x: number,
    y: number,
    r: number,
    bodyRot: number,
    base: number,
    light: number,
    dark: number,
    selected: boolean,
    entity: Entity
  ): void {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Body pass
    if (!this.turretsOnly) {
      const legConfig = LEG_STYLE_CONFIG.arachnid;
      const legThickness = legConfig.thickness;
      const footSize = r * legConfig.footSizeMultiplier;

      // Get legs for this entity (creates them if they don't exist)
      const legs = this.getOrCreateLegs(entity, 'arachnid');

      // Draw all 8 legs using the Leg class positions
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const side = i < 4 ? -1 : 1; // First 4 legs are left side, last 4 are right side

        // Get positions from leg class
        const attach = leg.getAttachmentPoint(x, y, bodyRot);
        const foot = leg.getFootPosition();
        const knee = leg.getKneePosition(attach.x, attach.y, side);

        // Draw leg segments (both use dark team color)
        // Upper leg (slightly thicker)
        this.graphics.lineStyle(legThickness + 1, dark, 0.95);
        this.graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

        // Lower leg
        this.graphics.lineStyle(legThickness, dark, 0.9);
        this.graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

        // Knee joint (light team color)
        this.graphics.fillStyle(light, 0.9);
        this.graphics.fillCircle(knee.x, knee.y, legThickness);

        // Foot (light team color)
        this.graphics.fillStyle(light, 0.9);
        this.graphics.fillCircle(foot.x, foot.y, footSize);
      }

      // Main body (elongated octagon/oval shape)
      const bodyColor = selected ? UNIT_SELECTED_COLOR : dark;
      this.graphics.fillStyle(bodyColor, 0.95);

      // Draw body as elongated hexagon
      const bodyLength = r * 1.2;
      const bodyWidth = r * 0.7;
      const bodyPoints = [
        {
          x: x + cos * bodyLength - sin * bodyWidth * 0.5,
          y: y + sin * bodyLength + cos * bodyWidth * 0.5,
        },
        {
          x: x + cos * bodyLength * 0.7 - sin * bodyWidth,
          y: y + sin * bodyLength * 0.7 + cos * bodyWidth,
        },
        {
          x: x - cos * bodyLength * 0.3 - sin * bodyWidth,
          y: y - sin * bodyLength * 0.3 + cos * bodyWidth,
        },
        {
          x: x - cos * bodyLength - sin * bodyWidth * 0.5,
          y: y - sin * bodyLength + cos * bodyWidth * 0.5,
        },
        {
          x: x - cos * bodyLength + sin * bodyWidth * 0.5,
          y: y - sin * bodyLength - cos * bodyWidth * 0.5,
        },
        {
          x: x - cos * bodyLength * 0.3 + sin * bodyWidth,
          y: y - sin * bodyLength * 0.3 - cos * bodyWidth,
        },
        {
          x: x + cos * bodyLength * 0.7 + sin * bodyWidth,
          y: y + sin * bodyLength * 0.7 - cos * bodyWidth,
        },
        {
          x: x + cos * bodyLength + sin * bodyWidth * 0.5,
          y: y + sin * bodyLength - cos * bodyWidth * 0.5,
        },
      ];
      this.graphics.fillPoints(bodyPoints, true);

      // Inner carapace pattern (base color) - shifted forward
      const hexForwardOffset = r * 0.35;
      const hexCenterX = x + cos * hexForwardOffset;
      const hexCenterY = y + sin * hexForwardOffset;
      this.graphics.fillStyle(base, 0.8);
      this.drawPolygon(hexCenterX, hexCenterY, r * 0.5, 6, bodyRot);

      // Central eye/sensor cluster (light) - at hexagon center
      this.graphics.fillStyle(light, 0.9);
      this.graphics.fillCircle(hexCenterX, hexCenterY, r * 0.25);
      this.graphics.fillStyle(this.WHITE, 0.95);
      this.graphics.fillCircle(hexCenterX, hexCenterY, r * 0.12);
    }

    // Turret pass - 6 beam emitters at hexagon points
    if (!this.skipTurrets) {
      const weapons = entity.weapons ?? [];
      const hexRadius = r * 0.5;
      const hexForwardOffset = r * 0.35; // Match the forward shift

      // 6 beam emitters at hexagon vertices (shifted forward)
      for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI) / 3; // 0, 60, 120, 180, 240, 300 degrees
        const localX = Math.cos(angle) * hexRadius + hexForwardOffset;
        const localY = Math.sin(angle) * hexRadius;
        const emitterX = x + cos * localX - sin * localY;
        const emitterY = y + sin * localX + cos * localY;

        // Get turret rotation for this weapon
        const weaponTurret = weapons[i]?.turretRotation ?? bodyRot;

        // Beam emitter (glowing orb)
        this.graphics.fillStyle(light, 0.9);
        this.graphics.fillCircle(emitterX, emitterY, r * 0.1);

        // Beam barrel
        const beamLen = r * 0.5;
        const beamEndX = emitterX + Math.cos(weaponTurret) * beamLen;
        const beamEndY = emitterY + Math.sin(weaponTurret) * beamLen;
        this.graphics.lineStyle(2.5, light, 0.8);
        this.graphics.lineBetween(emitterX, emitterY, beamEndX, beamEndY);

        // Emitter tip glow
        this.graphics.fillStyle(this.WHITE, 0.8);
        this.graphics.fillCircle(beamEndX, beamEndY, r * 0.06);
      }
    }
  }

  // Sonic: Small 6-legged insect with central wave emitter orb
  private drawSonicUnit(
    x: number,
    y: number,
    r: number,
    bodyRot: number,
    base: number,
    light: number,
    dark: number,
    selected: boolean,
    entity: Entity
  ): void {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Body pass
    if (!this.turretsOnly) {
      const legConfig = LEG_STYLE_CONFIG.insect;
      const legThickness = legConfig.thickness;
      const footSize = r * legConfig.footSizeMultiplier;

      // Get legs for this entity (creates them if they don't exist)
      const legs = this.getOrCreateLegs(entity, 'insect');

      // Draw all 6 legs (insect style)
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const side = i < 3 ? -1 : 1; // First 3 legs are left, last 3 are right

        const attach = leg.getAttachmentPoint(x, y, bodyRot);
        const foot = leg.getFootPosition();
        const knee = leg.getKneePosition(attach.x, attach.y, side);

        // Draw leg segments (both use dark team color)
        // Upper leg (slightly thicker)
        this.graphics.lineStyle(legThickness + 0.5, dark, 0.95);
        this.graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

        // Lower leg
        this.graphics.lineStyle(legThickness, dark, 0.9);
        this.graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

        // Knee joint (light team color)
        this.graphics.fillStyle(light, 0.9);
        this.graphics.fillCircle(knee.x, knee.y, legThickness * 0.4);

        // Foot (light team color)
        this.graphics.fillStyle(light, 0.9);
        this.graphics.fillCircle(foot.x, foot.y, footSize);
      }

      // Body (compact oval shape)
      const bodyColor = selected ? UNIT_SELECTED_COLOR : base;
      this.graphics.fillStyle(bodyColor, 0.95);

      // Draw compact body as rounded hexagon
      const bodyLength = r * 0.6;
      const bodyWidth = r * 0.5;
      const bodyPoints = [
        {
          x: x + cos * bodyLength - sin * bodyWidth * 0.3,
          y: y + sin * bodyLength + cos * bodyWidth * 0.3,
        },
        {
          x: x + cos * bodyLength * 0.5 - sin * bodyWidth,
          y: y + sin * bodyLength * 0.5 + cos * bodyWidth,
        },
        {
          x: x - cos * bodyLength * 0.5 - sin * bodyWidth * 0.8,
          y: y - sin * bodyLength * 0.5 + cos * bodyWidth * 0.8,
        },
        {
          x: x - cos * bodyLength - sin * bodyWidth * 0.3,
          y: y - sin * bodyLength + cos * bodyWidth * 0.3,
        },
        {
          x: x - cos * bodyLength + sin * bodyWidth * 0.3,
          y: y - sin * bodyLength - cos * bodyWidth * 0.3,
        },
        {
          x: x - cos * bodyLength * 0.5 + sin * bodyWidth * 0.8,
          y: y - sin * bodyLength * 0.5 - cos * bodyWidth * 0.8,
        },
        {
          x: x + cos * bodyLength * 0.5 + sin * bodyWidth,
          y: y + sin * bodyLength * 0.5 - cos * bodyWidth,
        },
        {
          x: x + cos * bodyLength + sin * bodyWidth * 0.3,
          y: y + sin * bodyLength - cos * bodyWidth * 0.3,
        },
      ];
      this.graphics.fillPoints(bodyPoints, true);

      // Inner pattern (dark)
      this.graphics.fillStyle(dark, 0.8);
      this.drawPolygon(x, y, r * 0.3, 6, bodyRot);

      // Central orb base (light glow)
      this.graphics.fillStyle(light, 0.9);
      this.graphics.fillCircle(x, y, r * 0.25);
      this.graphics.fillStyle(this.WHITE, 0.95);
      this.graphics.fillCircle(x, y, r * 0.15);
    }

    // Turret pass - wave effect emanating from central orb
    if (!this.skipTurrets) {
      const weapons = entity.weapons ?? [];
      for (const weapon of weapons) {
        // Use dynamic slice angle - render when angle > 0 (expanding, active, or cooldown)
        const sliceAngle = weapon.currentSliceAngle ?? 0;
        if (sliceAngle <= 0) continue;

        const turretRot = weapon.turretRotation;
        const maxRange = weapon.fireRange;

        // Render pie-slice wave effect
        this.renderWaveEffect(
          x,
          y,
          turretRot,
          sliceAngle,
          maxRange,
          light,
          base
        );
      }
    }
  }

  // Render wave weapon pie-slice effect with pulsing sine waves
  private renderWaveEffect(
    x: number,
    y: number,
    rotation: number,
    sliceAngle: number, // Total angle of the pie slice
    maxRange: number,
    primaryColor: number,
    _secondaryColor: number
  ): void {
    // Pulsing animation based on time
    const time = Date.now() / 1000;
    const pulseSpeed = 3; // Pulses per second
    const waveCount = 6; // Number of wave arcs
    const halfAngle = sliceAngle / 2;

    // Draw multiple fading fill layers to create soft edge gradient
    const gradientLayers = 5;
    for (let layer = 0; layer < gradientLayers; layer++) {
      const layerRatio = (gradientLayers - layer) / gradientLayers;
      const layerRadius = maxRange * layerRatio;
      const layerAlpha = 0.08 * (1 - layer / gradientLayers); // Fade out toward center

      this.graphics.fillStyle(primaryColor, layerAlpha);
      this.graphics.beginPath();
      this.graphics.moveTo(x, y);
      this.graphics.arc(
        x,
        y,
        layerRadius,
        rotation - halfAngle,
        rotation + halfAngle,
        false
      );
      this.graphics.closePath();
      this.graphics.fill();
    }

    // Draw pulsing sine wave arcs that fade toward the edge
    for (let i = 0; i < waveCount; i++) {
      // Each wave pulses outward
      const basePhase = (time * pulseSpeed + i / waveCount) % 1;
      const waveRadius = basePhase * maxRange;

      // Fade out as wave approaches edge
      const edgeFade = 1 - basePhase;
      const alpha = 0.5 * edgeFade;

      if (alpha < 0.05) continue; // Skip nearly invisible waves

      // Draw arc with sine wave modulation
      const segments = 16;
      this.graphics.lineStyle(2.5 * edgeFade + 0.5, primaryColor, alpha);
      this.graphics.beginPath();

      for (let j = 0; j <= segments; j++) {
        const t = j / segments;
        const angle = rotation - halfAngle + t * sliceAngle;

        // Add sine wave ripple perpendicular to arc direction
        const sineOffset = Math.sin(t * Math.PI * 4 + time * 10) * 4 * edgeFade;
        const r = waveRadius + sineOffset;

        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;

        if (j === 0) {
          this.graphics.moveTo(px, py);
        } else {
          this.graphics.lineTo(px, py);
        }
      }
      this.graphics.strokePath();
    }
  }

  // ==================== SHAPE HELPERS ====================

  private drawPolygon(
    x: number,
    y: number,
    radius: number,
    sides: number,
    rotation: number
  ): void {
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = rotation + (i / sides) * Math.PI * 2;
      points.push({
        x: x + Math.cos(angle) * radius,
        y: y + Math.sin(angle) * radius,
      });
    }
    this.graphics.fillPoints(points, true);
  }

  private drawOrientedRect(
    x: number,
    y: number,
    length: number,
    width: number,
    rotation: number
  ): void {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const halfLength = length / 2;
    const halfWidth = width / 2;

    const points = [
      {
        x: x + cos * halfLength - sin * halfWidth,
        y: y + sin * halfLength + cos * halfWidth,
      },
      {
        x: x + cos * halfLength + sin * halfWidth,
        y: y + sin * halfLength - cos * halfWidth,
      },
      {
        x: x - cos * halfLength + sin * halfWidth,
        y: y - sin * halfLength - cos * halfWidth,
      },
      {
        x: x - cos * halfLength - sin * halfWidth,
        y: y - sin * halfLength + cos * halfWidth,
      },
    ];
    this.graphics.fillPoints(points, true);
  }

  // Draw an animated tread (track system) at the given position
  // treadRotation is the animation value from the Tread class
  private drawAnimatedTread(
    x: number,
    y: number,
    treadLength: number,
    treadWidth: number,
    bodyRot: number,
    treadRotation: number,
    treadColor: number = this.BLACK,
    lineColor: number = this.GRAY
  ): void {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Draw tread body (dark rectangle)
    this.graphics.fillStyle(treadColor, 0.95);
    this.drawOrientedRect(x, y, treadLength, treadWidth, bodyRot);

    // Draw tread outline for visibility
    this.graphics.lineStyle(1.5, lineColor, 0.9);
    const halfLen = treadLength / 2;
    const halfWid = treadWidth / 2;
    const corners = [
      {
        x: x + cos * halfLen - sin * halfWid,
        y: y + sin * halfLen + cos * halfWid,
      },
      {
        x: x + cos * halfLen + sin * halfWid,
        y: y + sin * halfLen - cos * halfWid,
      },
      {
        x: x - cos * halfLen + sin * halfWid,
        y: y - sin * halfLen - cos * halfWid,
      },
      {
        x: x - cos * halfLen - sin * halfWid,
        y: y - sin * halfLen + cos * halfWid,
      },
    ];
    this.graphics.lineBetween(
      corners[0].x,
      corners[0].y,
      corners[1].x,
      corners[1].y
    );
    this.graphics.lineBetween(
      corners[2].x,
      corners[2].y,
      corners[3].x,
      corners[3].y
    );

    // Calculate line spacing and animation offset - more lines for better visibility
    const numLines = 7;
    const lineSpacing = treadLength / (numLines + 1);
    const wheelRadius = treadWidth * 0.35;
    const linearOffset = treadRotation * wheelRadius;
    const normalizedOffset =
      ((linearOffset % lineSpacing) + lineSpacing) % lineSpacing;

    // Draw animated tread lines (thick and obvious - striations that grip the ground)
    this.graphics.lineStyle(4, lineColor, 0.9);
    for (let i = 0; i <= numLines; i++) {
      let lineOffset = (i - numLines / 2) * lineSpacing + normalizedOffset;
      // Clamp to visible range
      if (lineOffset > treadLength * 0.45) lineOffset -= lineSpacing;
      if (lineOffset < -treadLength * 0.45) lineOffset += lineSpacing;

      const lx = x + cos * lineOffset;
      const ly = y + sin * lineOffset;
      const perpX = -sin * treadWidth * 0.45;
      const perpY = cos * treadWidth * 0.45;
      this.graphics.lineBetween(lx - perpX, ly - perpY, lx + perpX, ly + perpY);
    }

    // Draw drive wheels at each end (larger and more visible)
    this.graphics.fillStyle(lineColor, 0.95);
    const endOffset = treadLength * 0.42;
    const wheelSize = treadWidth * 0.35;
    this.graphics.fillCircle(
      x + cos * endOffset,
      y + sin * endOffset,
      wheelSize
    );
    this.graphics.fillCircle(
      x - cos * endOffset,
      y - sin * endOffset,
      wheelSize
    );

    // Draw rotating spokes on drive wheels
    this.graphics.lineStyle(1.5, treadColor, 0.9);
    for (const endDir of [1, -1]) {
      const wx = x + cos * endOffset * endDir;
      const wy = y + sin * endOffset * endDir;
      for (let spoke = 0; spoke < 4; spoke++) {
        const spokeAngle = treadRotation + (spoke * Math.PI) / 2;
        const spokeEndX = wx + Math.cos(spokeAngle) * wheelSize * 0.8;
        const spokeEndY = wy + Math.sin(spokeAngle) * wheelSize * 0.8;
        this.graphics.lineBetween(wx, wy, spokeEndX, spokeEndY);
      }
    }
  }

  // Render commander crown
  private renderCommanderCrown(x: number, y: number, radius: number): void {
    // Gold circle
    this.graphics.lineStyle(2, COMMANDER_COLOR, 0.9);
    this.graphics.strokeCircle(x, y, radius + 8);

    // Crown points (5 points)
    const dotCount = 5;
    for (let i = 0; i < dotCount; i++) {
      const angle = (i / dotCount) * Math.PI * 2 - Math.PI / 2;
      const dotX = x + Math.cos(angle) * (radius + 8);
      const dotY = y + Math.sin(angle) * (radius + 8);
      // Star shape at each point
      this.graphics.fillStyle(COMMANDER_COLOR, 1);
      this.drawStar(dotX, dotY, 4, 5);
    }

    // Inner gold ring
    this.graphics.lineStyle(1, COMMANDER_COLOR, 0.5);
    this.graphics.strokeCircle(x, y, radius + 3);
  }

  private drawStar(x: number, y: number, size: number, points: number): void {
    const starPoints: { x: number; y: number }[] = [];
    for (let i = 0; i < points * 2; i++) {
      const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? size : size * 0.4;
      starPoints.push({
        x: x + Math.cos(angle) * r,
        y: y + Math.sin(angle) * r,
      });
    }
    this.graphics.fillPoints(starPoints, true);
  }

  // Render action queue for a selected unit
  private renderWaypoints(entity: Entity): void {
    if (!entity.unit || entity.unit.actions.length === 0) return;

    const { transform, unit } = entity;
    const camera = this.scene.cameras.main;
    const lineWidth = 2 / camera.zoom;
    const dotRadius = 6 / camera.zoom;

    const actions = unit.actions;
    let prevX = transform.x;
    let prevY = transform.y;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const color = ACTION_COLORS[action.type];

      // Draw line from previous point to this action target
      this.graphics.lineStyle(lineWidth, color, 0.5);
      this.graphics.lineBetween(prevX, prevY, action.x, action.y);

      // Draw dot at action target
      this.graphics.fillStyle(color, 0.8);
      this.graphics.fillCircle(action.x, action.y, dotRadius);

      // Draw outline around dot
      this.graphics.lineStyle(lineWidth * 0.5, 0xffffff, 0.6);
      this.graphics.strokeCircle(action.x, action.y, dotRadius);

      // For build/repair actions, draw a square instead of circle
      if (action.type === 'build' || action.type === 'repair') {
        this.graphics.lineStyle(lineWidth, color, 0.8);
        this.graphics.strokeRect(
          action.x - dotRadius,
          action.y - dotRadius,
          dotRadius * 2,
          dotRadius * 2
        );
      }

      prevX = action.x;
      prevY = action.y;
    }

    // If patrol, draw line from last action back to first patrol action
    if (unit.patrolStartIndex !== null && actions.length > 0) {
      const lastAction = actions[actions.length - 1];
      const firstPatrolAction = actions[unit.patrolStartIndex];
      if (lastAction.type === 'patrol' && firstPatrolAction) {
        const color = ACTION_COLORS['patrol'];
        // Draw dashed-style return line (using lower alpha)
        this.graphics.lineStyle(lineWidth, color, 0.25);
        this.graphics.lineBetween(
          lastAction.x,
          lastAction.y,
          firstPatrolAction.x,
          firstPatrolAction.y
        );
      }
    }
  }

  // Render waypoints for a selected factory
  private renderFactoryWaypoints(entity: Entity): void {
    if (!entity.factory || entity.factory.waypoints.length === 0) return;

    const { transform, factory } = entity;
    const camera = this.scene.cameras.main;
    const lineWidth = 2 / camera.zoom;
    const dotRadius = 6 / camera.zoom;

    const waypoints = factory.waypoints;
    let prevX = transform.x;
    let prevY = transform.y;

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      const color = WAYPOINT_COLORS[wp.type];

      // Draw line from previous point to this waypoint
      this.graphics.lineStyle(lineWidth, color, 0.5);
      this.graphics.lineBetween(prevX, prevY, wp.x, wp.y);

      // Draw dot at waypoint
      this.graphics.fillStyle(color, 0.8);
      this.graphics.fillCircle(wp.x, wp.y, dotRadius);

      // Draw outline around dot
      this.graphics.lineStyle(lineWidth * 0.5, 0xffffff, 0.6);
      this.graphics.strokeCircle(wp.x, wp.y, dotRadius);

      // Draw a small flag marker on last waypoint to indicate rally point
      if (i === waypoints.length - 1) {
        this.graphics.fillStyle(color, 0.9);
        this.graphics.fillTriangle(
          wp.x,
          wp.y - 10,
          wp.x + 10,
          wp.y - 5,
          wp.x,
          wp.y
        );
        this.graphics.lineStyle(1, color, 1);
        this.graphics.lineBetween(wp.x, wp.y, wp.x, wp.y - 10);
      }

      prevX = wp.x;
      prevY = wp.y;
    }

    // If last waypoint is patrol, draw line back to first patrol waypoint
    if (waypoints.length > 0) {
      const lastWp = waypoints[waypoints.length - 1];
      if (lastWp.type === 'patrol') {
        // Find first patrol waypoint
        const firstPatrolIndex = waypoints.findIndex(
          (wp) => wp.type === 'patrol'
        );
        if (firstPatrolIndex >= 0) {
          const firstPatrolWp = waypoints[firstPatrolIndex];
          const color = WAYPOINT_COLORS['patrol'];
          // Draw dashed-style return line (using lower alpha)
          this.graphics.lineStyle(lineWidth, color, 0.25);
          this.graphics.lineBetween(
            lastWp.x,
            lastWp.y,
            firstPatrolWp.x,
            firstPatrolWp.y
          );
        }
      }
    }
  }

  // Render spray effect from commander to target (build/heal)
  private renderSprayEffect(target: SprayTarget): void {
    const color =
      target.type === 'build' ? SPRAY_BUILD_COLOR : SPRAY_HEAL_COLOR;
    const { sourceX, sourceY, targetX, targetY, intensity } = target;

    // Calculate direction vector
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return;

    const dirX = dx / dist;
    const dirY = dy / dist;

    // Perpendicular vector for spray width
    const perpX = -dirY;
    const perpY = dirX;

    // Calculate target size for spread
    let targetSize = 30; // default
    if (target.targetWidth && target.targetHeight) {
      targetSize = Math.max(target.targetWidth, target.targetHeight);
    } else if (target.targetRadius) {
      targetSize = target.targetRadius * 2;
    }

    // Scale particle count based on intensity (energy rate)
    // At full intensity: 12 streams x 20 particles = 240 particles
    // At minimum (10%): 4 streams x 6 particles = 24 particles
    const effectiveIntensity = intensity ?? 1;
    const streamCount = Math.max(4, Math.floor(12 * effectiveIntensity));
    const particlesPerStream = Math.max(6, Math.floor(20 * effectiveIntensity));
    const baseTime = this.sprayParticleTime;

    for (let stream = 0; stream < streamCount; stream++) {
      // Each stream has a different angle offset (fan pattern)
      const streamAngle = (stream / (streamCount - 1) - 0.5) * 1.2; // -0.6 to 0.6 radians spread

      for (let i = 0; i < particlesPerStream; i++) {
        // Each particle has a different phase
        const phase =
          (baseTime / 250 + i / particlesPerStream + stream * 0.13) % 1;

        // Particle position along the path (0 = source, 1 = target)
        const t = phase;

        // Base position along path with stream angle offset
        const streamOffsetX = perpX * streamAngle * t * targetSize * 0.8;
        const streamOffsetY = perpY * streamAngle * t * targetSize * 0.8;

        let px = sourceX + dx * t + streamOffsetX;
        let py = sourceY + dy * t + streamOffsetY;

        // Add chaotic spray motion
        const chaos1 = Math.sin(baseTime / 80 + i * 2.3 + stream * 1.7) * 8 * t;
        const chaos2 = Math.cos(baseTime / 60 + i * 1.9 + stream * 2.1) * 6 * t;

        px += perpX * chaos1 + dirX * chaos2 * 0.3;
        py += perpY * chaos1 + dirY * chaos2 * 0.3;

        // Add extra spread near the target
        const spreadNearTarget = t * t * targetSize * 0.4;
        const spreadAngle =
          Math.sin(baseTime / 100 + i * 3 + stream) * spreadNearTarget;
        px += perpX * spreadAngle;
        py += perpY * spreadAngle;

        // Particle size varies - larger near source, smaller near target
        const sizeBase = 3 + (1 - t) * 3;
        const sizeMod = 1 + Math.sin(phase * Math.PI + stream) * 0.4;
        const particleSize = sizeBase * sizeMod;

        // Alpha fades in at start and out at end
        const alphaFadeIn = Math.min(1, t * 5);
        const alphaFadeOut = Math.min(1, (1 - t) * 2.5);
        const alpha = alphaFadeIn * alphaFadeOut * 0.8;

        // Draw the particle
        this.graphics.fillStyle(color, alpha);
        this.graphics.fillCircle(px, py, particleSize);

        // Add a glow effect for some particles
        if ((i + stream) % 3 === 0) {
          this.graphics.fillStyle(0xffffff, alpha * 0.5);
          this.graphics.fillCircle(px, py, particleSize * 0.4);
        }
      }
    }

    // Draw additional splatter particles at the target (scaled by intensity)
    const splatterCount = Math.max(8, Math.floor(20 * effectiveIntensity));
    for (let i = 0; i < splatterCount; i++) {
      const angle = (baseTime / 200 + i / splatterCount) * Math.PI * 2;
      const splatterDist =
        (Math.sin(baseTime / 150 + i * 2) * 0.3 + 0.7) * targetSize * 0.6;
      const sx = targetX + Math.cos(angle) * splatterDist;
      const sy = targetY + Math.sin(angle) * splatterDist;
      const splatterAlpha =
        (0.5 + Math.sin(baseTime / 100 + i) * 0.3) * effectiveIntensity;
      const splatterSize = 3 + Math.sin(baseTime / 80 + i) * 1.5;

      this.graphics.fillStyle(color, splatterAlpha);
      this.graphics.fillCircle(sx, sy, splatterSize);

      // Add glow to splatter
      if (i % 2 === 0) {
        this.graphics.fillStyle(0xffffff, splatterAlpha * 0.4);
        this.graphics.fillCircle(sx, sy, splatterSize * 0.5);
      }
    }
  }

  // Render a projectile
  private renderProjectile(entity: Entity): void {
    if (!entity.projectile) return;

    const { transform, projectile, ownership } = entity;
    const { x, y } = transform;
    const config = projectile.config;
    // Use bright team-based color for projectile visibility
    const baseColor = this.getPlayerColor(ownership?.playerId);
    const color = this.getProjectileColor(baseColor);

    if (projectile.projectileType === 'beam') {
      // Render beam as a line
      const startX = projectile.startX ?? x;
      const startY = projectile.startY ?? y;
      const endX = projectile.endX ?? x;
      const endY = projectile.endY ?? y;
      const beamWidth = config.beamWidth ?? 2;

      // Outer glow
      this.graphics.lineStyle(beamWidth + 4, color, 0.3);
      this.graphics.lineBetween(startX, startY, endX, endY);

      // Inner beam
      this.graphics.lineStyle(beamWidth, color, 0.9);
      this.graphics.lineBetween(startX, startY, endX, endY);

      // Core
      this.graphics.lineStyle(beamWidth / 2, 0xffffff, 1);
      this.graphics.lineBetween(startX, startY, endX, endY);

      // Continuous explosion effect at beam endpoint
      const explosionRadius = beamWidth * 2 + 6;
      const pulsePhase = (this.sprayParticleTime / 80) % 1;
      const pulseScale = 0.8 + Math.sin(pulsePhase * Math.PI * 2) * 0.2;

      // Outer glow at endpoint
      this.graphics.fillStyle(color, 0.4);
      this.graphics.fillCircle(endX, endY, explosionRadius * pulseScale * 1.3);

      // Main explosion area
      this.graphics.fillStyle(color, 0.6);
      this.graphics.fillCircle(endX, endY, explosionRadius * pulseScale);

      // Hot core
      this.graphics.fillStyle(0xffffff, 0.8);
      this.graphics.fillCircle(endX, endY, explosionRadius * pulseScale * 0.4);

      // Spark particles radiating outward
      const sparkCount = 6;
      for (let i = 0; i < sparkCount; i++) {
        const angle =
          (this.sprayParticleTime / 150 + i / sparkCount) * Math.PI * 2;
        const sparkDist =
          explosionRadius *
          (0.8 + Math.sin(this.sprayParticleTime / 50 + i * 2) * 0.4);
        const sx = endX + Math.cos(angle) * sparkDist;
        const sy = endY + Math.sin(angle) * sparkDist;
        this.graphics.fillStyle(color, 0.7);
        this.graphics.fillCircle(sx, sy, 2);
      }
    } else if (entity.dgunProjectile) {
      // D-gun projectile - big, fiery, intimidating
      const radius = config.projectileRadius ?? 25;

      // Outer glow (pulsating)
      const pulsePhase = (projectile.timeAlive / 100) % 1;
      const pulseRadius =
        radius * (1.3 + 0.2 * Math.sin(pulsePhase * Math.PI * 2));
      this.graphics.fillStyle(0xff4400, 0.3);
      this.graphics.fillCircle(x, y, pulseRadius);

      // Middle glow
      this.graphics.fillStyle(0xff6600, 0.5);
      this.graphics.fillCircle(x, y, radius * 1.1);

      // Main body
      this.graphics.fillStyle(color, 0.9);
      this.graphics.fillCircle(x, y, radius);

      // Hot core
      this.graphics.fillStyle(0xffff00, 0.8);
      this.graphics.fillCircle(x, y, radius * 0.5);

      // White-hot center
      this.graphics.fillStyle(0xffffff, 1);
      this.graphics.fillCircle(x, y, radius * 0.2);

      // Fire trail
      const velMag = Math.sqrt(
        projectile.velocityX * projectile.velocityX +
          projectile.velocityY * projectile.velocityY
      );
      if (velMag > 0) {
        const dirX = projectile.velocityX / velMag;
        const dirY = projectile.velocityY / velMag;

        for (let i = 1; i <= 5; i++) {
          const trailX = x - dirX * i * radius * 0.8;
          const trailY = y - dirY * i * radius * 0.8;
          const alpha = 0.6 - i * 0.1;
          const trailRadius = radius * (0.8 - i * 0.12);

          if (alpha > 0 && trailRadius > 0) {
            this.graphics.fillStyle(0xff4400, alpha);
            this.graphics.fillCircle(trailX, trailY, trailRadius);
          }
        }
      }
    } else {
      // Render traveling projectile as a circle
      const radius = config.projectileRadius ?? 5;

      // Trail effect (draw previous positions)
      const trailLength = config.trailLength ?? 3;
      const velMag = Math.sqrt(
        projectile.velocityX * projectile.velocityX +
          projectile.velocityY * projectile.velocityY
      );
      if (velMag > 0) {
        const dirX = projectile.velocityX / velMag;
        const dirY = projectile.velocityY / velMag;

        for (let i = 1; i <= trailLength; i++) {
          const trailX = x - dirX * i * radius * 1.5;
          const trailY = y - dirY * i * radius * 1.5;
          const alpha = 0.5 - i * 0.15;
          const trailRadius = radius * (1 - i * 0.2);

          if (alpha > 0 && trailRadius > 0) {
            this.graphics.fillStyle(color, alpha);
            this.graphics.fillCircle(trailX, trailY, trailRadius);
          }
        }
      }

      // Main projectile
      this.graphics.fillStyle(color, 0.9);
      this.graphics.fillCircle(x, y, radius);

      // Bright center
      this.graphics.fillStyle(0xffffff, 0.8);
      this.graphics.fillCircle(x, y, radius * 0.4);

      // Splash radius indicator for grenades
      if (config.splashRadius && !projectile.hasExploded) {
        this.graphics.lineStyle(1, color, 0.2);
        this.graphics.strokeCircle(x, y, config.splashRadius);
      }
    }
  }

  // Render a building (rectangle)
  private renderBuilding(entity: Entity): void {
    if (!entity.building) return;

    const { transform, building, ownership, buildable } = entity;
    const { x, y } = transform;
    const { width, height, hp, maxHp } = building;

    // Building body (centered at x, y)
    const left = x - width / 2;
    const top = y - height / 2;

    const isGhost = buildable?.isGhost ?? false;
    const isComplete = buildable?.isComplete ?? true;
    const buildProgress = buildable?.buildProgress ?? 1;

    // Ghost buildings - semi-transparent wireframe
    if (isGhost) {
      const canPlace = true; // TODO: Check placement validity
      const ghostColor = canPlace ? GHOST_COLOR : 0xff4444;
      this.graphics.lineStyle(2, ghostColor, 0.6);
      this.graphics.strokeRect(left, top, width, height);
      this.graphics.fillStyle(ghostColor, 0.2);
      this.graphics.fillRect(left, top, width, height);
      return;
    }

    // Selection indicator
    const isSelected = entity.selectable?.selected ?? false;
    if (isSelected) {
      this.graphics.lineStyle(3, UNIT_SELECTED_COLOR, 1);
      this.graphics.strokeRect(left - 4, top - 4, width + 8, height + 8);
    }

    // Get color based on ownership (team color)
    const fillColor = ownership?.playerId
      ? this.getPlayerColor(ownership.playerId)
      : BUILDING_COLOR;

    // Under construction - show partial fill based on progress
    if (!isComplete) {
      // Background (unbuilt portion)
      this.graphics.fillStyle(0x222222, 0.7);
      this.graphics.fillRect(left, top, width, height);

      // Built portion (fill from bottom up)
      const builtHeight = height * buildProgress;
      const builtTop = top + height - builtHeight;
      this.graphics.fillStyle(fillColor, 0.7);
      this.graphics.fillRect(left, builtTop, width, builtHeight);

      // Scaffold/wireframe overlay
      this.graphics.lineStyle(1, 0xaaaaaa, 0.5);
      const gridSize = 10;
      for (let gx = left; gx <= left + width; gx += gridSize) {
        this.graphics.lineBetween(gx, top, gx, top + height);
      }
      for (let gy = top; gy <= top + height; gy += gridSize) {
        this.graphics.lineBetween(left, gy, left + width, gy);
      }
    } else {
      // Complete building
      this.graphics.fillStyle(fillColor, 0.9);
      this.graphics.fillRect(left, top, width, height);

      // Inner detail
      this.graphics.lineStyle(1, 0x665533, 0.5);
      this.graphics.strokeRect(left + 4, top + 4, width - 8, height - 8);
    }

    // Outline
    this.graphics.lineStyle(3, BUILDING_OUTLINE_COLOR, 1);
    this.graphics.strokeRect(left, top, width, height);

    // Bars position
    let barY = top - 8;

    // Build progress bar (if under construction)
    if (!isComplete) {
      this.renderBuildBar(x, barY, width, 4, buildProgress);
      barY -= 6;
    }

    // Health bar (only show if damaged)
    if (hp < maxHp) {
      this.renderHealthBar(x, barY, width, 4, hp / maxHp);
    }

    // Factory-specific rendering
    if (entity.factory && isComplete) {
      this.renderFactory(entity, left, top, width, height);
    }

    // Solar panel-specific rendering
    if (entity.buildingType === 'solar' && isComplete) {
      this.renderSolarPanel(entity, left, top, width, height);
    }
  }

  // Render factory-specific elements (queue, rally point)
  private renderFactory(
    entity: Entity,
    left: number,
    top: number,
    width: number,
    height: number
  ): void {
    if (!entity.factory) return;

    const factory = entity.factory;
    const x = entity.transform.x;
    const y = entity.transform.y;
    const isSelected = entity.selectable?.selected ?? false;
    const isProducing = factory.isProducing;
    const playerColor = this.getPlayerColor(entity.ownership?.playerId);

    // ========== FACTORY VISUAL DETAILS ==========

    // Inner machinery area (darker background)
    const machineMargin = 8;
    this.graphics.fillStyle(0x1a1a1a, 0.9);
    this.graphics.fillRect(
      left + machineMargin,
      top + machineMargin,
      width - machineMargin * 2,
      height - machineMargin * 2
    );

    // Animated gear/cogs - spin when producing
    const gearPhase = isProducing ? this.sprayParticleTime / 1000 : 0;
    this.renderGear(
      left + width * 0.25,
      top + height * 0.35,
      12,
      gearPhase,
      playerColor
    );
    this.renderGear(
      left + width * 0.75,
      top + height * 0.35,
      10,
      -gearPhase * 1.3,
      playerColor
    );
    this.renderGear(
      left + width * 0.5,
      top + height * 0.6,
      14,
      gearPhase * 0.8,
      playerColor
    );

    // Conveyor belt exit (bottom center)
    const conveyorWidth = width * 0.4;
    const conveyorHeight = 8;
    const conveyorX = x - conveyorWidth / 2;
    const conveyorY = top + height - conveyorHeight - 4;

    this.graphics.fillStyle(0x333333, 1);
    this.graphics.fillRect(conveyorX, conveyorY, conveyorWidth, conveyorHeight);

    // Conveyor belt lines (animated when producing)
    const beltOffset = isProducing ? (this.sprayParticleTime / 50) % 8 : 0;
    this.graphics.lineStyle(1, 0x555555, 0.8);
    for (let i = -1; i < conveyorWidth / 8 + 1; i++) {
      const lineX = conveyorX + i * 8 + beltOffset;
      if (lineX >= conveyorX && lineX <= conveyorX + conveyorWidth) {
        this.graphics.lineBetween(
          lineX,
          conveyorY,
          lineX,
          conveyorY + conveyorHeight
        );
      }
    }

    // Chimney/smokestack
    const chimneyWidth = 10;
    const chimneyHeight = 18;
    const chimneyX = left + width - 15;
    const chimneyY = top - chimneyHeight + 5;

    // Chimney body
    this.graphics.fillStyle(0x444444, 1);
    this.graphics.fillRect(chimneyX, chimneyY, chimneyWidth, chimneyHeight);
    this.graphics.lineStyle(1, 0x666666, 0.8);
    this.graphics.strokeRect(chimneyX, chimneyY, chimneyWidth, chimneyHeight);

    // Chimney cap
    this.graphics.fillStyle(0x333333, 1);
    this.graphics.fillRect(chimneyX - 2, chimneyY - 3, chimneyWidth + 4, 4);

    // Smoke particles when producing
    if (isProducing) {
      this.renderSmoke(chimneyX + chimneyWidth / 2, chimneyY - 5);
    }

    // Status lights (corner indicators)
    const lightRadius = 3;
    const lightMargin = 6;

    // Top-left light - power status (green = ready)
    this.graphics.fillStyle(0x44ff44, 0.9);
    this.graphics.fillCircle(
      left + lightMargin,
      top + lightMargin,
      lightRadius
    );

    // Top-right light - production status (yellow when producing, dim when idle)
    const prodLightColor = isProducing ? 0xffcc00 : 0x555533;
    const prodLightAlpha = isProducing
      ? 0.9 + Math.sin(this.sprayParticleTime / 100) * 0.1
      : 0.5;
    this.graphics.fillStyle(prodLightColor, prodLightAlpha);
    this.graphics.fillCircle(
      left + width - lightMargin,
      top + lightMargin,
      lightRadius
    );

    // Production glow effect when building
    if (isProducing) {
      const glowIntensity = 0.15 + Math.sin(this.sprayParticleTime / 200) * 0.1;
      this.graphics.fillStyle(0xffcc00, glowIntensity);
      this.graphics.fillRect(left, top, width, height);
    }

    // ========== RALLY POINT ==========

    // Only draw simple rally point when NOT selected (waypoints are drawn separately when selected)
    if (!isSelected) {
      // Draw rally point line and marker
      this.graphics.lineStyle(1, 0x00ff00, 0.4);
      this.graphics.lineBetween(x, y, factory.rallyX, factory.rallyY);

      // Rally point marker (small flag)
      this.graphics.fillStyle(0x00ff00, 0.7);
      this.graphics.fillTriangle(
        factory.rallyX,
        factory.rallyY - 8,
        factory.rallyX + 8,
        factory.rallyY - 4,
        factory.rallyX,
        factory.rallyY
      );
      this.graphics.lineStyle(1, 0x00ff00, 0.8);
      this.graphics.lineBetween(
        factory.rallyX,
        factory.rallyY,
        factory.rallyX,
        factory.rallyY - 8
      );
    }

    // ========== PRODUCTION PROGRESS ==========

    // Production progress indicator (if producing)
    if (isProducing && factory.buildQueue.length > 0) {
      const progress = factory.currentBuildProgress;
      const barWidth = width * 0.8;
      const barHeight = 6;
      const barX = x - barWidth / 2;
      const barY = top + height + 4;

      // Background
      this.graphics.fillStyle(HEALTH_BAR_BG, 0.8);
      this.graphics.fillRect(barX, barY, barWidth, barHeight);

      // Progress fill
      this.graphics.fillStyle(BUILD_BAR_FG, 0.9);
      this.graphics.fillRect(barX, barY, barWidth * progress, barHeight);

      // Queue indicator (small dots for queued items)
      const queueCount = Math.min(factory.buildQueue.length, 5);
      const dotSpacing = 8;
      const dotsStartX = x - ((queueCount - 1) * dotSpacing) / 2;
      for (let i = 0; i < queueCount; i++) {
        const dotX = dotsStartX + i * dotSpacing;
        const dotY = barY + barHeight + 6;
        const alpha = i === 0 ? 1 : 0.5;
        this.graphics.fillStyle(0xffcc00, alpha);
        this.graphics.fillCircle(dotX, dotY, 3);
      }
    }
  }

  // Render a gear/cog shape
  private renderGear(
    x: number,
    y: number,
    radius: number,
    rotation: number,
    color: number
  ): void {
    const teeth = 6;
    const innerRadius = radius * 0.6;
    const toothHeight = radius * 0.35;

    // Gear body
    this.graphics.fillStyle(color, 0.7);
    this.graphics.fillCircle(x, y, innerRadius);

    // Teeth
    for (let i = 0; i < teeth; i++) {
      const angle = rotation + (i / teeth) * Math.PI * 2;
      const toothWidth = ((Math.PI * 2) / teeth) * 0.4;

      const toothPoints = [
        {
          x: x + Math.cos(angle - toothWidth) * innerRadius,
          y: y + Math.sin(angle - toothWidth) * innerRadius,
        },
        {
          x:
            x +
            Math.cos(angle - toothWidth * 0.6) * (innerRadius + toothHeight),
          y:
            y +
            Math.sin(angle - toothWidth * 0.6) * (innerRadius + toothHeight),
        },
        {
          x:
            x +
            Math.cos(angle + toothWidth * 0.6) * (innerRadius + toothHeight),
          y:
            y +
            Math.sin(angle + toothWidth * 0.6) * (innerRadius + toothHeight),
        },
        {
          x: x + Math.cos(angle + toothWidth) * innerRadius,
          y: y + Math.sin(angle + toothWidth) * innerRadius,
        },
      ];

      this.graphics.fillStyle(color, 0.7);
      this.graphics.fillPoints(toothPoints, true);
    }

    // Center hole
    this.graphics.fillStyle(0x1a1a1a, 1);
    this.graphics.fillCircle(x, y, radius * 0.25);

    // Outline
    this.graphics.lineStyle(1, 0x333333, 0.5);
    this.graphics.strokeCircle(x, y, innerRadius);
  }

  // Render smoke particles
  private renderSmoke(x: number, y: number): void {
    const particleCount = 8;
    const baseTime = this.sprayParticleTime;

    for (let i = 0; i < particleCount; i++) {
      // Each particle rises and fades
      const phase = (baseTime / 800 + i / particleCount) % 1;
      const lifetime = phase;

      // Rise and drift
      const riseY = y - lifetime * 30;
      const driftX = x + Math.sin(baseTime / 300 + i * 2) * 8 * lifetime;

      // Size grows as it rises
      const size = 3 + lifetime * 6;

      // Fade out as it rises
      const alpha = (1 - lifetime) * 0.4;

      if (alpha > 0.05) {
        this.graphics.fillStyle(0x888888, alpha);
        this.graphics.fillCircle(driftX, riseY, size);
      }
    }
  }

  // Render solar panel visual details
  private renderSolarPanel(
    entity: Entity,
    left: number,
    top: number,
    width: number,
    height: number
  ): void {
    const playerColor = this.getPlayerColor(entity.ownership?.playerId);

    // Panel grid - dark blue photovoltaic cells
    const cellMargin = 4;
    const cellGap = 2;
    const innerLeft = left + cellMargin;
    const innerTop = top + cellMargin;
    const innerWidth = width - cellMargin * 2;
    const innerHeight = height - cellMargin * 2;

    // Dark panel background
    this.graphics.fillStyle(0x0a1428, 1);
    this.graphics.fillRect(innerLeft, innerTop, innerWidth, innerHeight);

    // Solar cell grid (3x2 cells)
    const cellsX = 3;
    const cellsY = 2;
    const cellWidth = (innerWidth - cellGap * (cellsX + 1)) / cellsX;
    const cellHeight = (innerHeight - cellGap * (cellsY + 1)) / cellsY;

    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const cellX = innerLeft + cellGap + cx * (cellWidth + cellGap);
        const cellY = innerTop + cellGap + cy * (cellHeight + cellGap);

        // Cell base (dark blue)
        this.graphics.fillStyle(0x1a3050, 1);
        this.graphics.fillRect(cellX, cellY, cellWidth, cellHeight);

        // Cell gradient simulation (lighter at top)
        this.graphics.fillStyle(0x2a4060, 0.6);
        this.graphics.fillRect(cellX, cellY, cellWidth, cellHeight * 0.4);

        // Grid lines on each cell
        this.graphics.lineStyle(1, 0x102030, 0.8);
        // Horizontal line
        this.graphics.lineBetween(
          cellX,
          cellY + cellHeight / 2,
          cellX + cellWidth,
          cellY + cellHeight / 2
        );
        // Vertical line
        this.graphics.lineBetween(
          cellX + cellWidth / 2,
          cellY,
          cellX + cellWidth / 2,
          cellY + cellHeight
        );
      }
    }

    // Shimmer effect (subtle moving highlight)
    const shimmerPhase = (this.sprayParticleTime / 2000) % 1;
    const shimmerX =
      innerLeft + shimmerPhase * innerWidth * 1.5 - innerWidth * 0.25;
    const shimmerWidth = innerWidth * 0.3;

    if (
      shimmerX > innerLeft - shimmerWidth &&
      shimmerX < innerLeft + innerWidth
    ) {
      // Gradient shimmer (brighter in center)
      for (let i = 0; i < 5; i++) {
        const segX = shimmerX + i * (shimmerWidth / 5);
        const segW = shimmerWidth / 5;
        const alpha = i < 2.5 ? i * 0.04 : (4 - i) * 0.04;

        if (segX >= innerLeft && segX + segW <= innerLeft + innerWidth) {
          this.graphics.fillStyle(0xffffff, alpha);
          this.graphics.fillRect(segX, innerTop, segW, innerHeight);
        }
      }
    }

    // Frame corners (player color accents)
    const cornerSize = 6;
    this.graphics.fillStyle(playerColor, 0.9);

    // Top-left corner
    this.graphics.fillRect(left, top, cornerSize, 2);
    this.graphics.fillRect(left, top, 2, cornerSize);

    // Top-right corner
    this.graphics.fillRect(left + width - cornerSize, top, cornerSize, 2);
    this.graphics.fillRect(left + width - 2, top, 2, cornerSize);

    // Bottom-left corner
    this.graphics.fillRect(left, top + height - 2, cornerSize, 2);
    this.graphics.fillRect(left, top + height - cornerSize, 2, cornerSize);

    // Bottom-right corner
    this.graphics.fillRect(
      left + width - cornerSize,
      top + height - 2,
      cornerSize,
      2
    );
    this.graphics.fillRect(
      left + width - 2,
      top + height - cornerSize,
      2,
      cornerSize
    );

    // Small power indicator LED
    const ledX = left + width - 8;
    const ledY = top + 8;
    this.graphics.fillStyle(0x44ff44, 0.9);
    this.graphics.fillCircle(ledX, ledY, 2);
  }

  // Render a build progress bar
  private renderBuildBar(
    x: number,
    y: number,
    width: number,
    height: number,
    percent: number
  ): void {
    const left = x - width / 2;

    // Background
    this.graphics.fillStyle(HEALTH_BAR_BG, 0.8);
    this.graphics.fillRect(left, y, width, height);

    // Progress fill (yellow)
    this.graphics.fillStyle(BUILD_BAR_FG, 0.9);
    this.graphics.fillRect(left, y, width * percent, height);
  }

  // Render a health bar
  private renderHealthBar(
    x: number,
    y: number,
    width: number,
    height: number,
    percent: number
  ): void {
    const left = x - width / 2;

    // Background
    this.graphics.fillStyle(HEALTH_BAR_BG, 0.8);
    this.graphics.fillRect(left, y, width, height);

    // Health fill (green when high, red when low)
    const healthColor = percent > 0.3 ? HEALTH_BAR_FG : HEALTH_BAR_LOW;
    this.graphics.fillStyle(healthColor, 0.9);
    this.graphics.fillRect(left, y, width * percent, height);
  }

  // Clean up
  destroy(): void {
    this.graphics.destroy();
  }
}
