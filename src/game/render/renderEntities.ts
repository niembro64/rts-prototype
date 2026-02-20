// Entity Renderer - Main orchestrator for rendering all game entities
// Delegates to specialized helper modules for specific rendering tasks

import Phaser from 'phaser';
import type { Entity, EntityId } from '../sim/types';
import type { SprayTarget } from '../sim/commanderAbilities';
import { BurnMarkSystem } from './BurnMarkSystem';
import { DebrisSystem } from './DebrisSystem';
import { LocomotionManager } from './LocomotionManager';
import { getGraphicsConfig, getEffectiveQuality, getRenderMode, getRangeToggle, anyRangeToggleActive, getProjRangeToggle, anyProjRangeToggleActive, getUnitRadiusToggle, anyUnitRadiusToggleActive, setCurrentZoom } from './graphicsSettings';
import { magnitude } from '../math';
import { FIRE_EXPLOSION } from '../../config';
import { getUnitBlueprint } from '../sim/blueprints';
import type { TurretConfig, SpinConfig } from '../../config';

// Import from helper modules
import type { EntitySource, ExplosionEffect, UnitRenderContext, BeamRandomOffsets, LodLevel } from './types';
import { COLORS } from './types';
import { createColorPalette } from './helpers';
import { renderExplosion, renderSprayEffect } from './effects';
import { drawTurret } from './TurretRenderer';
import { drawScoutUnit, drawBurstUnit, drawBeamUnit, drawBrawlUnit, drawMortarUnit, drawSnipeUnit, drawTankUnit, drawArachnidUnit, drawForceFieldUnit, drawCommanderUnit } from './units';
import { renderSelectedLabels, renderCommanderCrown, renderRangeCircles, renderUnitRadiusCircles, renderWaypoints, renderFactoryWaypoints } from './selection';
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

  // Scorched earth: burn marks left by beam weapons
  private burnMarkSystem = new BurnMarkSystem();

  // Death debris fragments
  private debrisSystem = new DebrisSystem();

  // Barrel spin state per entity: { angle (rad), speed (rad/sec) }
  private barrelSpins: Map<EntityId, { angle: number; speed: number }> = new Map();

  // Reusable Set for per-frame entity ID lookups (avoids allocating new Set + Array each frame)
  private _reusableIdSet: Set<EntityId> = new Set();

  // Cached range visibility objects (avoids per-frame allocation)
  private _rangeVisToggle = { see: false, fire: false, release: false, lock: false, fightstop: false, build: false };
  private _rangeVisSelected = { see: true, fire: true, release: true, lock: true, fightstop: false, build: true };
  private _projRangeVis = { collision: false, primary: false, secondary: false };
  private _unitRadiusVis = { collision: false, physics: false };

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
    const mode = getRenderMode();
    if (mode === 'all') {
      return true; // Skip culling, render everything
    }
    const camera = this.scene.cameras.main;
    const view = camera.worldView;
    // 'padded' mode: add 30% of viewport dimensions as extra margin
    const extra = mode === 'padded' ? Math.max(view.width, view.height) * 0.3 : 0;
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
      if (!entity.weapons) continue;

      // Find spin config from any weapon that has one (multibarrel or coneSpread)
      let spinConfig: SpinConfig | undefined;
      for (const w of entity.weapons) {
        const tc = w.config.turret as TurretConfig | undefined;
        if (tc && (tc.type === 'multibarrel' || tc.type === 'coneSpread')) {
          spinConfig = tc.spin;
          break;
        }
      }
      if (!spinConfig) continue;

      let state = this.barrelSpins.get(entity.id);
      if (!state) {
        state = { angle: 0, speed: 0 };
        this.barrelSpins.set(entity.id, state);
      }

      // Check if any weapon is firing
      const firing = entity.weapons.some(w => w.isFiring);

      if (firing) {
        state.speed = Math.min(state.speed + spinConfig.accel * dtSec, spinConfig.max);
      } else {
        state.speed = Math.max(state.speed - spinConfig.decel * dtSec, spinConfig.idle);
      }

      state.angle += state.speed * dtSec;
    }
  }

  private getBarrelSpinAngle(entityId: EntityId): number {
    return this.barrelSpins.get(entityId)?.angle ?? 0;
  }

  // ==================== EXPLOSION MANAGEMENT ====================

  addExplosion(
    x: number, y: number, radius: number, color: number, type: 'impact' | 'death',
    velocityX?: number, velocityY?: number,
    penetrationX?: number, penetrationY?: number,
    attackerX?: number, attackerY?: number,
    collisionRadius?: number, primaryRadius?: number, secondaryRadius?: number,
    entityCollisionRadius?: number,
  ): void {
    const baseRadius = 8;
    const baseLifetime = type === 'death' ? 600 : FIRE_EXPLOSION.baseLifetimeMs;
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
      collisionRadius, primaryRadius, secondaryRadius,
      entityCollisionRadius,
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

  // ==================== LOD COMPUTATION ====================

  private computeUnitLod(radius: number): LodLevel {
    const screenRadius = radius * this.cameraZoom;
    if (screenRadius < 2) return 'min'; // sub-pixel
    const quality = getEffectiveQuality();
    const zoomLod: LodLevel = screenRadius < 6 ? 'min' : screenRadius < 12 ? 'low' : 'high';
    return quality === 'min' ? 'min' : quality === 'low' ? (zoomLod === 'high' ? 'low' : zoomLod) : zoomLod;
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

    // 4. Unit bodies (chassis only — no turrets)
    for (const entity of this.visibleUnits) {
      this.renderUnitBody(entity);
    }

    // 5. Turrets (weapon-driven, rendered at mount points)
    for (const entity of this.visibleUnits) {
      this.renderUnitTurrets(entity);
    }

    // 6. Projectiles (clean up stale beam offsets inline, cap LOD by quality)
    const projQuality = getEffectiveQuality();
    const zoomProjLod: LodLevel = this.cameraZoom < 0.3 ? 'min' : this.cameraZoom < 0.8 ? 'low' : 'high';
    const projectileLod: LodLevel = projQuality === 'min' ? 'min' : projQuality === 'low' ? (zoomProjLod === 'high' ? 'low' : zoomProjLod) : zoomProjLod;
    this._reusableIdSet.clear();
    for (const entity of this.visibleProjectiles) {
      this._reusableIdSet.add(entity.id);
      renderProjectile(this.graphics, entity, this.beamRandomOffsets, projectileLod, this.sprayParticleTime);
    }
    for (const id of this.beamRandomOffsets.keys()) {
      if (!this._reusableIdSet.has(id)) this.beamRandomOffsets.delete(id);
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
      this._unitRadiusVis.collision = getUnitRadiusToggle('collision');
      this._unitRadiusVis.physics = getUnitRadiusToggle('physics');
      for (const entity of this.visibleUnits) {
        renderUnitRadiusCircles(this.graphics, entity, this._unitRadiusVis);
      }
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

  // ==================== UNIT BODY RENDERING ====================

  private renderUnitBody(entity: Entity): void {
    if (!entity.unit) return;

    const { transform, unit, selectable, ownership } = entity;
    const { x, y, rotation } = transform;
    const { collisionRadius: radius, hp, maxHp } = unit;
    const isSelected = selectable?.selected ?? false;

    const lod = this.computeUnitLod(radius);
    if (lod === 'min' && radius * this.cameraZoom < 2) return; // sub-pixel skip

    // Get unit type for renderer selection
    const unitType = unit.unitType ?? 'jackal';
    const fullPalette = createColorPalette(ownership?.playerId);
    // At low/min: use only the base player color, no light/dark variants
    const palette = (lod === 'min' || lod === 'low')
      ? { base: fullPalette.base, light: fullPalette.base, dark: fullPalette.base }
      : fullPalette;

    // 'min': colored dot — skip body shape rendering
    if (lod === 'min') {
      this.graphics.fillStyle(palette.base, 1);
      this.graphics.fillCircle(x, y, radius);
      if (isSelected) {
        this.graphics.lineStyle(3, COLORS.UNIT_SELECTED, 1);
        this.graphics.strokeCircle(x, y, radius + 5);
      }
      if (entity.commander) {
        renderCommanderCrown(this.graphics, x, y, radius);
      }
      const healthPercent = hp / maxHp;
      if (healthPercent < 1) {
        renderHealthBar(this.graphics, x, y - radius - 10, radius * 2, 4, healthPercent);
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
      x, y, radius, bodyRot: rotation, palette, isSelected, entity,
      lod,
    };

    // Blueprint-driven renderer dispatch
    let bp;
    try { bp = getUnitBlueprint(unitType); } catch { bp = null; }
    const renderer = bp?.renderer ?? 'scout';

    switch (renderer) {
      case 'commander': drawCommanderUnit(ctx, this.locomotion.getOrCreateLegs(entity, unitType)); break;
      case 'scout': drawScoutUnit(ctx, this.locomotion.getVehicleWheels(entity.id)); break;
      case 'burst': drawBurstUnit(ctx, this.locomotion.getTankTreads(entity.id)); break;
      case 'forceField': drawForceFieldUnit(ctx, this.locomotion.getOrCreateLegs(entity, unitType)); break;
      case 'brawl': drawBrawlUnit(ctx, this.locomotion.getTankTreads(entity.id)); break;
      case 'mortar': drawMortarUnit(ctx, this.locomotion.getVehicleWheels(entity.id)); break;
      case 'snipe': drawSnipeUnit(ctx, this.locomotion.getOrCreateLegs(entity, unitType)); break;
      case 'tank': drawTankUnit(ctx, this.locomotion.getTankTreads(entity.id)); break;
      case 'arachnid': drawArachnidUnit(ctx, this.locomotion.getOrCreateLegs(entity, unitType)); break;
      case 'beam': drawBeamUnit(ctx, this.locomotion.getOrCreateLegs(entity, unitType)); break;
      default: drawScoutUnit(ctx, this.locomotion.getVehicleWheels(entity.id));
    }

    // Post-body overlays
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

  // ==================== TURRET RENDERING (WEAPON-DRIVEN) ====================

  private renderUnitTurrets(entity: Entity): void {
    if (!entity.unit || !entity.weapons || entity.weapons.length === 0) return;

    const { transform, unit, ownership } = entity;
    const { x, y, rotation: bodyRot } = transform;
    const r = unit.collisionRadius;

    const lod = this.computeUnitLod(r);
    if (lod === 'min' && r * this.cameraZoom < 2) return; // sub-pixel skip

    const unitType = entity.commander ? 'commander' : (unit.unitType ?? 'jackal');
    let mounts: { x: number; y: number }[];
    try { mounts = getUnitBlueprint(unitType).chassisMounts; } catch { mounts = [{ x: 0, y: 0 }]; }

    const fullPalette = createColorPalette(ownership?.playerId);
    const palette = (lod === 'min' || lod === 'low')
      ? { base: fullPalette.base, light: fullPalette.base, dark: fullPalette.base }
      : fullPalette;

    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);
    const spinAngle = lod === 'low' ? 0 : this.getBarrelSpinAngle(entity.id);

    for (let i = 0; i < entity.weapons.length; i++) {
      const weapon = entity.weapons[i];
      const mount = mounts[Math.min(i, mounts.length - 1)];
      const mountX = x + cos * mount.x * r - sin * mount.y * r;
      const mountY = y + sin * mount.x * r + cos * mount.y * r;

      drawTurret(this.graphics, mountX, mountY, r, weapon, lod, palette, spinAngle, entity.id);
    }
  }

  clearEffects(): void {
    this.debrisSystem.clear();
    this.burnMarkSystem.clear();
    this.explosions.length = 0;
  }

  destroy(): void {
    for (const label of this.labelPool) {
      label.destroy();
    }
    this.labelPool.length = 0;
    this.activeLabelCount = 0;
    this.beamRandomOffsets.clear();
    this.barrelSpins.clear();
    this.locomotion.clear();
    this.clearEffects();
    this.graphics.destroy();
  }
}
