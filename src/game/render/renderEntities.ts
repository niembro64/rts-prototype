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
import { getUnitDefinition } from '../sim/unitDefinitions';

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

  // Three separate momentum vectors for different explosion layers:

  // 1. Unit velocity - where the unit was moving when it died
  // Used by: Smoke clouds, fire embers (trailing effect)
  velocityX?: number;
  velocityY?: number;
  velocityMag?: number;

  // 2. Penetration direction - from hit point through unit center
  // Used by: Debris chunks, shockwave rings (where the attack entered)
  penetrationX?: number;
  penetrationY?: number;
  penetrationMag?: number;

  // 3. Attacker direction - direction the projectile/beam was traveling
  // Used by: Spark trails, exit fragments (penetration effect)
  attackerX?: number;
  attackerY?: number;
  attackerMag?: number;

  // Combined momentum for layers that blend all forces
  combinedX?: number;
  combinedY?: number;
  combinedMag?: number;
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

// Leg style configuration - thickness, foot size, and lerp duration (ms)
const LEG_STYLE_CONFIG = {
  arachnid: { thickness: 5, footSizeMultiplier: 0.1, lerpSpeed: 700 },  // 200ms lerp duration
  daddy: { thickness: 2, footSizeMultiplier: 0.14, lerpSpeed: 500 },    // 180ms lerp
  insect: { thickness: 4, footSizeMultiplier: 0.12, lerpSpeed: 200 },   // 250ms lerp (slower/smoother)
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

  // Per-projectile random offsets for visual variety
  private beamRandomOffsets: Map<EntityId, {
    phaseOffset: number;      // Random offset for pulse timing
    rotationOffset: number;   // Random rotation for sparks
    sizeScale: number;        // Random size multiplier (0.8-1.2)
    pulseSpeed: number;       // Random pulse speed multiplier
  }> = new Map();

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
      // Pattern matches arachnid: all snapTargetAngles negative, decreasing multiplier front-to-back
      const legLength = radius * 1.9;
      const upperLen = legLength * 0.55;
      const lowerLen = legLength * 0.55;

      leftSideConfigs = [
        // Front leg - points forward-ish
        {
          attachOffsetX: radius * 0.5,
          attachOffsetY: -radius * 0.4,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.5,
          snapTargetAngle: -Math.PI * 0.15,  // Slightly forward
          snapDistanceMultiplier: 0.9,
          extensionThreshold: 0.9,
        },
        // Middle leg - perpendicular/sideways
        {
          attachOffsetX: 0,
          attachOffsetY: -radius * 0.45,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.7,
          snapTargetAngle: -Math.PI * 0.4,  // Sideways
          snapDistanceMultiplier: 0.85,
          extensionThreshold: 0.89,
        },
        // Back leg - points backward-sideways (still negative like arachnid)
        {
          attachOffsetX: -radius * 0.5,
          attachOffsetY: -radius * 0.4,
          upperLegLength: upperLen,
          lowerLegLength: lowerLen,
          snapTriggerAngle: Math.PI * 0.99,
          snapTargetAngle: -Math.PI * 0.3,  // Backward-sideways (negative!)
          snapDistanceMultiplier: 0.8,
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

    // Get lerp speed for this leg style
    const styleConfig = LEG_STYLE_CONFIG[legStyle];
    const lerpSpeed = styleConfig.lerpSpeed;

    // Add lerpSpeed to all left side configs
    const leftWithLerp = leftSideConfigs.map((leg) => ({ ...leg, lerpSpeed }));

    // Mirror left side to create right side (flip Y offset and snap target angle)
    const rightSideConfigs: LegConfig[] = leftWithLerp.map((leg) => ({
      ...leg,
      attachOffsetY: -leg.attachOffsetY,
      snapTargetAngle: -leg.snapTargetAngle,
    }));

    const legConfigs = [...leftWithLerp, ...rightSideConfigs];

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

    // Update legs for all legged units using unit definitions
    for (const entity of this.entitySource.getUnits()) {
      if (!entity.unit || !entity.weapons || entity.weapons.length === 0)
        continue;

      // Determine unit type: multi-weapon units are widow, otherwise use weapon ID
      const unitType = entity.weapons.length > 1 ? 'widow' : entity.weapons[0].config.id;
      const definition = getUnitDefinition(unitType);

      // Skip if not a legged unit
      if (!definition || definition.locomotion !== 'legs') continue;

      const legStyle = definition.legStyle ?? 'arachnid';
      const legs = this.getOrCreateLegs(entity, legStyle);

      // Use actual physics body velocity, not thrust direction
      // Scale up since Matter.js velocities are per-step, not per-second
      const matterBody = entity.body?.matterBody as MatterJS.BodyType | undefined;
      const velX = (matterBody?.velocity?.x ?? 0) * 60;
      const velY = (matterBody?.velocity?.y ?? 0) * 60;

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
      case 'shotgun':
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

    // Update treads for all tracked/wheeled units using unit definitions
    for (const entity of this.entitySource.getUnits()) {
      if (!entity.unit || !entity.weapons || entity.weapons.length === 0)
        continue;

      // Determine unit type and get definition
      const unitType = entity.weapons.length > 1 ? 'widow' : entity.weapons[0].config.id;
      const definition = getUnitDefinition(unitType);

      // Handle tracked vehicles (treads locomotion)
      if (definition?.locomotion === 'treads') {
        const treadType = unitType as 'tank' | 'brawl';
        const treads = this.getOrCreateTreads(entity, treadType);
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

      // Handle wheeled vehicles (wheels locomotion)
      if (definition?.locomotion !== 'wheels') continue;
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

  // Add a new explosion effect with three separate momentum vectors
  // Each vector affects different explosion layers for complex visual effects:
  // - velocity: unit's movement (smoke, embers trail behind)
  // - penetration: direction from hit point through center (where attack entered)
  // - attacker: projectile direction (sparks exit through)
  addExplosion(
    x: number,
    y: number,
    radius: number,
    color: number,
    type: 'impact' | 'death',
    velocityX?: number,
    velocityY?: number,
    penetrationX?: number,
    penetrationY?: number,
    attackerX?: number,
    attackerY?: number
  ): void {
    // Base lifetime scales with radius - larger explosions last longer
    // Base: 150ms for a radius of 8, scales proportionally
    const baseRadius = 8;
    const baseLifetime = type === 'death' ? 600 : 150;
    const radiusScale = Math.sqrt(radius / baseRadius); // Square root for less extreme scaling
    const lifetime = baseLifetime * radiusScale;

    // Calculate magnitudes for each momentum vector
    const velocityMag = (velocityX !== undefined && velocityY !== undefined)
      ? Math.sqrt(velocityX * velocityX + velocityY * velocityY) : 0;
    const penetrationMag = (penetrationX !== undefined && penetrationY !== undefined)
      ? Math.sqrt(penetrationX * penetrationX + penetrationY * penetrationY) : 0;
    const attackerMag = (attackerX !== undefined && attackerY !== undefined)
      ? Math.sqrt(attackerX * attackerX + attackerY * attackerY) : 0;

    // Calculate combined momentum (sum of all vectors)
    const combinedX = (velocityX ?? 0) + (penetrationX ?? 0) + (attackerX ?? 0);
    const combinedY = (velocityY ?? 0) + (penetrationY ?? 0) + (attackerY ?? 0);
    const combinedMag = Math.sqrt(combinedX * combinedX + combinedY * combinedY);

    this.explosions.push({
      x,
      y,
      radius,
      color,
      lifetime,
      elapsed: 0,
      type,
      // Unit velocity
      velocityX,
      velocityY,
      velocityMag,
      // Penetration direction
      penetrationX,
      penetrationY,
      penetrationMag,
      // Attacker direction
      attackerX,
      attackerY,
      attackerMag,
      // Combined
      combinedX,
      combinedY,
      combinedMag,
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

    // 1. Render buildings first (bottom layer) - skip dead buildings
    for (const entity of this.entitySource.getBuildings()) {
      if (entity.building && entity.building.hp > 0) {
        this.renderBuilding(entity);
      }
    }

    // Render waypoints for selected units (below units) - skip dead units
    for (const entity of this.entitySource.getUnits()) {
      if (entity.selectable?.selected && entity.unit && entity.unit.hp > 0) {
        this.renderWaypoints(entity);
      }
    }

    // Render waypoints for selected factories - skip dead buildings
    for (const entity of this.entitySource.getBuildings()) {
      if (entity.selectable?.selected && entity.factory && entity.building && entity.building.hp > 0) {
        this.renderFactoryWaypoints(entity);
      }
    }

    // Render range circles for selected units (below unit bodies) - skip dead units
    for (const entity of this.entitySource.getUnits()) {
      if (entity.selectable?.selected && entity.unit && entity.unit.hp > 0) {
        this.renderRangeCircles(entity);
      }
    }

    // 2. Render unit bodies (no turrets) - skip dead units
    this.skipTurrets = true;
    this.turretsOnly = false;
    for (const entity of this.entitySource.getUnits()) {
      if (entity.unit && entity.unit.hp > 0) {
        this.renderUnit(entity);
      }
    }

    // 3. Render turrets only (above unit bodies) - skip dead units
    this.skipTurrets = false;
    this.turretsOnly = true;
    for (const entity of this.entitySource.getUnits()) {
      if (entity.unit && entity.unit.hp > 0) {
        this.renderUnit(entity);
      }
    }
    this.turretsOnly = false;

    // 4. Render projectiles and lasers
    // Clean up beam random offsets for projectiles that no longer exist
    const existingProjectileIds = new Set(this.entitySource.getProjectiles().map((e) => e.id));
    for (const id of this.beamRandomOffsets.keys()) {
      if (!existingProjectileIds.has(id)) {
        this.beamRandomOffsets.delete(id);
      }
    }
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

  // Render an elliptical glow stretched in a direction (for directional explosions)
  private renderDirectionalGlow(
    x: number, y: number,
    radiusX: number, radiusY: number,
    rotation: number,
    color: number, alpha: number
  ): void {
    // Draw ellipse using line segments rotated to the momentum direction
    const segments = 24;
    this.graphics.fillStyle(color, alpha);
    this.graphics.beginPath();

    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      // Ellipse point in local space
      const localX = Math.cos(angle) * radiusX;
      const localY = Math.sin(angle) * radiusY;
      // Rotate to world space
      const worldX = x + localX * cos - localY * sin;
      const worldY = y + localX * sin + localY * cos;

      if (i === 0) {
        this.graphics.moveTo(worldX, worldY);
      } else {
        this.graphics.lineTo(worldX, worldY);
      }
    }

    this.graphics.closePath();
    this.graphics.fillPath();
  }

  // Render an explosion effect
  private renderExplosion(exp: ExplosionEffect): void {
    const progress = exp.elapsed / exp.lifetime;

    if (exp.type === 'death') {
      // ========================================================================
      // COMPLEX DIRECTIONAL DEATH EXPLOSION
      // Features: Multiple shockwaves, spark trails, fire particles, debris chunks,
      // energy arcs, smoke clouds, and momentum-biased everything
      // ========================================================================

      const alpha = 1 - progress;
      const earlyProgress = Math.min(1, progress * 3); // Fast initial burst
      const lateProgress = Math.max(0, (progress - 0.5) * 2); // Late lingering phase

      // ========================================================================
      // CALCULATE DIRECTION & STRENGTH FOR EACH MOMENTUM TYPE
      // Each affects different explosion layers for complex visual effects
      // ========================================================================

      // 1. VELOCITY (unit's movement) - affects smoke, embers
      let velDirX = 0, velDirY = 0, velStrength = 0, velAngle = 0;
      const hasVelocity = (exp.velocityMag ?? 0) > 10;
      if (hasVelocity) {
        velDirX = (exp.velocityX ?? 0) / exp.velocityMag!;
        velDirY = (exp.velocityY ?? 0) / exp.velocityMag!;
        velAngle = Math.atan2(velDirY, velDirX);
        velStrength = Math.min(exp.velocityMag! / 400, 1);
      }

      // 2. PENETRATION (from hit point through center) - affects debris, shockwaves
      let penDirX = 0, penDirY = 0, penStrength = 0, penAngle = 0;
      const hasPenetration = (exp.penetrationMag ?? 0) > 10;
      if (hasPenetration) {
        penDirX = (exp.penetrationX ?? 0) / exp.penetrationMag!;
        penDirY = (exp.penetrationY ?? 0) / exp.penetrationMag!;
        penAngle = Math.atan2(penDirY, penDirX);
        penStrength = Math.min(exp.penetrationMag! / 400, 1);
      }

      // 3. ATTACKER (projectile/beam direction) - affects sparks, secondary explosions
      let attackDirX = 0, attackDirY = 0, attackStrength = 0, attackAngle = 0;
      const hasAttacker = (exp.attackerMag ?? 0) > 10;
      if (hasAttacker) {
        attackDirX = (exp.attackerX ?? 0) / exp.attackerMag!;
        attackDirY = (exp.attackerY ?? 0) / exp.attackerMag!;
        attackAngle = Math.atan2(attackDirY, attackDirX);
        attackStrength = Math.min(exp.attackerMag! / 400, 1);
      }

      // 4. COMBINED (all forces) - affects main fireball, outer glow, energy arcs
      let combinedDirX = 0, combinedDirY = 0, combinedStrength = 0, combinedAngle = 0;
      const hasCombined = (exp.combinedMag ?? 0) > 10;
      if (hasCombined) {
        combinedDirX = (exp.combinedX ?? 0) / exp.combinedMag!;
        combinedDirY = (exp.combinedY ?? 0) / exp.combinedMag!;
        combinedAngle = Math.atan2(combinedDirY, combinedDirX);
        combinedStrength = Math.min(exp.combinedMag! / 400, 1);
      }

      // Dynamic center that drifts with combined momentum over time
      const driftDistance = hasCombined ? exp.radius * 0.8 * progress * combinedStrength : 0;
      const centerX = exp.x + combinedDirX * driftDistance;
      const centerY = exp.y + combinedDirY * driftDistance;

      // Use deterministic "random" based on explosion position for consistent particles
      const seed = (exp.x * 1000 + exp.y) % 10000;
      const seededRandom = (i: number) => {
        const x = Math.sin(seed + i * 127.1) * 43758.5453;
        return x - Math.floor(x);
      };

      // ------------------------------------------------------------------------
      // LAYER 1: SMOKE CLOUDS (uses VELOCITY - trails behind moving unit)
      // ------------------------------------------------------------------------
      if (progress > 0.1) {
        const smokeCount = 6 + Math.floor(velStrength * 4);
        for (let i = 0; i < smokeCount; i++) {
          const smokeProgress = Math.max(0, (progress - 0.1 - i * 0.02) * 1.8);
          if (smokeProgress <= 0 || smokeProgress > 1) continue;

          // Smoke drifts upward and OPPOSITE to velocity (trails behind)
          const baseAngle = seededRandom(i + 100) * Math.PI * 2;
          let smokeAngle = baseAngle;
          let smokeDist = exp.radius * (0.3 + smokeProgress * 0.8) * (0.7 + seededRandom(i + 101) * 0.6);

          if (hasVelocity) {
            // Bias smoke OPPOSITE to velocity direction (trails behind)
            const oppositeAngle = velAngle + Math.PI;
            const alignment = Math.cos(baseAngle - oppositeAngle);
            if (alignment > 0) {
              smokeDist *= 1 + alignment * velStrength * 0.8;
              smokeAngle = baseAngle - (baseAngle - oppositeAngle) * 0.3 * velStrength;
            }
          }

          const smokeX = centerX + Math.cos(smokeAngle) * smokeDist;
          const smokeY = centerY + Math.sin(smokeAngle) * smokeDist - smokeProgress * 8; // Drift up

          // Smoke fades completely when it stops moving
          const smokeFade = 1 - smokeProgress;
          const smokeSize = exp.radius * 0.3 * smokeFade * (0.8 + seededRandom(i + 102) * 0.4);
          const smokeAlpha = 0.15 * smokeFade;

          if (smokeFade > 0.05) {
            this.graphics.fillStyle(0x444444, smokeAlpha);
            this.graphics.fillCircle(smokeX, smokeY, smokeSize);
          }
        }
      }

      // ------------------------------------------------------------------------
      // LAYER 2: OUTER GLOW / HEAT DISTORTION (uses COMBINED - overall momentum)
      // ------------------------------------------------------------------------
      const glowRadius = exp.radius * (0.4 + earlyProgress * 0.8);
      if (hasCombined && combinedStrength > 0.15) {
        const stretchFactor = 1 + combinedStrength * 0.8;
        // Multiple stretched glows for depth
        this.renderDirectionalGlow(centerX, centerY, glowRadius * 1.5, glowRadius * 1.5 * stretchFactor, combinedAngle, 0x331100, alpha * 0.2);
        this.renderDirectionalGlow(centerX, centerY, glowRadius * 1.2, glowRadius * 1.2 * stretchFactor, combinedAngle, exp.color, alpha * 0.25);
      } else {
        this.graphics.fillStyle(0x331100, alpha * 0.2);
        this.graphics.fillCircle(centerX, centerY, glowRadius * 1.5);
        this.graphics.fillStyle(exp.color, alpha * 0.25);
        this.graphics.fillCircle(centerX, centerY, glowRadius * 1.2);
      }

      // ------------------------------------------------------------------------
      // LAYER 3: MULTIPLE SHOCKWAVE RINGS (uses IMPACT - blown by knockback)
      // ------------------------------------------------------------------------
      const ringCount = 3;
      for (let r = 0; r < ringCount; r++) {
        const ringDelay = r * 0.12;
        const ringProgress = Math.max(0, Math.min(1, (progress - ringDelay) * 1.5));
        if (ringProgress <= 0) continue;

        const ringRadius = exp.radius * (0.3 + ringProgress * (1.2 + r * 0.3));
        const ringThickness = (4 - r) * (1 - ringProgress) + 1;
        const ringAlpha = alpha * (0.6 - r * 0.15) * (1 - ringProgress * 0.5);

        // Offset rings in PENETRATION direction (where attack entered)
        const ringOffsetMult = hasPenetration ? penStrength * 0.5 * (r + 1) : 0;
        const ringX = centerX + penDirX * ringRadius * ringOffsetMult;
        const ringY = centerY + penDirY * ringRadius * ringOffsetMult;

        this.graphics.lineStyle(ringThickness, r === 0 ? 0xffffff : exp.color, ringAlpha);
        this.graphics.strokeCircle(ringX, ringY, ringRadius);
      }

      // ------------------------------------------------------------------------
      // LAYER 4: MAIN FIREBALL (color gradient from white to orange to red)
      // ------------------------------------------------------------------------
      const fireRadius = exp.radius * (0.5 + earlyProgress * 0.4) * (1 - lateProgress * 0.6);
      if (fireRadius > 1) {
        // Outer fire (darker)
        this.graphics.fillStyle(0xaa2200, alpha * 0.5);
        this.graphics.fillCircle(centerX, centerY, fireRadius * 1.1);

        // Main fire body
        this.graphics.fillStyle(0xff4400, alpha * 0.65);
        this.graphics.fillCircle(centerX, centerY, fireRadius);

        // Inner fire (brighter)
        this.graphics.fillStyle(0xff8800, alpha * 0.7);
        this.graphics.fillCircle(centerX, centerY, fireRadius * 0.7);

        // Hot core
        const coreAlpha = alpha * (1 - earlyProgress * 0.7);
        if (coreAlpha > 0.1) {
          this.graphics.fillStyle(0xffcc44, coreAlpha);
          this.graphics.fillCircle(centerX, centerY, fireRadius * 0.4);
          this.graphics.fillStyle(0xffffff, coreAlpha * 0.8);
          this.graphics.fillCircle(centerX, centerY, fireRadius * 0.2);
        }
      }

      // ------------------------------------------------------------------------
      // LAYER 5: ENERGY ARCS / LIGHTNING (uses COMBINED - overall momentum)
      // ------------------------------------------------------------------------
      if (progress < 0.4) {
        const arcCount = 4 + Math.floor(combinedStrength * 3);
        const arcAlpha = (1 - progress * 2.5) * 0.7;

        for (let i = 0; i < arcCount; i++) {
          const baseAngle = (i / arcCount) * Math.PI * 2 + seededRandom(i + 200) * 0.5;
          let arcAngle = baseAngle;
          let arcLength = exp.radius * (0.5 + progress * 1.5) * (0.6 + seededRandom(i + 201) * 0.8);

          // Bias arcs toward COMBINED direction
          if (hasCombined) {
            const alignment = Math.cos(baseAngle - combinedAngle);
            if (alignment > 0) {
              arcLength *= 1 + alignment * combinedStrength * 0.7;
              arcAngle = baseAngle - (baseAngle - combinedAngle) * 0.3 * combinedStrength;
            }
          }

          // Draw jagged lightning arc
          this.graphics.lineStyle(2, 0x88ccff, arcAlpha);
          this.graphics.beginPath();
          this.graphics.moveTo(centerX, centerY);

          const segments = 3;
          let px = centerX, py = centerY;
          for (let s = 1; s <= segments; s++) {
            const segDist = (arcLength / segments) * s;
            const jitter = (seededRandom(i * 10 + s) - 0.5) * 0.4;
            const segAngle = arcAngle + jitter;
            px = centerX + Math.cos(segAngle) * segDist;
            py = centerY + Math.sin(segAngle) * segDist;
            this.graphics.lineTo(px, py);
          }
          this.graphics.strokePath();

          // Bright tip
          this.graphics.fillStyle(0xffffff, arcAlpha);
          this.graphics.fillCircle(px, py, 2);
        }
      }

      // ------------------------------------------------------------------------
      // LAYER 6: SPARK PARTICLES WITH TRAILS (uses ATTACKER - penetration effect)
      // Sparks EXPLODE out in the direction the projectile/beam was traveling
      // This is the main "ripping through" effect
      // ------------------------------------------------------------------------
      const sparkCount = 24 + Math.floor(attackStrength * 20); // Many more sparks
      for (let i = 0; i < sparkCount; i++) {
        const sparkDelay = seededRandom(i + 300) * 0.12; // Faster spawn
        const sparkProgress = Math.max(0, Math.min(1, (progress - sparkDelay) * 1.5)); // Faster animation
        if (sparkProgress <= 0) continue;

        const baseAngle = (i / sparkCount) * Math.PI * 2 + seededRandom(i + 301) * 0.3;
        const sparkSpeed = 1.0 + seededRandom(i + 302) * 1.0; // Faster sparks

        // Calculate ATTACKER direction bias - EXTREME penetration effect
        let finalAngle = baseAngle;
        let distMult = 1;
        if (hasAttacker) {
          let angleDiff = baseAngle - attackAngle;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

          const alignment = Math.cos(angleDiff);
          if (alignment > 0) {
            // MASSIVE bias toward attacker direction - ripping through!
            distMult = 1 + alignment * attackStrength * 3.0;
            finalAngle = baseAngle - angleDiff * 0.7 * attackStrength; // Pull hard toward attack dir
          } else {
            // Almost nothing goes backwards
            distMult = Math.max(0.1, 1 + alignment * attackStrength * 0.8);
          }
        }

        const sparkDist = exp.radius * (0.3 + sparkProgress * 2.5) * sparkSpeed * distMult; // Travel further
        const sparkX = centerX + Math.cos(finalAngle) * sparkDist;
        const sparkY = centerY + Math.sin(finalAngle) * sparkDist;

        // Draw LONG spark trail - the key visual for "ripping through"
        const sparkFade = 1 - sparkProgress; // Fade to 0 when stopped
        const trailLength = Math.min(sparkDist * 0.5, 30) * sparkFade;
        if (trailLength > 2 && sparkFade > 0.05) {
          const trailStartX = sparkX - Math.cos(finalAngle) * trailLength;
          const trailStartY = sparkY - Math.sin(finalAngle) * trailLength;
          // Gradient trail - brighter at head
          this.graphics.lineStyle(3, 0xff6622, alpha * 0.3 * sparkFade);
          this.graphics.lineBetween(trailStartX, trailStartY, sparkX, sparkY);
          this.graphics.lineStyle(2, 0xffaa44, alpha * 0.6 * sparkFade);
          const midX = (trailStartX + sparkX) / 2;
          const midY = (trailStartY + sparkY) / 2;
          this.graphics.lineBetween(midX, midY, sparkX, sparkY);
        }

        // Bigger, brighter spark head
        const sparkSize = (3.5 + seededRandom(i + 303) * 3) * sparkFade;
        if (sparkSize > 0.5 && sparkFade > 0.05) {
          this.graphics.fillStyle(0xffdd88, alpha * 0.95 * sparkFade);
          this.graphics.fillCircle(sparkX, sparkY, sparkSize);
          this.graphics.fillStyle(0xffffff, alpha * 0.8 * sparkFade);
          this.graphics.fillCircle(sparkX, sparkY, sparkSize * 0.5);
        }
      }

      // ------------------------------------------------------------------------
      // LAYER 6B: PENETRATION FRAGMENTS - Hot metal chunks ripping through
      // Concentrated spray of larger fragments in the attack direction
      // ------------------------------------------------------------------------
      if (hasAttacker && attackStrength > 0.2) {
        const fragmentCount = 8 + Math.floor(attackStrength * 15);
        for (let i = 0; i < fragmentCount; i++) {
          const fragDelay = seededRandom(i + 350) * 0.08;
          const fragProgress = Math.max(0, Math.min(1, (progress - fragDelay) * 1.8));
          if (fragProgress <= 0) continue;

          // Tight cone in attack direction
          const coneSpread = 0.5 * (1 - attackStrength * 0.3); // Tighter cone with stronger attacks
          const fragAngle = attackAngle + (seededRandom(i + 351) - 0.5) * coneSpread;
          const fragSpeed = 1.5 + seededRandom(i + 352) * 1.5;

          const fragDist = exp.radius * (0.5 + fragProgress * 3.5) * fragSpeed;
          const fragX = centerX + Math.cos(fragAngle) * fragDist;
          const fragY = centerY + Math.sin(fragAngle) * fragDist;

          // Fragment trail - molten metal streaks
          const fragFade = 1 - fragProgress; // Fade to 0 when stopped
          const fragTrailLen = Math.min(fragDist * 0.4, 25) * fragFade;
          if (fragTrailLen > 3 && fragFade > 0.05) {
            const trailStartX = fragX - Math.cos(fragAngle) * fragTrailLen;
            const trailStartY = fragY - Math.sin(fragAngle) * fragTrailLen;
            this.graphics.lineStyle(4, 0xff4400, alpha * 0.4 * fragFade);
            this.graphics.lineBetween(trailStartX, trailStartY, fragX, fragY);
            this.graphics.lineStyle(2, 0xffaa00, alpha * 0.7 * fragFade);
            this.graphics.lineBetween(trailStartX, trailStartY, fragX, fragY);
          }

          // Hot fragment head - glowing metal chunk
          const fragSize = (4 + seededRandom(i + 353) * 4) * fragFade;
          if (fragSize > 1 && fragFade > 0.05) {
            this.graphics.fillStyle(0xff6600, alpha * 0.9 * fragFade);
            this.graphics.fillCircle(fragX, fragY, fragSize);
            this.graphics.fillStyle(0xffcc44, alpha * 0.7 * fragFade);
            this.graphics.fillCircle(fragX, fragY, fragSize * 0.6);
            this.graphics.fillStyle(0xffffff, alpha * 0.5 * fragFade);
            this.graphics.fillCircle(fragX, fragY, fragSize * 0.25);
          }
        }
      }

      // ------------------------------------------------------------------------
      // LAYER 7: DEBRIS CHUNKS (uses PENETRATION - pushed through where attack entered)
      // Debris is pushed in the penetration direction
      // ------------------------------------------------------------------------
      const debrisCount = 8 + Math.floor(penStrength * 6);
      for (let i = 0; i < debrisCount; i++) {
        const debrisDelay = seededRandom(i + 400) * 0.08;
        const debrisProgress = Math.max(0, Math.min(1, (progress - debrisDelay) * 1.3));
        if (debrisProgress <= 0) continue;

        const baseAngle = seededRandom(i + 401) * Math.PI * 2;
        const debrisSpeed = 0.5 + seededRandom(i + 402) * 0.5;

        // Heavy PENETRATION bias for debris (pushed through where attack entered)
        let finalAngle = baseAngle;
        let distMult = 1;
        if (hasPenetration) {
          let angleDiff = baseAngle - penAngle;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

          const alignment = Math.cos(angleDiff);
          if (alignment > 0) {
            // Strong bias toward penetration direction
            distMult = 1 + alignment * penStrength * 1.8;
            finalAngle = baseAngle - angleDiff * 0.6 * penStrength;
          } else {
            distMult = Math.max(0.2, 1 + alignment * penStrength * 0.5);
          }
        }

        // Debris falls with gravity simulation
        const debrisDist = exp.radius * (0.3 + debrisProgress * 1.0) * debrisSpeed * distMult;
        const gravityDrop = debrisProgress * debrisProgress * 20; // Parabolic fall
        const debrisX = centerX + Math.cos(finalAngle) * debrisDist;
        const debrisY = centerY + Math.sin(finalAngle) * debrisDist + gravityDrop;

        // Debris fades completely when it stops moving
        const debrisFade = 1 - debrisProgress;
        const debrisSize = (3 + seededRandom(i + 403) * 4) * debrisFade;
        if (debrisSize > 1 && debrisFade > 0.05) {
          // Dark debris with bright edge
          this.graphics.fillStyle(0x332211, alpha * 0.8 * debrisFade);
          this.graphics.fillCircle(debrisX, debrisY, debrisSize);
          this.graphics.fillStyle(0x664422, alpha * 0.5 * debrisFade);
          this.graphics.fillCircle(debrisX - debrisSize * 0.3, debrisY - debrisSize * 0.3, debrisSize * 0.5);
        }
      }

      // ------------------------------------------------------------------------
      // LAYER 8: FIRE EMBERS (uses VELOCITY - trail behind moving unit)
      // Embers drift in the opposite direction of unit velocity (trailing effect)
      // ------------------------------------------------------------------------
      if (progress > 0.15) {
        const emberCount = 10 + Math.floor(velStrength * 8);
        for (let i = 0; i < emberCount; i++) {
          const emberProgress = Math.max(0, (progress - 0.15 - seededRandom(i + 500) * 0.2) * 2.0);
          if (emberProgress <= 0 || emberProgress > 1) continue;

          const baseAngle = seededRandom(i + 501) * Math.PI * 2;
          let emberAngle = baseAngle;
          let emberDist = exp.radius * (0.4 + emberProgress * 0.6) * (0.5 + seededRandom(i + 502) * 0.5);

          if (hasVelocity) {
            // Embers trail OPPOSITE to velocity direction
            const oppositeAngle = velAngle + Math.PI;
            const alignment = Math.cos(baseAngle - oppositeAngle);
            if (alignment > 0) {
              emberDist *= 1 + alignment * velStrength * 1.0;
              emberAngle = baseAngle - (baseAngle - oppositeAngle) * 0.35 * velStrength;
            }
          }

          // Embers float upward
          const emberX = centerX + Math.cos(emberAngle) * emberDist;
          const emberY = centerY + Math.sin(emberAngle) * emberDist - emberProgress * 15;

          // Embers fade completely when they stop moving
          const emberFade = 1 - emberProgress;
          const flicker = 0.7 + Math.sin(emberProgress * 20 + i) * 0.3;
          const emberSize = (1.5 + seededRandom(i + 503) * 1.5) * emberFade;
          const emberAlpha = alpha * 0.8 * flicker * emberFade;

          if (emberSize > 0.5 && emberFade > 0.05) {
            this.graphics.fillStyle(0xff6600, emberAlpha);
            this.graphics.fillCircle(emberX, emberY, emberSize);
            this.graphics.fillStyle(0xffcc00, emberAlpha * 0.6);
            this.graphics.fillCircle(emberX, emberY, emberSize * 0.5);
          }
        }
      }

      // ------------------------------------------------------------------------
      // LAYER 9: MOMENTUM TRAIL (uses COMBINED - overall momentum stream)
      // Hot streak of particles in the combined direction of all forces
      // ------------------------------------------------------------------------
      if (hasCombined && combinedStrength > 0.3) {
        const trailCount = Math.floor(combinedStrength * 15);
        for (let i = 0; i < trailCount; i++) {
          const trailT = i / trailCount;
          const trailProgress = Math.max(0, Math.min(1, (progress - trailT * 0.2) * 1.6));
          if (trailProgress <= 0) continue;

          // Trail follows COMBINED direction with slight spread
          const spreadAngle = (seededRandom(i + 600) - 0.5) * 0.6 * (1 - combinedStrength * 0.5);
          const trailAngle = combinedAngle + spreadAngle;
          const trailDist = exp.radius * (0.5 + trailProgress * 2.0 + trailT * 0.8) * (0.8 + combinedStrength * 0.4);

          const trailX = exp.x + Math.cos(trailAngle) * trailDist;
          const trailY = exp.y + Math.sin(trailAngle) * trailDist;

          // Trail fades completely when it stops moving
          const trailFade = 1 - trailProgress;
          const trailSize = (3 + seededRandom(i + 601) * 2) * (1 - trailT * 0.5) * trailFade;
          const trailAlpha = alpha * 0.7 * (1 - trailT * 0.3) * trailFade;

          if (trailSize > 0.5 && trailFade > 0.05) {
            // Hot streak
            this.graphics.fillStyle(0xff8844, trailAlpha);
            this.graphics.fillCircle(trailX, trailY, trailSize);
            this.graphics.fillStyle(0xffcc88, trailAlpha * 0.5);
            this.graphics.fillCircle(trailX, trailY, trailSize * 0.4);
          }
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

  // Render labels above selected units and buildings - skip dead entities
  private renderSelectedLabels(): void {
    // Labels for selected units - skip dead units
    for (const entity of this.entitySource.getUnits()) {
      if (entity.selectable?.selected && entity.unit && entity.unit.hp > 0) {
        const { x, y } = entity.transform;
        const { collisionRadius } = entity.unit;
        // Detect unit type by checking all weapons
        const weapons = entity.weapons ?? [];
        let weaponId = 'scout'; // default
        if (weapons.length > 1) {
          weaponId = 'widow';
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

    // Labels for selected buildings - skip dead buildings
    for (const entity of this.entitySource.getBuildings()) {
      if (entity.selectable?.selected && entity.building && entity.building.hp > 0) {
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
  private readonly DARK_GRAY = 0x383838;
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
    // Multi-weapon units (>1 weapon) are widows
    // Single-weapon units are identified by checking all weapons (which will all have same type)
    const weapons = entity.weapons ?? [];
    const weaponCount = weapons.length;
    let weaponId = 'scout'; // default
    if (weaponCount > 1) {
      weaponId = 'widow';
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
      case 'daddy':
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
      case 'shotgun':
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
      case 'widow':
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
      case 'insect':
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
      const treadWidth = r * 0.11;

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
          this.DARK_GRAY,
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
      const treadWidth = r * 0.12;

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
          this.DARK_GRAY,
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
          this.DARK_GRAY,
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
      const treadWidth = r * 0.11;

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
          this.DARK_GRAY,
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
          this.DARK_GRAY,
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
          this.DARK_GRAY,
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

      // Abdomen / "butt" region - large chonky rear section
      const abdomenOffset = -r * 0.9; // Behind the main body
      const abdomenCenterX = x + cos * abdomenOffset;
      const abdomenCenterY = y + sin * abdomenOffset;
      const abdomenLength = r * 1.1; // Long
      const abdomenWidth = r * 0.85; // Wide and chonky

      // Main abdomen shape (dark color)
      const abdomenColor = selected ? UNIT_SELECTED_COLOR : dark;
      this.graphics.fillStyle(abdomenColor, 0.95);

      // Draw abdomen as an elongated oval/egg shape pointing backward
      // Use a rounded polygon with more points at the back for a bulbous look
      const abdomenPoints: { x: number; y: number }[] = [];
      const numPoints = 12;
      for (let i = 0; i < numPoints; i++) {
        const angle = (i / numPoints) * Math.PI * 2;
        // Elongate backward (negative local X) and make it bulbous
        const localAngle = angle + Math.PI; // Rotate so bulge faces backward
        const bulge = 1 + 0.3 * Math.pow(Math.cos(localAngle), 2); // Extra bulge at back
        const rx = abdomenLength * (0.5 + 0.5 * Math.abs(Math.cos(angle))) * bulge;
        const ry = abdomenWidth * (0.7 + 0.3 * Math.abs(Math.sin(angle)));
        const localX = Math.cos(angle) * rx * 0.7;
        const localY = Math.sin(angle) * ry;
        abdomenPoints.push({
          x: abdomenCenterX + cos * localX - sin * localY,
          y: abdomenCenterY + sin * localX + cos * localY,
        });
      }
      this.graphics.fillPoints(abdomenPoints, true);

      // Abdomen segments/stripes (base color for contrast)
      this.graphics.fillStyle(base, 0.6);
      const stripeCount = 4;
      for (let s = 0; s < stripeCount; s++) {
        const stripeOffset = abdomenOffset - abdomenLength * 0.15 - s * (abdomenLength * 0.18);
        const stripeWidth = abdomenWidth * (0.7 - s * 0.12); // Narrower toward back
        const stripeCenterX = x + cos * stripeOffset;
        const stripeCenterY = y + sin * stripeOffset;

        // Draw stripe as thin ellipse
        this.graphics.beginPath();
        for (let i = 0; i <= 16; i++) {
          const angle = (i / 16) * Math.PI * 2;
          const localX = Math.cos(angle) * (r * 0.08);
          const localY = Math.sin(angle) * stripeWidth;
          const px = stripeCenterX + cos * localX - sin * localY;
          const py = stripeCenterY + sin * localX + cos * localY;
          if (i === 0) {
            this.graphics.moveTo(px, py);
          } else {
            this.graphics.lineTo(px, py);
          }
        }
        this.graphics.closePath();
        this.graphics.fillPath();
      }

      // Spinnerets at the tip (light colored details)
      const spinneretOffset = abdomenOffset - abdomenLength * 0.85;
      const spinneretX = x + cos * spinneretOffset;
      const spinneretY = y + sin * spinneretOffset;
      this.graphics.fillStyle(light, 0.8);
      this.graphics.fillCircle(spinneretX, spinneretY, r * 0.12);
      // Small side spinnerets
      const sideSpinneretDist = r * 0.15;
      this.graphics.fillCircle(
        spinneretX - sin * sideSpinneretDist,
        spinneretY + cos * sideSpinneretDist,
        r * 0.07
      );
      this.graphics.fillCircle(
        spinneretX + sin * sideSpinneretDist,
        spinneretY - cos * sideSpinneretDist,
        r * 0.07
      );

      // Main body (hexagonal shape matching inner hexagon, but larger)
      const bodyColor = selected ? UNIT_SELECTED_COLOR : dark;
      this.graphics.fillStyle(bodyColor, 0.95);

      // Draw body as hexagon - larger than inner hexagon, same rotation (30° so flat edge faces forward)
      const bodyHexRadius = r * 0.95; // Larger than inner hexagon (0.65)
      const bodyHexForwardOffset = r * 0.35; // Shifted forward slightly less than inner
      const bodyHexRotationOffset = Math.PI / 6; // 30° rotation to match inner hexagon
      const bodyHexCenterX = x + cos * bodyHexForwardOffset;
      const bodyHexCenterY = y + sin * bodyHexForwardOffset;
      this.drawPolygon(bodyHexCenterX, bodyHexCenterY, bodyHexRadius, 6, bodyRot + bodyHexRotationOffset);

      // Inner carapace pattern (base color) - shifted forward, larger hexagon, rotated 30°
      const hexRadius = r * 0.65;
      const hexForwardOffset = r * 0.5;
      const hexRotationOffset = Math.PI / 6; // Rotate 30° so flat edge faces forward
      const hexCenterX = x + cos * hexForwardOffset;
      const hexCenterY = y + sin * hexForwardOffset;
      this.graphics.fillStyle(base, 0.8);
      this.drawPolygon(hexCenterX, hexCenterY, hexRadius, 6, bodyRot + hexRotationOffset);

      // Central sonic emitter orb (light) - at hexagon center
      this.graphics.fillStyle(light, 0.9);
      this.graphics.fillCircle(hexCenterX, hexCenterY, r * 0.3);
      this.graphics.fillStyle(this.WHITE, 0.95);
      this.graphics.fillCircle(hexCenterX, hexCenterY, r * 0.15);
    }

    // Turret pass - 6 beam emitters at hexagon corners + sonic wave at center
    if (!this.skipTurrets) {
      const weapons = entity.weapons ?? [];
      const hexRadius = r * 0.65;
      const hexForwardOffset = r * 0.5;
      const hexRotationOffset = Math.PI / 6; // Match the 30° rotation

      // 6 beam emitters at hexagon vertices (shifted forward, rotated)
      for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI) / 3 + hexRotationOffset; // 30, 90, 150, 210, 270, 330 degrees
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

      // Sonic wave weapon at center (weapon index 6)
      const sonicWeapon = weapons[6];
      if (sonicWeapon?.config.isWaveWeapon) {
        const hexCenterX = x + cos * hexForwardOffset;
        const hexCenterY = y + sin * hexForwardOffset;
        const sliceAngle = sonicWeapon.currentSliceAngle ?? Math.PI / 16;
        const waveRange = sonicWeapon.fireRange ?? 150;
        const turretAngle = sonicWeapon.turretRotation;

        // Use the same wave effect as the sonic unit
        if (sliceAngle > 0) {
          this.renderWaveEffect(
            hexCenterX,
            hexCenterY,
            turretAngle,
            sliceAngle,
            waveRange,
            light,
            base
          );
        }
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
    const time = Date.now() / 1000;
    const halfAngle = sliceAngle / 2;

    // 1. Draw single faint pie slice showing the active zone
    this.graphics.fillStyle(primaryColor, 0.08);
    this.graphics.beginPath();
    this.graphics.moveTo(x, y);
    this.graphics.arc(
      x,
      y,
      maxRange,
      rotation - halfAngle,
      rotation + halfAngle,
      false
    );
    this.graphics.closePath();
    this.graphics.fill();

    // Draw pie slice border
    this.graphics.lineStyle(1, primaryColor, 0.2);
    this.graphics.beginPath();
    this.graphics.moveTo(x, y);
    this.graphics.lineTo(
      x + Math.cos(rotation - halfAngle) * maxRange,
      y + Math.sin(rotation - halfAngle) * maxRange
    );
    this.graphics.arc(
      x,
      y,
      maxRange,
      rotation - halfAngle,
      rotation + halfAngle,
      false
    );
    this.graphics.lineTo(x, y);
    this.graphics.strokePath();

    // 2. Draw wavy lines pulling INWARD (from outer edge toward center)
    // Waves start transparent at edge, become visible as they approach origin
    const waveCount = 5; // Number of wave arcs
    const pullSpeed = 0.8; // How fast waves pull inward

    for (let i = 0; i < waveCount; i++) {
      // Waves start at edge and pull toward center (inverted phase)
      const basePhase = (1 - ((time * pullSpeed + i / waveCount) % 1));
      const waveRadius = basePhase * maxRange;

      // Skip waves too close to center
      if (waveRadius < 15) continue;

      // Fade IN as wave approaches center (transparent at edge, visible near origin)
      const centerProximity = 1 - (waveRadius / maxRange); // 0 at edge, 1 at center
      const alpha = 0.6 * centerProximity;

      if (alpha < 0.02) continue; // Skip fully transparent waves

      // Draw wavy arc with consistent sine modulation
      const segments = 24;
      const waveAmplitude = 8;
      const waveFrequency = 6;

      this.graphics.lineStyle(2, primaryColor, alpha);
      this.graphics.beginPath();

      for (let j = 0; j <= segments; j++) {
        const t = j / segments;
        const angle = rotation - halfAngle + t * sliceAngle;

        // Add sine wave ripple - animate it to look like it's pulling inward
        const sineOffset = Math.sin(t * Math.PI * waveFrequency + time * 3) * waveAmplitude;
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

    // 3. Draw subtle radial "pull lines" converging on center
    const pullLineCount = 8;
    for (let i = 0; i < pullLineCount; i++) {
      const lineAngle = rotation - halfAngle + (i + 0.5) / pullLineCount * sliceAngle;

      // Animate dashes moving inward
      const dashPhase = (time * 2 + i * 0.3) % 1;
      const dashStart = maxRange * (0.3 + dashPhase * 0.5);
      const dashEnd = maxRange * (0.1 + dashPhase * 0.5);

      if (dashStart > maxRange * 0.9) continue; // Don't draw past edge

      const alpha = 0.25 * (1 - dashPhase); // Fade as it gets closer to center

      this.graphics.lineStyle(1.5, primaryColor, alpha);
      this.graphics.beginPath();
      this.graphics.moveTo(
        x + Math.cos(lineAngle) * dashStart,
        y + Math.sin(lineAngle) * dashStart
      );
      this.graphics.lineTo(
        x + Math.cos(lineAngle) * dashEnd,
        y + Math.sin(lineAngle) * dashEnd
      );
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
    treadColor: number = this.DARK_GRAY,
    lineColor: number = this.GRAY
  ): void {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Draw tread body (dark rectangle with slight rounding effect via outline)
    this.graphics.fillStyle(treadColor, 0.95);
    this.drawOrientedRect(x, y, treadLength, treadWidth, bodyRot);

    // Draw a subtle edge highlight on top edge
    this.graphics.lineStyle(1, lineColor, 0.3);
    const halfLen = treadLength / 2;
    const halfWid = treadWidth / 2;
    const topEdgeX1 = x + cos * halfLen - sin * halfWid;
    const topEdgeY1 = y + sin * halfLen + cos * halfWid;
    const topEdgeX2 = x - cos * halfLen - sin * halfWid;
    const topEdgeY2 = y - sin * halfLen + cos * halfWid;
    this.graphics.lineBetween(topEdgeX1, topEdgeY1, topEdgeX2, topEdgeY2);

    // Fixed fiber spacing - consistent across all tread sizes
    const FIBER_SPACING = 6;  // Spacing between fibers in pixels
    const FIBER_THICKNESS = 2; // Thin fibers for cleaner look

    // Calculate animation offset based on tread rotation
    const wheelRadius = treadWidth * 0.35;
    const linearOffset = treadRotation * wheelRadius;
    const normalizedOffset = ((linearOffset % FIBER_SPACING) + FIBER_SPACING) % FIBER_SPACING;

    // Calculate how many fibers fit in the tread length
    const visibleHalfLen = treadLength * 0.42;  // Slightly inset from edges
    const numFibers = Math.ceil(treadLength / FIBER_SPACING) + 2;

    // Draw animated tread fibers (thin lines for grip texture)
    this.graphics.lineStyle(FIBER_THICKNESS, lineColor, 0.7);
    for (let i = 0; i < numFibers; i++) {
      let lineOffset = (i - numFibers / 2) * FIBER_SPACING + normalizedOffset;

      // Wrap fibers that go outside visible range
      while (lineOffset > visibleHalfLen) lineOffset -= FIBER_SPACING;
      while (lineOffset < -visibleHalfLen) lineOffset += FIBER_SPACING;

      const lx = x + cos * lineOffset;
      const ly = y + sin * lineOffset;
      const perpX = -sin * treadWidth * 0.4;
      const perpY = cos * treadWidth * 0.4;
      this.graphics.lineBetween(lx - perpX, ly - perpY, lx + perpX, ly + perpY);
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

      // Get or create random offsets for this beam (for visual variety)
      let randomOffsets = this.beamRandomOffsets.get(entity.id);
      if (!randomOffsets) {
        randomOffsets = {
          phaseOffset: Math.random() * Math.PI * 2,
          rotationOffset: Math.random() * Math.PI * 2,
          sizeScale: 0.8 + Math.random() * 0.4,  // 0.8-1.2
          pulseSpeed: 0.7 + Math.random() * 0.6,  // 0.7-1.3
        };
        this.beamRandomOffsets.set(entity.id, randomOffsets);
      }

      // Outer glow
      this.graphics.lineStyle(beamWidth + 4, color, 0.3);
      this.graphics.lineBetween(startX, startY, endX, endY);

      // Inner beam
      this.graphics.lineStyle(beamWidth, color, 0.9);
      this.graphics.lineBetween(startX, startY, endX, endY);

      // Core
      this.graphics.lineStyle(beamWidth / 2, 0xffffff, 1);
      this.graphics.lineBetween(startX, startY, endX, endY);

      // Continuous explosion effect at beam endpoint with per-beam randomness
      const baseRadius = beamWidth * 2 + 6;
      const explosionRadius = baseRadius * randomOffsets.sizeScale;
      const pulseTime = this.sprayParticleTime * randomOffsets.pulseSpeed;
      const pulsePhase = ((pulseTime / 80) + randomOffsets.phaseOffset) % (Math.PI * 2);
      const pulseScale = 0.8 + Math.sin(pulsePhase) * 0.2;

      // Outer glow at endpoint
      this.graphics.fillStyle(color, 0.4);
      this.graphics.fillCircle(endX, endY, explosionRadius * pulseScale * 1.3);

      // Main explosion area
      this.graphics.fillStyle(color, 0.6);
      this.graphics.fillCircle(endX, endY, explosionRadius * pulseScale);

      // Hot core
      this.graphics.fillStyle(0xffffff, 0.8);
      this.graphics.fillCircle(endX, endY, explosionRadius * pulseScale * 0.4);

      // Spark particles radiating outward with per-beam rotation offset
      const sparkCount = 6;
      for (let i = 0; i < sparkCount; i++) {
        const baseAngle = (pulseTime / 150 + i / sparkCount) * Math.PI * 2;
        const angle = baseAngle + randomOffsets.rotationOffset;
        const sparkDist =
          explosionRadius *
          (0.8 + Math.sin(pulseTime / 50 + i * 2 + randomOffsets.phaseOffset) * 0.4);
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
