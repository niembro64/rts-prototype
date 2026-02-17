// Entity Renderer - Main orchestrator for rendering all game entities
// Delegates to specialized helper modules for specific rendering tasks

import Phaser from 'phaser';
import type { Entity, EntityId } from '../sim/types';
import type { SprayTarget } from '../sim/commanderAbilities';
import { BurnMarkSystem } from './BurnMarkSystem';
import { DebrisSystem } from './DebrisSystem';
import { LocomotionManager } from './LocomotionManager';
import { getGraphicsConfig, getRenderMode, getRangeToggle, anyRangeToggleActive, setCurrentZoom } from './graphicsSettings';
import { magnitude } from '../math';

// Import from helper modules
import type { EntitySource, ExplosionEffect, UnitRenderContext, BeamRandomOffsets } from './types';
import { COLORS } from './types';
import { createColorPalette } from './helpers';
import { renderExplosion, renderSprayEffect } from './effects';
import { drawScoutUnit, drawBurstUnit, drawBeamUnit, drawBrawlUnit, drawMortarUnit, drawSnipeUnit, drawTankUnit, drawArachnidUnit, drawForceFieldUnit, drawCommanderUnit } from './units';
import { renderSelectedLabels, renderCommanderCrown, renderRangeCircles, renderWaypoints, renderFactoryWaypoints } from './selection';
import { renderBuilding } from './BuildingRenderer';
import { renderProjectile } from './ProjectileRenderer';
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

  // Scorched earth: burn marks left by beam weapons
  private burnMarkSystem = new BurnMarkSystem();

  // Death debris fragments
  private debrisSystem = new DebrisSystem();

  // Reusable Set for per-frame entity ID lookups (avoids allocating new Set + Array each frame)
  private _reusableIdSet: Set<EntityId> = new Set();

  // Cached range visibility objects (avoids per-frame allocation)
  private _rangeVisToggle = { see: false, fire: false, release: false, lock: false, fightstop: false, build: false };
  private _rangeVisSelected = { see: true, fire: true, release: true, lock: true, fightstop: false, build: true };
  // Rendering mode flags
  private skipTurrets: boolean = false;
  private turretsOnly: boolean = false;

  // Cached camera zoom for LOD calculations (updated each frame)
  private cameraZoom: number = 1;

  constructor(scene: Phaser.Scene, entitySource: EntitySource) {
    this.scene = scene;
    this.graphics = scene.add.graphics();
    this.entitySource = entitySource;
  }

  /**
   * Check if a point is visible within the camera viewport (with padding)
   */
  private isInViewport(x: number, y: number, padding: number = 100): boolean {
    if (getRenderMode() === 'all') {
      return true; // Skip culling, render everything
    }
    const camera = this.scene.cameras.main;
    const view = camera.worldView;
    return (
      x >= view.x - padding &&
      x <= view.right + padding &&
      y >= view.y - padding &&
      y <= view.bottom + padding
    );
  }

  // ==================== LOCOMOTION DELEGATION ====================

  updateLocomotion(dtMs: number): void {
    this.locomotion.updateLocomotion(this.entitySource, dtMs);
  }

  // ==================== EXPLOSION MANAGEMENT ====================

  addExplosion(
    x: number, y: number, radius: number, color: number, type: 'impact' | 'death',
    velocityX?: number, velocityY?: number,
    penetrationX?: number, penetrationY?: number,
    attackerX?: number, attackerY?: number
  ): void {
    const baseRadius = 8;
    const baseLifetime = type === 'death' ? 600 : 150;
    const radiusScale = Math.sqrt(radius / baseRadius);
    const lifetime = baseLifetime * radiusScale;

    const velocityMag = (velocityX !== undefined && velocityY !== undefined) ? magnitude(velocityX, velocityY) : 0;
    const penetrationMag = (penetrationX !== undefined && penetrationY !== undefined) ? magnitude(penetrationX, penetrationY) : 0;
    const attackerMag = (attackerX !== undefined && attackerY !== undefined) ? magnitude(attackerX, attackerY) : 0;

    const combinedX = (velocityX ?? 0) + (penetrationX ?? 0) + (attackerX ?? 0);
    const combinedY = (velocityY ?? 0) + (penetrationY ?? 0) + (attackerY ?? 0);
    const combinedMag = magnitude(combinedX, combinedY);

    this.explosions.push({
      x, y, radius, color, lifetime, elapsed: 0, type,
      velocityX, velocityY, velocityMag,
      penetrationX, penetrationY, penetrationMag,
      attackerX, attackerY, attackerMag,
      combinedX, combinedY, combinedMag,
    });
  }

  /**
   * Add debris fragments for a destroyed unit.
   * Generates pieces from a per-unit-type template, applies random velocities with hit-direction bias.
   */
  addDebris(
    x: number, y: number,
    unitType: string, rotation: number,
    radius: number, color: number,
    hitDirX: number, hitDirY: number
  ): void {
    this.debrisSystem.addDebris(x, y, unitType, rotation, radius, color, hitDirX, hitDirY);
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
      if (!this.isInViewport(entity.transform.x, entity.transform.y, 100)) continue;
      this.visibleUnits.push(entity);
      if (entity.selectable?.selected) this.selectedUnits.push(entity);
    }

    for (const entity of this.entitySource.getBuildings()) {
      if (!entity.building || entity.building.hp <= 0) continue;
      if (!this.isInViewport(entity.transform.x, entity.transform.y, 150)) continue;
      this.visibleBuildings.push(entity);
      if (entity.selectable?.selected && entity.factory) this.selectedFactories.push(entity);
    }

    for (const entity of this.entitySource.getProjectiles()) {
      if (!this.isInViewport(entity.transform.x, entity.transform.y, 50)) continue;
      this.visibleProjectiles.push(entity);
    }
  }

  // ==================== MAIN RENDER ====================

  render(): void {
    this.graphics.clear();
    this.resetLabels();

    const camera = this.scene.cameras.main;
    this.cameraZoom = camera.zoom;
    setCurrentZoom(camera.zoom);
    const gfxConfig = getGraphicsConfig();
    this.sprayParticleTime += 16;
    this.collectVisibleEntities();

    // 0. Sample beam endpoints for scorched earth burn marks
    this.burnMarkSystem.sampleBeamEndpoints(this.entitySource.getProjectiles(), gfxConfig.burnMarkFramesSkip);

    // 0b. Render scorched earth burn marks (below everything, fully opaque)
    this.burnMarkSystem.render(this.graphics, (x, y, padding) => this.isInViewport(x, y, padding));

    // 0c. Death debris fragments
    this.debrisSystem.render(this.graphics, (x, y, p) => this.isInViewport(x, y, p));

    // 1. Buildings (bottom layer)
    const buildBarFn = (x: number, y: number, w: number, h: number, p: number) => renderBuildBar(this.graphics, x, y, w, h, p);
    const healthBarFn = (x: number, y: number, w: number, h: number, p: number) => renderHealthBar(this.graphics, x, y, w, h, p);
    for (const entity of this.visibleBuildings) {
      renderBuilding(this.graphics, entity, this.sprayParticleTime, buildBarFn, healthBarFn);
    }

    // 2. Waypoints for selected units
    for (const entity of this.selectedUnits) {
      renderWaypoints(this.graphics, entity, camera);
    }
    for (const entity of this.selectedFactories) {
      renderFactoryWaypoints(this.graphics, entity, camera);
    }

    // 3. Range circles (reuse cached visibility objects to avoid per-frame allocation)
    const showAllRanges = anyRangeToggleActive();
    if (showAllRanges) {
      this._rangeVisToggle.see = getRangeToggle('see');
      this._rangeVisToggle.fire = getRangeToggle('fire');
      this._rangeVisToggle.release = getRangeToggle('release');
      this._rangeVisToggle.lock = getRangeToggle('lock');
      this._rangeVisToggle.fightstop = getRangeToggle('fightstop');
      this._rangeVisToggle.build = getRangeToggle('build');
    }
    const rangeVis = showAllRanges ? this._rangeVisToggle : this._rangeVisSelected;
    const rangeUnits = showAllRanges ? this.visibleUnits : this.selectedUnits;
    for (const entity of rangeUnits) {
      renderRangeCircles(this.graphics, entity, rangeVis);
    }

    // 4. Unit bodies
    this.skipTurrets = true;
    this.turretsOnly = false;
    for (const entity of this.visibleUnits) {
      this.renderUnit(entity);
    }

    // 5. Turrets
    this.skipTurrets = false;
    this.turretsOnly = true;
    for (const entity of this.visibleUnits) {
      this.renderUnit(entity);
    }
    this.turretsOnly = false;

    // 6. Projectiles (clean up stale beam offsets inline)
    this._reusableIdSet.clear();
    for (const entity of this.visibleProjectiles) {
      this._reusableIdSet.add(entity.id);
      renderProjectile(this.graphics, entity, this.beamRandomOffsets, this.cameraZoom, this.sprayParticleTime);
    }
    for (const id of this.beamRandomOffsets.keys()) {
      if (!this._reusableIdSet.has(id)) this.beamRandomOffsets.delete(id);
    }

    // 7. Spray effects
    for (const target of this.sprayTargets) {
      if (!this.isInViewport(target.targetX, target.targetY, 50)) continue;
      renderSprayEffect(this.graphics, target, this.sprayParticleTime);
    }

    // 8. Explosions (quality determined by zoom-based graphics config)
    for (const explosion of this.explosions) {
      if (!this.isInViewport(explosion.x, explosion.y, explosion.radius + 50)) continue;
      renderExplosion(this.graphics, explosion);
    }

    // 9. Labels (topmost)
    renderSelectedLabels(this.graphics, this.entitySource, () => this.getLabel());
  }

  // ==================== UNIT RENDERING ====================

  private renderUnit(entity: Entity): void {
    if (!entity.unit) return;

    const { transform, unit, selectable, ownership } = entity;
    const { x, y, rotation } = transform;
    const { collisionRadius: radius, hp, maxHp } = unit;
    const isSelected = selectable?.selected ?? false;

    // LOD: compute screen-space radius for detail level
    // Tier 0: skip entirely (sub-pixel), Tier 1: legs/treads visible but no inner detail,
    // Tier 2: body detail but no tread tracks or leg joints, Tier 3: full detail
    const screenRadius = radius * this.cameraZoom;
    const lodTier = screenRadius < 2 ? 0 : screenRadius < 6 ? 1 : screenRadius < 12 ? 2 : 3;

    // LOD 0: unit is sub-pixel, skip entirely
    if (lodTier === 0) return;

    // Get unit type for renderer selection
    const unitType = unit.unitType ?? 'jackal';
    const palette = createColorPalette(ownership?.playerId);

    // Selection ring
    if (isSelected && !this.turretsOnly) {
      this.graphics.lineStyle(3, COLORS.UNIT_SELECTED, 1);
      this.graphics.strokeCircle(x, y, radius + 5);
    }

    const ctx: UnitRenderContext = {
      graphics: this.graphics,
      x, y, radius, bodyRot: rotation, palette, isSelected, entity,
      skipTurrets: this.skipTurrets, turretsOnly: this.turretsOnly,
      lodTier,
    };

    // Commander gets special 4-legged mech body regardless of unit type
    if (entity.commander) {
      drawCommanderUnit(ctx, this.locomotion.getOrCreateLegs(entity, 'commander'));
    } else {
      // Select renderer based on unit type
      switch (unitType) {
        case 'jackal': drawScoutUnit(ctx, this.locomotion.getVehicleWheels(entity.id)); break;
        case 'lynx': drawBurstUnit(ctx, this.locomotion.getVehicleWheels(entity.id)); break;
        case 'daddy': drawBeamUnit(ctx, this.locomotion.getOrCreateLegs(entity, 'daddy')); break;
        case 'badger': drawBrawlUnit(ctx, this.locomotion.getTankTreads(entity.id)); break;
        case 'scorpion': drawMortarUnit(ctx, this.locomotion.getVehicleWheels(entity.id)); break;
        case 'viper': drawSnipeUnit(ctx, this.locomotion.getVehicleWheels(entity.id)); break;
        case 'mammoth': drawTankUnit(ctx, this.locomotion.getTankTreads(entity.id)); break;
        case 'widow': drawArachnidUnit(ctx, this.locomotion.getOrCreateLegs(entity, 'widow')); break;
        case 'tarantula': drawForceFieldUnit(ctx, this.locomotion.getOrCreateLegs(entity, 'tarantula')); break;
        default: drawScoutUnit(ctx, this.locomotion.getVehicleWheels(entity.id));
      }
    }

    if (!this.turretsOnly) {
      if (entity.commander) {
        renderCommanderCrown(this.graphics, x, y, radius);
      }

      const healthPercent = hp / maxHp;
      if (healthPercent < 1) {
        renderHealthBar(this.graphics, x, y - radius - 10, radius * 2, 4, healthPercent);
      }

      if (entity.weapons && isSelected) {
        for (const weapon of entity.weapons) {
          if (weapon.targetEntityId != null) {
            const target = this.entitySource.getEntity(weapon.targetEntityId);
            if (target) {
              this.graphics.lineStyle(1, 0xff0000, 0.3);
              this.graphics.lineBetween(x, y, target.transform.x, target.transform.y);
            }
          }
        }
      }
    }
  }

  clearEffects(): void {
    this.debrisSystem.clear();
    this.burnMarkSystem.clear();
    this.explosions.length = 0;
  }

  destroy(): void {
    this.graphics.destroy();
  }
}
