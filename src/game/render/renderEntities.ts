// Entity Renderer - Main orchestrator for rendering all game entities
// Delegates to specialized helper modules for specific rendering tasks

import Phaser from 'phaser';
import type { Entity, EntityId } from '../sim/types';
import type { SprayTarget } from '../sim/commanderAbilities';
import { BurnMarkSystem } from './BurnMarkSystem';
import { DebrisSystem } from './DebrisSystem';
import { LocomotionManager } from './LocomotionManager';
import {
  getGraphicsConfig,
  getRenderMode,
  getRangeToggle,
  anyRangeToggleActive,
  getProjRangeToggle,
  anyProjRangeToggleActive,
  getUnitRadiusToggle,
  anyUnitRadiusToggleActive,
  setCurrentZoom,
} from '@/clientBarConfig';
import { magnitude } from '../math';
import { FIRE_EXPLOSION } from '../../explosionConfig';
import { getUnitBlueprint } from '../sim/blueprints';
import type { BarrelShape, SpinConfig } from '../../config';
import { PLAYER_CLIENT_GRAPHICS_LEVEL_OF_DETAIL as LOD } from '../../lodConfig';

// Import from helper modules
import type {
  EntitySource,
  ExplosionEffect,
  UnitRenderContext,
  BeamRandomOffsets,
  ProjectileTrail,
} from './types';
import { COLORS } from './types';
import { createColorPalette, setGrateFrameTime } from './helpers';
import { renderExplosion, renderSprayEffect } from './effects';
import { drawTurret, setTurretFrameTime, setSkipForceFieldZones, renderForceFieldZonesEarly } from './TurretRenderer';
import {
  drawScoutUnit,
  drawBurstUnit,
  drawBeamUnit,
  drawBrawlUnit,
  drawMortarUnit,
  drawSnipeUnit,
  drawTankUnit,
  drawHippoUnit,
  drawArachnidUnit,
  drawForceFieldUnit,
  drawLorisUnit,
  drawCommanderUnit,
} from './units';
import {
  renderSelectedLabels,
  renderCommanderCrown,
  renderRangeCircles,
  renderUnitRadiusCircles,
  renderWaypoints,
  renderFactoryWaypoints,
} from './selection';
import { renderBuilding } from './BuildingRenderer';
import { renderProjectile, renderProjRangeCircles } from './ProjectileRenderer';
import { renderBuildBar, renderHealthBar } from './UIBars';

// Re-export EntitySource for external use
export type { EntitySource, ExplosionEffect };

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

  // Locomotion (legs, treads, wheels) delegated to LocomotionManager
  private locomotion = new LocomotionManager();

  // Per-projectile random offsets for visual variety
  private beamRandomOffsets: Map<EntityId, BeamRandomOffsets> = new Map();

  // Position-history trails for projectile rendering
  private projectileTrails: Map<EntityId, ProjectileTrail> = new Map();

  // Scorched earth: burn marks left by beam weapons
  private burnMarkSystem = new BurnMarkSystem();

  // Death debris fragments
  private debrisSystem = new DebrisSystem();

  // Barrel spin state per entity: { angle (rad), speed (rad/sec) }
  private barrelSpins: Map<EntityId, { angle: number; speed: number }> =
    new Map();

  // Reusable Set for per-frame entity ID lookups (avoids allocating new Set + Array each frame)
  private _reusableIdSet: Set<EntityId> = new Set();

  // Cached range visibility objects (avoids per-frame allocation)
  private _rangeVisToggle = {
    trackAcquire: false,
    trackRelease: false,
    engageAcquire: false,
    engageRelease: false,
    build: false,
  };
  private _projRangeVis = {
    collision: false,
    primary: false,
    secondary: false,
  };
  private _unitRadiusVis = { visual: false, shot: false, push: false };

  constructor(scene: Phaser.Scene, entitySource: EntitySource) {
    this.scene = scene;
    this.graphics = scene.add.graphics();
    this.entitySource = entitySource;
  }

  /**
   * Check if a point is visible within the camera viewport (with padding)
   */
  private isInViewport(x: number, y: number, padding: number = 100): boolean {
    const mode = getRenderMode();
    if (mode === 'all') {
      return true; // Skip culling, render everything
    }
    const camera = this.scene.cameras.main;
    const view = camera.worldView;
    // 'padded' mode: add 30% of viewport dimensions as extra margin
    const extra =
      mode === 'padded' ? Math.max(view.width, view.height) * 0.3 : 0;
    const p = padding + extra;
    return (
      x >= view.x - p &&
      x <= view.right + p &&
      y >= view.y - p &&
      y <= view.bottom + p
    );
  }

  // ==================== LOCOMOTION DELEGATION ====================

  updateLocomotion(dtMs: number): void {
    this.locomotion.updateLocomotion(this.entitySource, dtMs);
  }

  // ==================== BARREL SPIN ====================

  updateMinigunSpins(dtMs: number): void {
    const dtSec = dtMs / 1000;
    const units = this.entitySource.getUnits();

    // Build live ID set for cleanup
    this._reusableIdSet.clear();
    for (const u of units) this._reusableIdSet.add(u.id);
    for (const id of this.barrelSpins.keys()) {
      if (!this._reusableIdSet.has(id)) this.barrelSpins.delete(id);
    }

    for (const entity of units) {
      if (!entity.turrets) continue;

      // Find spin config from any weapon that has one (simpleMultiBarrel or coneMultiBarrel)
      let spinConfig: SpinConfig | undefined;
      for (const w of entity.turrets) {
        const tc = w.config.barrel as BarrelShape | undefined;
        if (
          tc &&
          (tc.type === 'simpleMultiBarrel' || tc.type === 'coneMultiBarrel')
        ) {
          spinConfig = tc.spin;
          break;
        }
      }
      if (!spinConfig) continue;

      let state = this.barrelSpins.get(entity.id);
      if (!state) {
        state = { angle: 0, speed: spinConfig.idle };
        this.barrelSpins.set(entity.id, state);
      }

      // Check if any weapon is firing
      const firing = entity.turrets.some((w) => w.state === 'engaged');

      if (firing) {
        state.speed = Math.min(
          state.speed + spinConfig.accel * dtSec,
          spinConfig.max,
        );
      } else {
        state.speed = Math.max(
          state.speed - spinConfig.decel * dtSec,
          spinConfig.idle,
        );
      }

      state.angle += state.speed * dtSec;
    }
  }

  private getBarrelSpinAngle(entityId: EntityId): number {
    return this.barrelSpins.get(entityId)?.angle ?? 0;
  }

  // ==================== EXPLOSION MANAGEMENT ====================

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
    attackerY?: number,
    collisionRadius?: number,
    primaryRadius?: number,
    secondaryRadius?: number,
    entityCollisionRadius?: number,
  ): void {
    const baseRadius = 8;
    const baseLifetime = type === 'death' ? 600 : FIRE_EXPLOSION.baseLifetimeMs;
    const radiusScale = Math.sqrt(radius / baseRadius);
    const lifetime = baseLifetime * radiusScale;

    const velocityMag =
      velocityX !== undefined && velocityY !== undefined
        ? magnitude(velocityX, velocityY)
        : 0;
    const penetrationMag =
      penetrationX !== undefined && penetrationY !== undefined
        ? magnitude(penetrationX, penetrationY)
        : 0;
    const attackerMag =
      attackerX !== undefined && attackerY !== undefined
        ? magnitude(attackerX, attackerY)
        : 0;

    const combinedX = (velocityX ?? 0) + (penetrationX ?? 0) + (attackerX ?? 0);
    const combinedY = (velocityY ?? 0) + (penetrationY ?? 0) + (attackerY ?? 0);
    const combinedMag = magnitude(combinedX, combinedY);

    this.explosions.push({
      x,
      y,
      radius,
      color,
      lifetime,
      elapsed: 0,
      type,
      velocityX,
      velocityY,
      velocityMag,
      penetrationX,
      penetrationY,
      penetrationMag,
      attackerX,
      attackerY,
      attackerMag,
      combinedX,
      combinedY,
      combinedMag,
      collisionRadius,
      primaryRadius,
      secondaryRadius,
      entityCollisionRadius,
    });
  }

  /**
   * Add debris fragments for a destroyed unit.
   * Generates pieces from a per-unit-type template, applies random velocities with hit-direction bias.
   */
  addDebris(
    x: number,
    y: number,
    unitType: string,
    rotation: number,
    radius: number,
    color: number,
    hitDirX: number,
    hitDirY: number,
  ): void {
    this.debrisSystem.addDebris(
      x,
      y,
      unitType,
      rotation,
      radius,
      color,
      hitDirX,
      hitDirY,
    );
  }

  updateExplosions(dtMs: number): void {
    // In-place compaction avoids .filter() array allocation every frame
    let writeIdx = 0;
    for (let i = 0; i < this.explosions.length; i++) {
      const exp = this.explosions[i];
      exp.elapsed += dtMs;
      if (exp.elapsed < exp.lifetime) {
        this.explosions[writeIdx++] = exp;
      }
    }
    this.explosions.length = writeIdx;

    // Age burn marks (delegated to BurnMarkSystem)
    const burnCutoff = getGraphicsConfig().burnMarkAlphaCutoff;
    this.burnMarkSystem.update(dtMs, burnCutoff);

    // Age debris fragments (delegated to DebrisSystem)
    this.debrisSystem.update(dtMs, burnCutoff);
  }

  // ==================== LABEL MANAGEMENT ====================

  private getLabel(): Phaser.GameObjects.Text {
    if (this.activeLabelCount < this.labelPool.length) {
      const label = this.labelPool[this.activeLabelCount];
      label.setVisible(true);
      this.activeLabelCount++;
      return label;
    }

    const label = this.scene.add.text(0, 0, '', {
      fontSize: '12px',
      fontFamily: 'monospace',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
      align: 'center',
    });
    label.setOrigin(0.5, 1);
    label.setDepth(1000);
    this.labelPool.push(label);
    this.activeLabelCount++;
    return label;
  }

  private resetLabels(): void {
    for (let i = 0; i < this.activeLabelCount; i++) {
      this.labelPool[i].setVisible(false);
    }
    this.activeLabelCount = 0;
  }

  // ==================== ENTITY SOURCE ====================

  setEntitySource(source: EntitySource): void {
    this.entitySource = source;
  }

  setSprayTargets(targets: SprayTarget[]): void {
    this.sprayTargets = targets;
  }

  // ==================== VISIBILITY CACHING ====================

  private visibleUnits: Entity[] = [];
  private visibleBuildings: Entity[] = [];
  private visibleProjectiles: Entity[] = [];
  private selectedUnits: Entity[] = [];
  private selectedFactories: Entity[] = [];

  private collectVisibleEntities(): void {
    this.visibleUnits.length = 0;
    this.visibleBuildings.length = 0;
    this.visibleProjectiles.length = 0;
    this.selectedUnits.length = 0;
    this.selectedFactories.length = 0;

    for (const entity of this.entitySource.getUnits()) {
      if (!entity.unit || entity.unit.hp <= 0) continue;
      if (!this.isInViewport(entity.transform.x, entity.transform.y, 100))
        continue;
      this.visibleUnits.push(entity);
      if (entity.selectable?.selected) this.selectedUnits.push(entity);
    }

    for (const entity of this.entitySource.getBuildings()) {
      if (!entity.building || entity.building.hp <= 0) continue;
      if (!this.isInViewport(entity.transform.x, entity.transform.y, 150))
        continue;
      this.visibleBuildings.push(entity);
      if (entity.selectable?.selected && entity.factory)
        this.selectedFactories.push(entity);
    }

    for (const entity of this.entitySource.getProjectiles()) {
      if (!this.isInViewport(entity.transform.x, entity.transform.y, 50))
        continue;
      this.visibleProjectiles.push(entity);
    }
  }

  // ==================== MAIN RENDER ====================

  render(): void {
    this.graphics.clear();
    this.resetLabels();

    const camera = this.scene.cameras.main;
    setCurrentZoom(camera.zoom);
    const nowSec = Date.now() / 1000;
    setTurretFrameTime(nowSec);
    setGrateFrameTime(nowSec);
    const gfxConfig = getGraphicsConfig();
    this.sprayParticleTime += 16;
    this.collectVisibleEntities();

    // 0. Force field zones (opaque, pre-blended against background — under everything)
    for (const entity of this.visibleUnits) {
      if (!entity.turrets) continue;
      const unitType = entity.unit?.unitType ?? 'jackal';
      let mounts: { x: number; y: number }[];
      try { mounts = getUnitBlueprint(unitType).chassisMounts; }
      catch { mounts = [{ x: 0, y: 0 }]; }
      renderForceFieldZonesEarly(this.graphics, entity, mounts);
    }
    setSkipForceFieldZones(true);

    // 0b. Sample beam endpoints for scorched earth burn marks
    this.burnMarkSystem.sampleBeamEndpoints(
      this.entitySource.getProjectiles(),
      gfxConfig.burnMarkFramesSkip,
    );

    // 0c. Render scorched earth burn marks
    this.burnMarkSystem.render(this.graphics, (x, y, padding) =>
      this.isInViewport(x, y, padding),
    );

    // 0d. Death debris fragments
    this.debrisSystem.render(this.graphics, (x, y, p) =>
      this.isInViewport(x, y, p),
    );

    // 1. Buildings
    const buildBarFn = (
      x: number,
      y: number,
      w: number,
      h: number,
      p: number,
    ) => renderBuildBar(this.graphics, x, y, w, h, p);
    const healthBarFn = (
      x: number,
      y: number,
      w: number,
      h: number,
      p: number,
    ) => renderHealthBar(this.graphics, x, y, w, h, p);
    for (const entity of this.visibleBuildings) {
      renderBuilding(
        this.graphics,
        entity,
        this.sprayParticleTime,
        buildBarFn,
        healthBarFn,
      );
    }

    // 2. Waypoints for selected units
    for (const entity of this.selectedUnits) {
      renderWaypoints(this.graphics, entity, camera);
    }
    for (const entity of this.selectedFactories) {
      renderFactoryWaypoints(this.graphics, entity, camera);
    }

    // 3. Range circles (reuse cached visibility objects to avoid per-frame allocation)
    if (anyRangeToggleActive()) {
      this._rangeVisToggle.trackAcquire = getRangeToggle('trackAcquire');
      this._rangeVisToggle.trackRelease = getRangeToggle('trackRelease');
      this._rangeVisToggle.engageAcquire = getRangeToggle('engageAcquire');
      this._rangeVisToggle.engageRelease = getRangeToggle('engageRelease');
      this._rangeVisToggle.build = getRangeToggle('build');
      for (const entity of this.visibleUnits) {
        renderRangeCircles(this.graphics, entity, this._rangeVisToggle);
      }
    }

    // 4. Unit bodies (chassis only — no turrets)
    for (const entity of this.visibleUnits) {
      this.renderUnitBody(entity);
    }

    // 5. Turrets (weapon-driven, rendered at mount points)
    //    Force field zones were already drawn in step 1b (opaque early pass).
    for (const entity of this.visibleUnits) {
      this.renderUnitTurrets(entity);
    }
    setSkipForceFieldZones(false);

    // 6. Projectiles (clean up stale beam offsets + trail entries inline)
    this._reusableIdSet.clear();
    for (const entity of this.visibleProjectiles) {
      this._reusableIdSet.add(entity.id);

      // Sample position into trail ring buffer for non-beam projectiles (skip for dot/core — no trails)
      let trail: ProjectileTrail | undefined;
      const pStyle = gfxConfig.projectileStyle;
      if (pStyle !== 'dot' && pStyle !== 'core' && entity.projectile && entity.projectile.projectileType !== 'beam' && entity.projectile.projectileType !== 'laser') {
        trail = this.projectileTrails.get(entity.id);
        const isDgun = !!entity.dgunProjectile;
        const trailCap = isDgun
          ? 10
          : ((entity.projectile.config.shot.type === 'projectile' ? entity.projectile.config.shot.trailLength : undefined) ?? 3) + 4;
        if (!trail || trail.capacity !== trailCap) {
          trail = {
            positions: new Float32Array(trailCap * 2),
            head: 0,
            count: 0,
            capacity: trailCap,
          };
          this.projectileTrails.set(entity.id, trail);
        }
        const idx = trail.head * 2;
        trail.positions[idx] = entity.transform.x;
        trail.positions[idx + 1] = entity.transform.y;
        trail.head = (trail.head + 1) % trail.capacity;
        if (trail.count < trail.capacity) trail.count++;
      }

      renderProjectile(
        this.graphics,
        entity,
        this.beamRandomOffsets,
        this.sprayParticleTime,
        trail,
      );
    }
    for (const id of this.beamRandomOffsets.keys()) {
      if (!this._reusableIdSet.has(id)) this.beamRandomOffsets.delete(id);
    }
    for (const id of this.projectileTrails.keys()) {
      if (!this._reusableIdSet.has(id)) this.projectileTrails.delete(id);
    }

    // 6b. Projectile range circles (collision + splash radii)
    if (anyProjRangeToggleActive()) {
      this._projRangeVis.collision = getProjRangeToggle('collision');
      this._projRangeVis.primary = getProjRangeToggle('primary');
      this._projRangeVis.secondary = getProjRangeToggle('secondary');
      for (const entity of this.visibleProjectiles) {
        renderProjRangeCircles(this.graphics, entity, this._projRangeVis);
      }
    }

    // 6c. Unit radius circles (collision + physics hitbox)
    if (anyUnitRadiusToggleActive()) {
      this._unitRadiusVis.visual = getUnitRadiusToggle('visual');
      this._unitRadiusVis.shot = getUnitRadiusToggle('shot');
      this._unitRadiusVis.push = getUnitRadiusToggle('push');
      for (const entity of this.visibleUnits) {
        renderUnitRadiusCircles(this.graphics, entity, this._unitRadiusVis);
      }
    }

    // 7. Spray effects
    for (const target of this.sprayTargets) {
      if (!this.isInViewport(target.target.pos.x, target.target.pos.y, 50)) continue;
      renderSprayEffect(this.graphics, target, this.sprayParticleTime);
    }

    // 8. Explosions (quality determined by zoom-based graphics config)
    for (const explosion of this.explosions) {
      if (!this.isInViewport(explosion.x, explosion.y, explosion.radius + 50))
        continue;
      renderExplosion(this.graphics, explosion);
    }

    // 9. Labels (topmost)
    renderSelectedLabels(this.graphics, this.entitySource, () =>
      this.getLabel(),
    );
  }

  // ==================== UNIT BODY RENDERING ====================

  private renderUnitBody(entity: Entity): void {
    if (!entity.unit) return;

    const { transform, unit, selectable, ownership } = entity;
    const { x, y, rotation } = transform;
    const { radiusColliderUnitShot: radius, hp, maxHp } = unit;
    const isSelected = selectable?.selected ?? false;

    const gfx = getGraphicsConfig();
    // Get unit type for renderer selection
    const unitType = unit.unitType ?? 'jackal';
    const fullPalette = createColorPalette(ownership?.playerId);
    // When palette shading is off: use only the base player color, no light/dark variants
    const palette = gfx.paletteShading
      ? fullPalette
      : {
          base: fullPalette.base,
          light: fullPalette.base,
          dark: fullPalette.base,
        };

    // 'circles': concentric filled circles — push radius (dark) behind shot radius (light)
    if (gfx.unitShape === 'circles') {
      const drawPush = LOD.CIRCLES_DRAW_PUSH;
      const drawShot = LOD.CIRCLES_DRAW_SHOT;
      const pushRadius = unit.radiusColliderUnitUnit;
      const shotRadius = unit.radiusColliderUnitShot;
      const outerRadius = drawPush ? pushRadius : shotRadius;
      if (drawPush) {
        this.graphics.fillStyle(fullPalette.dark, 1);
        this.graphics.fillCircle(x, y, pushRadius);
      }
      if (drawShot) {
        this.graphics.fillStyle(fullPalette.base, 1);
        this.graphics.fillCircle(x, y, shotRadius);
      }
      if (isSelected) {
        this.graphics.lineStyle(3, COLORS.UNIT_SELECTED, 1);
        this.graphics.strokeCircle(x, y, outerRadius + 5);
      }
      if (entity.commander) {
        renderCommanderCrown(this.graphics, x, y, outerRadius);
      }
      const healthPercent = hp / maxHp;
      if (healthPercent < 1) {
        renderHealthBar(
          this.graphics,
          x,
          y - outerRadius - 10,
          outerRadius * 2,
          4,
          healthPercent,
        );
      }
      return;
    }

    // Selection ring
    if (isSelected) {
      this.graphics.lineStyle(3, COLORS.UNIT_SELECTED, 1);
      this.graphics.strokeCircle(x, y, radius + 5);
    }

    const ctx: UnitRenderContext = {
      graphics: this.graphics,
      x,
      y,
      radius,
      bodyRot: rotation,
      palette,
      isSelected,
      entity,
      chassisDetail: gfx.chassisDetail,
    };

    // Blueprint-driven renderer dispatch
    let bp;
    try {
      bp = getUnitBlueprint(unitType);
    } catch {
      bp = null;
    }
    const renderer = bp?.renderer ?? 'scout';

    // Skip leg object creation when legs are disabled (LOD 'none')
    const legsEnabled = gfx.legs !== 'none';
    const emptyLegs: import('../render/ArachnidLeg').ArachnidLeg[] = [];
    const getLegs = () => legsEnabled ? this.locomotion.getOrCreateLegs(entity, unitType) : emptyLegs;

    switch (renderer) {
      case 'commander':
        drawCommanderUnit(ctx, getLegs());
        break;
      case 'scout':
        drawScoutUnit(ctx, this.locomotion.getVehicleWheels(entity.id));
        break;
      case 'burst':
        drawBurstUnit(ctx, this.locomotion.getTankTreads(entity.id));
        break;
      case 'forceField':
        drawForceFieldUnit(ctx, getLegs());
        break;
      case 'brawl':
        drawBrawlUnit(ctx, this.locomotion.getTankTreads(entity.id));
        break;
      case 'mortar':
        drawMortarUnit(ctx, this.locomotion.getVehicleWheels(entity.id));
        break;
      case 'snipe':
        drawSnipeUnit(ctx, getLegs());
        break;
      case 'tank':
        drawTankUnit(ctx, this.locomotion.getTankTreads(entity.id));
        break;
      case 'hippo':
        drawHippoUnit(ctx, this.locomotion.getTankTreads(entity.id));
        break;
      case 'arachnid':
        drawArachnidUnit(ctx, getLegs());
        break;
      case 'beam':
        drawBeamUnit(ctx, getLegs());
        break;
      case 'loris':
        drawLorisUnit(ctx, this.locomotion.getTankTreads(entity.id));
        break;
      default:
        drawScoutUnit(ctx, this.locomotion.getVehicleWheels(entity.id));
    }

    // Post-body overlays
    if (entity.commander) {
      renderCommanderCrown(this.graphics, x, y, radius);
    }

    const healthPercent = hp / maxHp;
    if (healthPercent < 1) {
      renderHealthBar(
        this.graphics,
        x,
        y - radius - 10,
        radius * 2,
        4,
        healthPercent,
      );
    }

    if (entity.turrets && isSelected) {
      for (const weapon of entity.turrets) {
        if (weapon.target != null) {
          const target = this.entitySource.getEntity(weapon.target);
          if (target) {
            this.graphics.lineStyle(1, 0xff0000, 0.3);
            this.graphics.lineBetween(
              x,
              y,
              target.transform.x,
              target.transform.y,
            );
          }
        }
      }
    }
  }

  // ==================== TURRET RENDERING (WEAPON-DRIVEN) ====================

  private renderUnitTurrets(entity: Entity): void {
    if (!entity.unit || !entity.turrets || entity.turrets.length === 0) return;

    const { transform, unit, ownership } = entity;
    const { x, y, rotation: bodyRot } = transform;
    const r = unit.radiusColliderUnitShot;

    const unitType = entity.commander
      ? 'commander'
      : (unit.unitType ?? 'jackal');
    let mounts: { x: number; y: number }[];
    try {
      mounts = getUnitBlueprint(unitType).chassisMounts;
    } catch {
      mounts = [{ x: 0, y: 0 }];
    }

    const gfx = getGraphicsConfig();
    const fullPalette = createColorPalette(ownership?.playerId);
    const palette = gfx.paletteShading
      ? fullPalette
      : {
          base: fullPalette.base,
          light: fullPalette.base,
          dark: fullPalette.base,
        };

    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);
    const spinAngle = gfx.barrelSpin ? this.getBarrelSpinAngle(entity.id) : 0;

    // Two passes: force field turrets first (underneath), then regular turrets on top
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < entity.turrets.length; i++) {
        const weapon = entity.turrets[i];
        const isForceField =
          (weapon.config.barrel as { type?: string } | undefined)?.type ===
          'complexSingleEmitter';
        if (pass === 0 ? !isForceField : isForceField) continue;

        // Skip manual-fire turrets (e.g. d-gun) when idle — only render while aiming/firing
        if (weapon.config.isManualFire && weapon.state === 'idle') continue;

        const mount = mounts[Math.min(i, mounts.length - 1)];
        const mountX = x + cos * mount.x * r - sin * mount.y * r;
        const mountY = y + sin * mount.x * r + cos * mount.y * r;

        drawTurret(
          this.graphics,
          mountX,
          mountY,
          r,
          weapon,
          palette,
          spinAngle,
          entity.id,
          gfx.turretStyle,
          gfx.forceTurretStyle,
        );
      }
    }
  }

  clearEffects(): void {
    this.debrisSystem.clear();
    this.burnMarkSystem.clear();
    this.explosions.length = 0;
    this.projectileTrails.clear();
  }

  destroy(): void {
    for (const label of this.labelPool) {
      label.destroy();
    }
    this.labelPool.length = 0;
    this.activeLabelCount = 0;
    this.beamRandomOffsets.clear();
    this.projectileTrails.clear();
    this.barrelSpins.clear();
    this.locomotion.clear();
    this.clearEffects();
    this.graphics.destroy();
  }
}
