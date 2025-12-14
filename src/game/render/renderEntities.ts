import Phaser from 'phaser';
import type { WorldState } from '../sim/WorldState';
import type { Entity, WaypointType, ActionType } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';
import type { SprayTarget } from '../sim/commanderAbilities';

// Colors
const UNIT_SELECTED_COLOR = 0x00ff88;
const UNIT_OUTLINE_COLOR = 0xffffff;
const BUILDING_COLOR = 0x886644;
const BUILDING_OUTLINE_COLOR = 0xaa8866;
const HEALTH_BAR_BG = 0x333333;
const HEALTH_BAR_FG = 0x44dd44;
const HEALTH_BAR_LOW = 0xff4444;
const BUILD_BAR_FG = 0xffcc00;  // Yellow for build progress
const GHOST_COLOR = 0x88ff88;   // Green tint for placement ghost
const COMMANDER_COLOR = 0xffd700; // Gold for commander indicator

// Waypoint colors by type (legacy - for factories)
const WAYPOINT_COLORS: Record<WaypointType, number> = {
  move: 0x00ff00,   // Green
  patrol: 0x0088ff, // Blue
  fight: 0xff4444,  // Red
};

// Action colors by type (for unit action queue)
const ACTION_COLORS: Record<ActionType, number> = {
  move: 0x00ff00,   // Green
  patrol: 0x0088ff, // Blue
  fight: 0xff4444,  // Red
  build: 0xffcc00,  // Yellow for building
  repair: 0x44ff44, // Light green for repair
};

// Spray effect colors
const SPRAY_BUILD_COLOR = 0x44ff44;   // Green for building
const SPRAY_HEAL_COLOR = 0x4488ff;    // Blue for healing

// Range circle colors
const VISION_RANGE_COLOR = 0xffff88;   // Yellow for vision range
const WEAPON_RANGE_COLOR = 0xff4444;   // Red for weapon range
const BUILD_RANGE_COLOR = 0x44ff44;    // Green for build range

export class EntityRenderer {
  private scene: Phaser.Scene;
  private graphics: Phaser.GameObjects.Graphics;
  private world: WorldState;
  private sprayTargets: SprayTarget[] = [];
  private sprayParticleTime: number = 0;

  constructor(scene: Phaser.Scene, world: WorldState) {
    this.scene = scene;
    this.graphics = scene.add.graphics();
    this.world = world;
  }

  // Set spray targets for rendering
  setSprayTargets(targets: SprayTarget[]): void {
    this.sprayTargets = targets;
  }

  // Render all entities
  render(): void {
    this.graphics.clear();

    // Update particle time for spray animation
    this.sprayParticleTime += 16; // ~60fps

    // Render buildings first (below units)
    for (const entity of this.world.getBuildings()) {
      this.renderBuilding(entity);
    }

    // Render projectiles (below units)
    for (const entity of this.world.getProjectiles()) {
      this.renderProjectile(entity);
    }

    // Render spray effects (above projectiles, below units)
    for (const target of this.sprayTargets) {
      this.renderSprayEffect(target);
    }

    // Render waypoints for selected units (below units but above projectiles)
    for (const entity of this.world.getUnits()) {
      if (entity.selectable?.selected) {
        this.renderWaypoints(entity);
      }
    }

    // Render waypoints for selected factories
    for (const entity of this.world.getBuildings()) {
      if (entity.selectable?.selected && entity.factory) {
        this.renderFactoryWaypoints(entity);
      }
    }

    // Render range circles for selected units (below unit bodies)
    for (const entity of this.world.getUnits()) {
      if (entity.selectable?.selected) {
        this.renderRangeCircles(entity);
      }
    }

    // Render units
    for (const entity of this.world.getUnits()) {
      this.renderUnit(entity);
    }
  }

  // Render range circles for selected units
  private renderRangeCircles(entity: Entity): void {
    if (!entity.unit) return;

    const { transform, unit, weapon, builder } = entity;
    const { x, y } = transform;

    // Vision range (outermost - yellow)
    if (unit.visionRange) {
      this.graphics.lineStyle(1, VISION_RANGE_COLOR, 0.3);
      this.graphics.strokeCircle(x, y, unit.visionRange);
    }

    // Weapon range (red)
    if (weapon) {
      this.graphics.lineStyle(1.5, WEAPON_RANGE_COLOR, 0.4);
      this.graphics.strokeCircle(x, y, weapon.config.range);
    }

    // Build range (green) - only for builders
    if (builder) {
      this.graphics.lineStyle(1.5, BUILD_RANGE_COLOR, 0.4);
      this.graphics.strokeCircle(x, y, builder.buildRange);
    }
  }

  // Get player color
  private getPlayerColor(playerId: number | undefined): number {
    if (playerId === undefined) return 0x888888;
    return PLAYER_COLORS[playerId]?.primary ?? 0x888888;
  }

  // Render a unit (circle)
  private renderUnit(entity: Entity): void {
    if (!entity.unit) return;

    const { transform, unit, selectable, ownership } = entity;
    const { x, y, rotation } = transform;
    const { radius, hp, maxHp } = unit;
    const isSelected = selectable?.selected ?? false;
    const playerId = ownership?.playerId;

    // Get player color
    const playerColor = this.getPlayerColor(playerId);

    // Selection ring
    if (isSelected) {
      this.graphics.lineStyle(3, UNIT_SELECTED_COLOR, 1);
      this.graphics.strokeCircle(x, y, radius + 4);
    }

    // Unit body
    const fillColor = isSelected ? UNIT_SELECTED_COLOR : playerColor;
    this.graphics.fillStyle(fillColor, 0.9);
    this.graphics.fillCircle(x, y, radius);

    // Outline
    this.graphics.lineStyle(2, UNIT_OUTLINE_COLOR, 0.8);
    this.graphics.strokeCircle(x, y, radius);

    // Inner circle showing player color when selected
    if (isSelected) {
      this.graphics.fillStyle(playerColor, 1);
      this.graphics.fillCircle(x, y, radius * 0.5);
    }

    // Movement direction indicator (white arrow showing body facing/movement)
    const moveLength = radius * 1.0;
    const moveDirX = x + Math.cos(rotation) * moveLength;
    const moveDirY = y + Math.sin(rotation) * moveLength;
    this.graphics.lineStyle(2, 0xaaaaaa, 0.7);
    this.graphics.lineBetween(x, y, moveDirX, moveDirY);
    // Small arrowhead
    const arrowSize = 4;
    const arrowAngle = Math.PI * 0.8;
    this.graphics.lineBetween(
      moveDirX,
      moveDirY,
      moveDirX + Math.cos(rotation + arrowAngle) * arrowSize,
      moveDirY + Math.sin(rotation + arrowAngle) * arrowSize
    );
    this.graphics.lineBetween(
      moveDirX,
      moveDirY,
      moveDirX + Math.cos(rotation - arrowAngle) * arrowSize,
      moveDirY + Math.sin(rotation - arrowAngle) * arrowSize
    );

    // Turret/weapon direction indicator (colored line showing aim direction)
    if (entity.weapon) {
      const weaponColor = (entity.weapon.config.color as number) ?? 0xffffff;
      const turretRotation = unit.turretRotation ?? rotation;
      const turretLength = radius * 1.3;
      const turretEndX = x + Math.cos(turretRotation) * turretLength;
      const turretEndY = y + Math.sin(turretRotation) * turretLength;

      // Turret barrel line
      this.graphics.lineStyle(3, weaponColor, 0.9);
      this.graphics.lineBetween(x, y, turretEndX, turretEndY);

      // Weapon type indicator (small colored dot at center)
      this.graphics.fillStyle(weaponColor, 0.9);
      this.graphics.fillCircle(x, y, 4);
    }

    // Commander indicator (gold star/crown)
    if (entity.commander) {
      // Gold circle around commander
      this.graphics.lineStyle(2, COMMANDER_COLOR, 0.8);
      this.graphics.strokeCircle(x, y, radius + 8);

      // Small gold dots around the circle (crown points)
      const dotCount = 5;
      for (let i = 0; i < dotCount; i++) {
        const angle = (i / dotCount) * Math.PI * 2 - Math.PI / 2;
        const dotX = x + Math.cos(angle) * (radius + 8);
        const dotY = y + Math.sin(angle) * (radius + 8);
        this.graphics.fillStyle(COMMANDER_COLOR, 1);
        this.graphics.fillCircle(dotX, dotY, 3);
      }
    }

    // Health bar (always show)
    const healthPercent = hp / maxHp;
    this.renderHealthBar(x, y - radius - 10, radius * 2, 4, healthPercent);

    // Target line (show line to current attack target)
    if (entity.weapon?.targetEntityId !== null && isSelected) {
      const target = this.world.getEntity(entity.weapon!.targetEntityId!);
      if (target) {
        this.graphics.lineStyle(1, 0xff0000, 0.3);
        this.graphics.lineBetween(x, y, target.transform.x, target.transform.y);
      }
    }
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
        this.graphics.lineBetween(lastAction.x, lastAction.y, firstPatrolAction.x, firstPatrolAction.y);
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
          wp.x, wp.y - 10,
          wp.x + 10, wp.y - 5,
          wp.x, wp.y
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
        const firstPatrolIndex = waypoints.findIndex(wp => wp.type === 'patrol');
        if (firstPatrolIndex >= 0) {
          const firstPatrolWp = waypoints[firstPatrolIndex];
          const color = WAYPOINT_COLORS['patrol'];
          // Draw dashed-style return line (using lower alpha)
          this.graphics.lineStyle(lineWidth, color, 0.25);
          this.graphics.lineBetween(lastWp.x, lastWp.y, firstPatrolWp.x, firstPatrolWp.y);
        }
      }
    }
  }

  // Render spray effect from commander to target (build/heal)
  private renderSprayEffect(target: SprayTarget): void {
    const color = target.type === 'build' ? SPRAY_BUILD_COLOR : SPRAY_HEAL_COLOR;
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
      const streamAngle = ((stream / (streamCount - 1)) - 0.5) * 1.2; // -0.6 to 0.6 radians spread

      for (let i = 0; i < particlesPerStream; i++) {
        // Each particle has a different phase
        const phase = (baseTime / 250 + i / particlesPerStream + stream * 0.13) % 1;

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
        const spreadAngle = Math.sin(baseTime / 100 + i * 3 + stream) * spreadNearTarget;
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
      const splatterDist = (Math.sin(baseTime / 150 + i * 2) * 0.3 + 0.7) * targetSize * 0.6;
      const sx = targetX + Math.cos(angle) * splatterDist;
      const sy = targetY + Math.sin(angle) * splatterDist;
      const splatterAlpha = (0.5 + Math.sin(baseTime / 100 + i) * 0.3) * effectiveIntensity;
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

    const { transform, projectile } = entity;
    const { x, y } = transform;
    const config = projectile.config;
    const color = (config.color as number) ?? 0xffffff;

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
    } else if (entity.dgunProjectile) {
      // D-gun projectile - big, fiery, intimidating
      const radius = config.projectileRadius ?? 25;

      // Outer glow (pulsating)
      const pulsePhase = (projectile.timeAlive / 100) % 1;
      const pulseRadius = radius * (1.3 + 0.2 * Math.sin(pulsePhase * Math.PI * 2));
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
        projectile.velocityX * projectile.velocityX + projectile.velocityY * projectile.velocityY
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
        projectile.velocityX * projectile.velocityX + projectile.velocityY * projectile.velocityY
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
  }

  // Render factory-specific elements (queue, rally point)
  private renderFactory(entity: Entity, _left: number, top: number, width: number, height: number): void {
    if (!entity.factory) return;

    const factory = entity.factory;
    const x = entity.transform.x;
    const y = entity.transform.y;
    const isSelected = entity.selectable?.selected ?? false;

    // Only draw simple rally point when NOT selected (waypoints are drawn separately when selected)
    if (!isSelected) {
      // Draw rally point line and marker
      this.graphics.lineStyle(1, 0x00ff00, 0.4);
      this.graphics.lineBetween(x, y, factory.rallyX, factory.rallyY);

      // Rally point marker (small flag)
      this.graphics.fillStyle(0x00ff00, 0.7);
      this.graphics.fillTriangle(
        factory.rallyX, factory.rallyY - 8,
        factory.rallyX + 8, factory.rallyY - 4,
        factory.rallyX, factory.rallyY
      );
      this.graphics.lineStyle(1, 0x00ff00, 0.8);
      this.graphics.lineBetween(factory.rallyX, factory.rallyY, factory.rallyX, factory.rallyY - 8);
    }

    // Production progress indicator (if producing)
    if (factory.isProducing && factory.buildQueue.length > 0) {
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

      // Show "+N" if more than 5 in queue
      if (factory.buildQueue.length > 5) {
        // Would need text for this - skip for now
      }
    }
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
