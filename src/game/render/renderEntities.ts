// Entity Renderer - Main orchestrator for rendering all game entities
// Delegates to specialized helper modules for specific rendering tasks

import Phaser from 'phaser';
import type { Entity, EntityId } from '../sim/types';
import type { SprayTarget } from '../sim/commanderAbilities';
import { BURN_COLOR_TAU, BURN_COOL_TAU, BURN_COLOR_HOT, BURN_COLOR_COOL, hexToRgb, DEBRIS_CONFIG } from '../../config';
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
import { getGraphicsConfig, getRenderMode, getRangeToggle, anyRangeToggleActive, setCurrentZoom } from './graphicsSettings';
import { magnitude } from '../math';

// Import from helper modules
import type { EntitySource, ExplosionEffect, UnitRenderContext, BuildingRenderContext, BeamRandomOffsets } from './types';
import { COLORS, LEG_STYLE_CONFIG } from './types';
import { getPlayerColor, getProjectileColor, createColorPalette } from './helpers';
import { renderExplosion, renderSprayEffect } from './effects';
import { drawScoutUnit, drawBurstUnit, drawBeamUnit, drawBrawlUnit, drawMortarUnit, drawSnipeUnit, drawTankUnit, drawArachnidUnit, drawForceFieldUnit, drawCommanderUnit } from './units';
import { renderFactory, renderSolarPanel } from './buildings';
import { renderSelectedLabels, renderCommanderCrown, renderRangeCircles, renderWaypoints, renderFactoryWaypoints } from './selection';

// Re-export EntitySource for external use
export type { EntitySource, ExplosionEffect };

// Scorched earth burn mark left by beam weapons — line segments matching beam width
interface BurnMark {
  x1: number; y1: number; // segment start
  x2: number; y2: number; // segment end
  width: number;           // beam width
  age: number;             // ms since creation
  color: number;           // cached RGB color (updated during aging)
}
const BURN_HOT_RGB = hexToRgb(BURN_COLOR_HOT);
const BURN_COOL_RGB = hexToRgb(BURN_COLOR_COOL);
const MAX_BURN_MARKS = 5000;

// Death debris fragment — line segment with physics, color decay like burn marks
interface DebrisFragment {
  x: number; y: number;         // current center position
  vx: number; vy: number;       // velocity (pixels/sec)
  rotation: number;              // current angle of the segment
  angularVel: number;            // rotation speed (rad/sec)
  length: number;                // segment length
  width: number;                 // line width
  color: number;                 // cached RGB (updated during aging)
  baseColor: number;             // original color at creation
  age: number;                   // ms since creation
}
const MAX_DEBRIS = DEBRIS_CONFIG.maxFragments;
const DEBRIS_DRAG = DEBRIS_CONFIG.drag;

// Per-unit-type debris piece template (local coordinates relative to unit center)
interface DebrisPieceTemplate {
  localX: number;
  localY: number;
  length: number;
  width: number;
  angle: number;       // local angle offset
  colorType: 'base' | 'dark' | 'light' | 'gray' | 'white';
}

// Cached debris templates per unit type
const debrisTemplateCache: Map<string, DebrisPieceTemplate[]> = new Map();

function getDebrisTemplateKey(unitType: string, radius: number): string {
  return `${unitType}:${Math.round(radius)}`;
}

/**
 * Generate debris piece templates for a unit type.
 * These are in local coordinates (relative to unit center, unrotated).
 */
function getDebrisPieces(unitType: string, radius: number): DebrisPieceTemplate[] {
  const key = getDebrisTemplateKey(unitType, radius);
  const cached = debrisTemplateCache.get(key);
  if (cached) return cached;

  const r = radius;
  const pieces: DebrisPieceTemplate[] = [];

  // Helper: add polygon edges as debris
  const addPolygonEdges = (cx: number, cy: number, polyR: number, sides: number, rot: number, width: number, color: DebrisPieceTemplate['colorType']) => {
    for (let i = 0; i < sides; i++) {
      const a1 = rot + (i / sides) * Math.PI * 2;
      const a2 = rot + ((i + 1) / sides) * Math.PI * 2;
      const x1 = cx + Math.cos(a1) * polyR;
      const y1 = cy + Math.sin(a1) * polyR;
      const x2 = cx + Math.cos(a2) * polyR;
      const y2 = cy + Math.sin(a2) * polyR;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      pieces.push({ localX: mx, localY: my, length: Math.sqrt(dx * dx + dy * dy), width, angle: Math.atan2(dy, dx), colorType: color });
    }
  };

  // Helper: add a barrel/line segment
  const addBarrel = (ox: number, oy: number, len: number, width: number, angle: number, color: DebrisPieceTemplate['colorType']) => {
    const mx = ox + Math.cos(angle) * len / 2;
    const my = oy + Math.sin(angle) * len / 2;
    pieces.push({ localX: mx, localY: my, length: len, width, angle, colorType: color });
  };

  switch (unitType) {
    case 'widow':
    case 'tarantula': {
      // 8 legs: upper + lower segments
      const legLen = r * 1.9;
      const upperLen = legLen * 0.55;
      const lowerLen = legLen * 0.55;
      const legW = 2.5;
      // 4 left + 4 right attachment points (simplified radial)
      for (let i = 0; i < 8; i++) {
        const side = i < 4 ? -1 : 1;
        const idx = i < 4 ? i : i - 4;
        const attachAngle = (idx / 4 - 0.5) * Math.PI * 0.8 + Math.PI / 2 * side;
        const ax = Math.cos(attachAngle) * r * 0.4;
        const ay = Math.sin(attachAngle) * r * 0.4;
        // Upper leg
        pieces.push({ localX: ax, localY: ay, length: upperLen, width: legW + 1, angle: attachAngle, colorType: 'dark' });
        // Lower leg
        const kx = ax + Math.cos(attachAngle) * upperLen;
        const ky = ay + Math.sin(attachAngle) * upperLen;
        pieces.push({ localX: kx, localY: ky, length: lowerLen, width: legW, angle: attachAngle, colorType: 'dark' });
      }
      // Body hexagon edges
      addPolygonEdges(r * 0.35, 0, r * 0.95, 6, Math.PI / 6, 3, 'dark');
      // Turret barrels (6 emitters)
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3 + Math.PI / 6;
        const ex = Math.cos(a) * r * 0.65 + r * 0.5;
        const ey = Math.sin(a) * r * 0.65;
        addBarrel(ex, ey, r * 0.5, 2, a, 'white');
      }
      break;
    }

    case 'daddy': {
      // 8 long legs
      const legLen = r * 10;
      const upperLen = legLen * 0.3;
      const lowerLen = legLen * 0.6;
      const legW = 3;
      for (let i = 0; i < 8; i++) {
        const side = i < 4 ? -1 : 1;
        const idx = i < 4 ? i : i - 4;
        const attachAngle = (idx / 4 - 0.5) * Math.PI * 0.8 + Math.PI / 2 * side;
        const ax = Math.cos(attachAngle) * r * 0.4;
        const ay = Math.sin(attachAngle) * r * 0.4;
        pieces.push({ localX: ax, localY: ay, length: upperLen, width: legW + 1, angle: attachAngle, colorType: 'dark' });
        const kx = ax + Math.cos(attachAngle) * upperLen;
        const ky = ay + Math.sin(attachAngle) * upperLen;
        pieces.push({ localX: kx, localY: ky, length: lowerLen, width: legW, angle: attachAngle, colorType: 'dark' });
      }
      // Body polygon
      addPolygonEdges(0, 0, r * 0.7, 6, 0, 3, 'base');
      // Central beam barrel
      addBarrel(0, 0, r * 1.2, 4, 0, 'white');
      break;
    }

    case 'commander': {
      // 4 legs (2 per side)
      const legLen = r * 2.2;
      const upperLen = legLen * 0.5;
      const lowerLen = legLen * 0.5;
      const legW = 3;
      for (let i = 0; i < 4; i++) {
        const side = i < 2 ? -1 : 1;
        const idx = i < 2 ? i : i - 2;
        const attachAngle = (idx === 0 ? 0.3 : -0.3) * Math.PI + Math.PI / 2 * side;
        const ax = Math.cos(attachAngle) * r * 0.5;
        const ay = Math.sin(attachAngle) * r * 0.5;
        pieces.push({ localX: ax, localY: ay, length: upperLen, width: legW + 1, angle: attachAngle, colorType: 'dark' });
        const kx = ax + Math.cos(attachAngle) * upperLen;
        const ky = ay + Math.sin(attachAngle) * upperLen;
        pieces.push({ localX: kx, localY: ky, length: lowerLen, width: legW, angle: attachAngle, colorType: 'dark' });
      }
      // Body polygon
      addPolygonEdges(0, 0, r * 0.8, 6, 0, 3, 'base');
      // DGun barrel
      addBarrel(0, 0, r * 1.5, 5, 0, 'white');
      break;
    }

    case 'mammoth': {
      // 2 treads split into segments
      const treadLen = r * 2.0;
      const treadOffset = r * 0.9;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const segLen = treadLen / 3;
          const sx = (i - 1) * segLen;
          pieces.push({ localX: sx, localY: treadOffset * side, length: segLen, width: r * 0.5, angle: 0, colorType: 'gray' });
        }
      }
      // Hull square edges
      addPolygonEdges(0, 0, r * 0.85, 4, 0, 3, 'base');
      // Heavy cannon barrel
      addBarrel(0, 0, r * 1.4, 7, 0, 'white');
      break;
    }

    case 'badger': {
      // 2 treads
      const treadLen = r * 1.7;
      const treadOffset = r * 0.85;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 2; i++) {
          const segLen = treadLen / 2;
          const sx = (i - 0.5) * segLen;
          pieces.push({ localX: sx, localY: treadOffset * side, length: segLen, width: r * 0.4, angle: 0, colorType: 'gray' });
        }
      }
      // Body pentagon edges
      addPolygonEdges(0, 0, r * 0.8, 5, 0, 3, 'dark');
      // Shotgun barrel
      addBarrel(0, 0, r * 1.0, 5, 0, 'white');
      break;
    }

    case 'jackal':
    case 'lynx':
    case 'scorpion':
    case 'viper': {
      // 4 small wheel rectangles
      const wheelDistX = r * 0.6;
      const wheelDistY = r * 0.7;
      const wheelLen = r * 0.5;
      const wheelW = r * 0.11;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          pieces.push({ localX: wheelDistX * sx, localY: wheelDistY * sy, length: wheelLen, width: wheelW, angle: 0, colorType: 'gray' });
        }
      }
      // Diamond body edges (4 sides)
      addPolygonEdges(0, 0, r * 0.55, 4, Math.PI / 4, 2, 'light');
      // Inner accent
      addPolygonEdges(0, 0, r * 0.35, 4, Math.PI / 4, 1.5, 'base');
      // Turret barrel(s)
      if (unitType === 'jackal') {
        // Triple barrels
        for (let i = -1; i <= 1; i++) {
          addBarrel(0, i * 2, r * 1.0, 1.5, 0, 'white');
        }
      } else if (unitType === 'viper') {
        addBarrel(0, 0, r * 1.2, 2, 0, 'white');
      } else if (unitType === 'lynx') {
        addBarrel(0, -2, r * 0.8, 2, 0, 'white');
        addBarrel(0, 2, r * 0.8, 2, 0, 'white');
      } else {
        // scorpion
        addBarrel(0, 0, r * 0.8, 3, 0, 'white');
      }
      break;
    }

    default: {
      // Generic fallback: hexagon body + barrel
      addPolygonEdges(0, 0, r * 0.6, 6, 0, 2, 'base');
      addBarrel(0, 0, r * 1.0, 2, 0, 'white');
      break;
    }
  }

  debrisTemplateCache.set(key, pieces);
  return pieces;
}

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

  // Arachnid legs storage (entity ID -> array of legs)
  private arachnidLegs: Map<EntityId, ArachnidLeg[]> = new Map();

  // Tank treads storage (entity ID -> left/right tread pair)
  private tankTreads: Map<EntityId, TankTreadSetup> = new Map();

  // Vehicle wheels storage (entity ID -> wheel array)
  private vehicleWheels: Map<EntityId, VehicleWheelSetup> = new Map();

  // Per-projectile random offsets for visual variety
  private beamRandomOffsets: Map<EntityId, BeamRandomOffsets> = new Map();

  // Scorched earth: burn marks left by beam weapons
  private burnMarks: BurnMark[] = [];
  // Keyed by "sourceEntityId:weaponIndex" so endpoint tracking survives beam entity ID changes
  private prevBeamEndpoints: Map<string, { x: number; y: number }> = new Map();
  private burnMarkFrameCounter: number = 0;

  // Death debris fragments
  private debrisFragments: DebrisFragment[] = [];

  // Reusable Set for per-frame entity ID lookups (avoids allocating new Set + Array each frame)
  private _reusableIdSet: Set<EntityId> = new Set();

  // Cached range visibility objects (avoids per-frame allocation)
  private _rangeVisToggle = { see: false, fire: false, release: false, lock: false, fightstop: false, build: false };
  private _rangeVisSelected = { see: true, fire: true, release: true, lock: true, fightstop: false, build: true };
  private _activeBeamKeys: Set<string> = new Set();

  // Rendering mode flags
  private skipTurrets: boolean = false;
  private turretsOnly: boolean = false;

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

  // ==================== LEG MANAGEMENT ====================

  private getOrCreateLegs(
    entity: Entity,
    legStyle: 'widow' | 'daddy' | 'tarantula' | 'commander' = 'widow'
  ): ArachnidLeg[] {
    const existing = this.arachnidLegs.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 40;
    let leftSideConfigs: LegConfig[];

    if (legStyle === 'daddy') {
      const legLength = radius * 10;
      const upperLen = legLength * 0.3;
      const lowerLen = legLength * 0.6;

      leftSideConfigs = [
        { attachOffsetX: radius * 0.3, attachOffsetY: -radius * 0.4, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.3, snapTargetAngle: -Math.PI * 0.2, snapDistanceMultiplier: 0.9, extensionThreshold: 0.82 },
        { attachOffsetX: radius * 0.1, attachOffsetY: -radius * 0.4, upperLegLength: upperLen * 0.95, lowerLegLength: lowerLen * 0.95, snapTriggerAngle: Math.PI * 0.55, snapTargetAngle: -Math.PI * 0.25, snapDistanceMultiplier: 0.9, extensionThreshold: 0.84 },
        { attachOffsetX: -radius * 0.1, attachOffsetY: -radius * 0.4, upperLegLength: upperLen * 0.95, lowerLegLength: lowerLen * 0.95, snapTriggerAngle: Math.PI * 0.85, snapTargetAngle: -Math.PI * 0.45, snapDistanceMultiplier: 0.85, extensionThreshold: 0.9 },
        { attachOffsetX: -radius * 0.3, attachOffsetY: -radius * 0.3, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.65, snapDistanceMultiplier: 0.55, extensionThreshold: 0.99 },
      ];
    } else if (legStyle === 'tarantula') {
      const legLength = radius * 1.9;
      const upperLen = legLength * 0.55;
      const lowerLen = legLength * 0.55;

      leftSideConfigs = [
        { attachOffsetX: radius * 0.3, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.4, snapTargetAngle: -Math.PI * 0.15, snapDistanceMultiplier: 0.99, extensionThreshold: 0.99 },
        { attachOffsetX: radius * 0.1, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.55, snapTargetAngle: -Math.PI * 0.25, snapDistanceMultiplier: 0.92, extensionThreshold: 0.99 },
        { attachOffsetX: -radius * 0.1, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.8, snapTargetAngle: -Math.PI * 0.35, snapDistanceMultiplier: 0.8, extensionThreshold: 0.99 },
        { attachOffsetX: -radius * 0.3, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.5, snapDistanceMultiplier: 0.6, extensionThreshold: 0.99 },
      ];
    } else if (legStyle === 'commander') {
      // Commander has 4 sturdy legs - 2 front, 2 back
      const legLength = radius * 2.2;
      const upperLen = legLength * 0.5;
      const lowerLen = legLength * 0.5;

      leftSideConfigs = [
        // Front leg - forward facing
        { attachOffsetX: radius * 0.4, attachOffsetY: -radius * 0.5, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.45, snapTargetAngle: -Math.PI * 0.15, snapDistanceMultiplier: 0.95, extensionThreshold: 0.9 },
        // Back leg - rear facing
        { attachOffsetX: -radius * 0.4, attachOffsetY: -radius * 0.5, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.85, snapTargetAngle: -Math.PI * 0.55, snapDistanceMultiplier: 0.7, extensionThreshold: 0.95 },
      ];
    } else {
      // Widow: 4 legs per side, tuned to match daddy/tarantula snap behavior
      const legLength = radius * 1.9;
      const upperLen = legLength * 0.55;
      const lowerLen = legLength * 0.55;

      leftSideConfigs = [
        { attachOffsetX: radius * 0.4, attachOffsetY: -radius * 0.4, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.35, snapTargetAngle: -Math.PI * 0.15, snapDistanceMultiplier: 0.95, extensionThreshold: 0.85 },
        { attachOffsetX: radius * 0.15, attachOffsetY: -radius * 0.45, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.55, snapTargetAngle: -Math.PI * 0.28, snapDistanceMultiplier: 0.88, extensionThreshold: 0.88 },
        { attachOffsetX: -radius * 0.15, attachOffsetY: -radius * 0.45, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.8, snapTargetAngle: -Math.PI * 0.42, snapDistanceMultiplier: 0.78, extensionThreshold: 0.92 },
        { attachOffsetX: -radius * 0.4, attachOffsetY: -radius * 0.4, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.6, snapDistanceMultiplier: 0.55, extensionThreshold: 0.99 },
      ];
    }

    const styleConfig = LEG_STYLE_CONFIG[legStyle];
    const lerpSpeed = styleConfig.lerpSpeed;
    const leftWithLerp = leftSideConfigs.map((leg) => ({ ...leg, lerpSpeed }));
    const rightSideConfigs: LegConfig[] = leftWithLerp.map((leg) => ({
      ...leg,
      attachOffsetY: -leg.attachOffsetY,
      snapTargetAngle: -leg.snapTargetAngle,
    }));

    const legConfigs = [...leftWithLerp, ...rightSideConfigs];
    const legs = legConfigs.map((config) => new ArachnidLeg(config));

    const unitX = entity.transform.x;
    const unitY = entity.transform.y;
    const unitRotation = entity.transform.rotation;
    for (const leg of legs) {
      leg.initializeAt(unitX, unitY, unitRotation);
    }

    this.arachnidLegs.set(entity.id, legs);
    return legs;
  }

  /**
   * Combined locomotion update — legs, treads, and wheels in a single pass over units.
   * Replaces separate updateArachnidLegs() + updateTreads() calls.
   */
  updateLocomotion(dtMs: number): void {
    const gfxConfig = getGraphicsConfig();
    const legsDisabled = gfxConfig.legs === 'none';

    // Build live unit ID set once (shared for all locomotion cleanup)
    this._reusableIdSet.clear();
    for (const e of this.entitySource.getUnits()) {
      this._reusableIdSet.add(e.id);
    }

    // Clean up stale entries from all locomotion maps
    if (legsDisabled) {
      this.arachnidLegs.clear();
    } else {
      for (const id of this.arachnidLegs.keys()) {
        if (!this._reusableIdSet.has(id)) this.arachnidLegs.delete(id);
      }
    }
    for (const id of this.tankTreads.keys()) {
      if (!this._reusableIdSet.has(id)) this.tankTreads.delete(id);
    }
    for (const id of this.vehicleWheels.keys()) {
      if (!this._reusableIdSet.has(id)) this.vehicleWheels.delete(id);
    }

    // Single pass: update all locomotion types
    for (const entity of this.entitySource.getUnits()) {
      if (!entity.unit) continue;

      const unitType = entity.unit.unitType;

      // Commanders always get legs
      if (entity.commander) {
        if (!legsDisabled) {
          const legs = this.getOrCreateLegs(entity, 'commander');
          const velX = (entity.unit.velocityX ?? 0) * 60;
          const velY = (entity.unit.velocityY ?? 0) * 60;
          for (const leg of legs) {
            leg.update(entity.transform.x, entity.transform.y, entity.transform.rotation, velX, velY, dtMs);
          }
        }
        continue;
      }

      if (!unitType) continue;
      const definition = getUnitDefinition(unitType);
      if (!definition) continue;

      if (definition.locomotion === 'legs' && !legsDisabled) {
        const legStyle = definition.legStyle ?? 'widow';
        const legs = this.getOrCreateLegs(entity, legStyle);
        const velX = (entity.unit.velocityX ?? 0) * 60;
        const velY = (entity.unit.velocityY ?? 0) * 60;
        for (const leg of legs) {
          leg.update(entity.transform.x, entity.transform.y, entity.transform.rotation, velX, velY, dtMs);
        }
      } else if (definition.locomotion === 'treads') {
        const treadType = unitType as 'mammoth' | 'badger';
        const treads = this.getOrCreateTreads(entity, treadType);
        treads.leftTread.update(entity.transform.x, entity.transform.y, entity.transform.rotation, dtMs);
        treads.rightTread.update(entity.transform.x, entity.transform.y, entity.transform.rotation, dtMs);
      } else if (definition.locomotion === 'wheels') {
        const wheelSetup = this.getOrCreateVehicleWheels(entity);
        if (wheelSetup) {
          for (const wheel of wheelSetup.wheels) {
            wheel.update(entity.transform.x, entity.transform.y, entity.transform.rotation, dtMs);
          }
        }
      }
    }
  }

  // ==================== TREAD MANAGEMENT ====================

  private getOrCreateTreads(entity: Entity, unitType: 'mammoth' | 'badger'): TankTreadSetup {
    const existing = this.tankTreads.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 24;
    const treads = unitType === 'mammoth' ? createTankTreads(radius, 2.0) : createBrawlTreads(radius, 2.0);

    treads.leftTread.initializeAt(entity.transform.x, entity.transform.y, entity.transform.rotation);
    treads.rightTread.initializeAt(entity.transform.x, entity.transform.y, entity.transform.rotation);

    this.tankTreads.set(entity.id, treads);
    return treads;
  }

  getTankTreads(entityId: EntityId): TankTreadSetup | undefined {
    return this.tankTreads.get(entityId);
  }

  private getOrCreateVehicleWheels(entity: Entity): VehicleWheelSetup | null {
    const existing = this.vehicleWheels.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 10;
    const unitType = entity.unit?.unitType;

    let wheelSetup: VehicleWheelSetup | null = null;
    switch (unitType) {
      case 'jackal': wheelSetup = createScoutWheelSetup(radius, 2.0); break;
      case 'lynx': wheelSetup = createBurstWheelSetup(radius, 2.0); break;
      case 'scorpion': wheelSetup = createMortarWheelSetup(radius, 2.0); break;
      case 'viper': wheelSetup = createFourWheelSetup(radius, 2.0); break;
      default: return null;
    }

    for (const wheel of wheelSetup.wheels) {
      wheel.initializeAt(entity.transform.x, entity.transform.y, entity.transform.rotation);
    }

    this.vehicleWheels.set(entity.id, wheelSetup);
    return wheelSetup;
  }

  getVehicleWheels(entityId: EntityId): VehicleWheelSetup | undefined {
    return this.vehicleWheels.get(entityId);
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
    const templates = getDebrisPieces(unitType, radius);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    // Resolve color types from the player color
    const baseR = (color >> 16) & 0xFF;
    const baseG = (color >> 8) & 0xFF;
    const baseB = color & 0xFF;
    const darkColor = ((baseR >> 1) << 16) | ((baseG >> 1) << 8) | (baseB >> 1);
    const lightR = Math.min(255, baseR + 60);
    const lightG = Math.min(255, baseG + 60);
    const lightB = Math.min(255, baseB + 60);
    const lightColor = (lightR << 16) | (lightG << 8) | lightB;
    const colorMap: Record<string, number> = {
      base: color,
      dark: darkColor,
      light: lightColor,
      gray: 0x606060,
      white: 0xf0f0f0,
    };

    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      // Transform local position by unit rotation
      const wx = x + cos * t.localX - sin * t.localY;
      const wy = y + sin * t.localX + cos * t.localY;

      // Random velocity with hit-direction bias
      const randAngle = Math.random() * Math.PI * 2;
      const randMag = DEBRIS_CONFIG.randomSpeedMin + Math.random() * DEBRIS_CONFIG.randomSpeedRange;
      const hitBias = DEBRIS_CONFIG.hitBiasMin + Math.random() * DEBRIS_CONFIG.hitBiasRange;
      const vx = Math.cos(randAngle) * randMag + hitDirX * hitBias;
      const vy = Math.sin(randAngle) * randMag + hitDirY * hitBias;

      const angularVel = (Math.random() - 0.5) * DEBRIS_CONFIG.angularSpeedMax;

      const fragColor = colorMap[t.colorType] ?? color;

      this.debrisFragments.push({
        x: wx, y: wy,
        vx, vy,
        rotation: rotation + t.angle,
        angularVel,
        length: t.length,
        width: t.width,
        color: fragColor,
        baseColor: fragColor,
        age: 0,
      });
    }

    // Cap debris
    if (this.debrisFragments.length > MAX_DEBRIS) {
      const excess = this.debrisFragments.length - MAX_DEBRIS;
      for (let i = 0; i < MAX_DEBRIS; i++) {
        this.debrisFragments[i] = this.debrisFragments[i + excess];
      }
      this.debrisFragments.length = MAX_DEBRIS;
    }
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

    // Age burn marks, compute cached color, and prune ones that have blended to background
    const burnCutoff = getGraphicsConfig().burnMarkAlphaCutoff;
    let burnWrite = 0;
    for (let i = 0; i < this.burnMarks.length; i++) {
      const mark = this.burnMarks[i];
      mark.age += dtMs;
      // coolBlend approaches 1 as mark fades to background; prune when close enough
      const coolBlend = 1 - Math.exp(-mark.age / BURN_COOL_TAU);
      if (coolBlend < 1 - burnCutoff) {
        // Cache color so render pass doesn't recompute exp() per mark
        const hotDecay = Math.exp(-mark.age / BURN_COLOR_TAU);
        const red = Math.round(BURN_HOT_RGB.r * hotDecay + BURN_COOL_RGB.r * coolBlend);
        const green = Math.round(BURN_HOT_RGB.g * hotDecay + BURN_COOL_RGB.g * coolBlend);
        const blue = Math.round(BURN_HOT_RGB.b * hotDecay + BURN_COOL_RGB.b * coolBlend);
        mark.color = (red << 16) | (green << 8) | blue;
        this.burnMarks[burnWrite++] = mark;
      }
    }
    this.burnMarks.length = burnWrite;

    // Age debris fragments — physics update + two-stage color decay (baseColor → black → background)
    const debrisColorTau = DEBRIS_CONFIG.colorDecayTau;
    const debrisFadeTau = DEBRIS_CONFIG.fadeDecayTau;
    let debrisWrite = 0;
    for (let i = 0; i < this.debrisFragments.length; i++) {
      const frag = this.debrisFragments[i];
      frag.age += dtMs;
      const coolBlend = 1 - Math.exp(-frag.age / debrisFadeTau);
      if (coolBlend < 1 - burnCutoff) {
        // Update physics
        const dtSec = dtMs / 1000;
        frag.x += frag.vx * dtSec;
        frag.y += frag.vy * dtSec;
        frag.vx *= DEBRIS_DRAG;
        frag.vy *= DEBRIS_DRAG;
        frag.rotation += frag.angularVel * dtSec;
        frag.angularVel *= DEBRIS_DRAG;
        // Two-stage color: baseColor → black → background
        const hotDecay = Math.exp(-frag.age / debrisColorTau);
        const fragR = (frag.baseColor >> 16) & 0xFF;
        const fragG = (frag.baseColor >> 8) & 0xFF;
        const fragB = frag.baseColor & 0xFF;
        const r = Math.round(fragR * hotDecay + BURN_COOL_RGB.r * coolBlend);
        const g = Math.round(fragG * hotDecay + BURN_COOL_RGB.g * coolBlend);
        const b = Math.round(fragB * hotDecay + BURN_COOL_RGB.b * coolBlend);
        frag.color = (r << 16) | (g << 8) | b;
        this.debrisFragments[debrisWrite++] = frag;
      }
    }
    this.debrisFragments.length = debrisWrite;
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
    setCurrentZoom(camera.zoom);
    const gfxConfig = getGraphicsConfig();
    this.sprayParticleTime += 16;
    this.collectVisibleEntities();

    // 0. Sample beam endpoints for scorched earth burn marks (line segments)
    // Key by sourceEntityId:weaponIndex so tracking survives beam entity respawns
    this._reusableIdSet.clear();
    this._activeBeamKeys.clear();
    const activeBeamKeys = this._activeBeamKeys;
    const sampleBurn = this.burnMarkFrameCounter === 0;
    this.burnMarkFrameCounter = (this.burnMarkFrameCounter + 1) % (gfxConfig.burnMarkFramesSkip + 1);
    for (const entity of this.entitySource.getProjectiles()) {
      const proj = entity.projectile;
      if (!proj || proj.projectileType !== 'beam') continue;
      this._reusableIdSet.add(entity.id);
      const weaponIndex = (proj.config as { weaponIndex?: number }).weaponIndex ?? 0;
      const beamKey = `${proj.sourceEntityId}:${weaponIndex}`;
      activeBeamKeys.add(beamKey);
      const ex = proj.endX ?? entity.transform.x;
      const ey = proj.endY ?? entity.transform.y;
      const beamWidth = proj.config.beamWidth ?? 2;
      if (sampleBurn) {
        const prev = this.prevBeamEndpoints.get(beamKey);
        if (prev) {
          const dx = ex - prev.x;
          const dy = ey - prev.y;
          if (dx * dx + dy * dy > 1) {
            this.burnMarks.push({ x1: prev.x, y1: prev.y, x2: ex, y2: ey, width: beamWidth, age: 0, color: BURN_COLOR_HOT });
          }
        }
        this.prevBeamEndpoints.set(beamKey, { x: ex, y: ey });
      }
    }
    // Clean up prev endpoints for beams that no longer exist
    for (const key of this.prevBeamEndpoints.keys()) {
      if (!activeBeamKeys.has(key)) this.prevBeamEndpoints.delete(key);
    }
    // Cap burn marks to prevent unbounded growth (copy newest to front, O(MAX) not O(n) like splice)
    if (this.burnMarks.length > MAX_BURN_MARKS) {
      const excess = this.burnMarks.length - MAX_BURN_MARKS;
      for (let i = 0; i < MAX_BURN_MARKS; i++) {
        this.burnMarks[i] = this.burnMarks[i + excess];
      }
      this.burnMarks.length = MAX_BURN_MARKS;
    }

    // 0b. Render scorched earth burn marks (below everything, fully opaque)
    // Color is pre-computed during aging pass in updateExplosions()
    for (let i = 0; i < this.burnMarks.length; i++) {
      const mark = this.burnMarks[i];
      const midX = (mark.x1 + mark.x2) * 0.5;
      const midY = (mark.y1 + mark.y2) * 0.5;
      if (!this.isInViewport(midX, midY, 50)) continue;
      this.graphics.lineStyle(mark.width, mark.color, 1);
      this.graphics.lineBetween(mark.x1, mark.y1, mark.x2, mark.y2);
      const r = mark.width / 2;
      this.graphics.fillStyle(mark.color, 1);
      this.graphics.fillCircle(mark.x1, mark.y1, r);
      this.graphics.fillCircle(mark.x2, mark.y2, r);
    }

    // 0c. Death debris fragments
    for (let i = 0; i < this.debrisFragments.length; i++) {
      const frag = this.debrisFragments[i];
      if (!this.isInViewport(frag.x, frag.y, frag.length)) continue;
      const fragCos = Math.cos(frag.rotation);
      const fragSin = Math.sin(frag.rotation);
      const halfLen = frag.length / 2;
      const x1 = frag.x - fragCos * halfLen;
      const y1 = frag.y - fragSin * halfLen;
      const x2 = frag.x + fragCos * halfLen;
      const y2 = frag.y + fragSin * halfLen;
      this.graphics.lineStyle(frag.width, frag.color, 1);
      this.graphics.lineBetween(x1, y1, x2, y2);
      const capR = frag.width / 2;
      this.graphics.fillStyle(frag.color, 1);
      this.graphics.fillCircle(x1, y1, capR);
      this.graphics.fillCircle(x2, y2, capR);
    }

    // 1. Buildings (bottom layer)
    for (const entity of this.visibleBuildings) {
      this.renderBuilding(entity);
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
      this.renderProjectile(entity);
    }
    for (const id of this.beamRandomOffsets.keys()) {
      if (!this._reusableIdSet.has(id)) this.beamRandomOffsets.delete(id);
    }

    // 7. Spray effects
    for (const target of this.sprayTargets) {
      if (!this.isInViewport(target.targetX, target.targetY, 50)) continue;
      renderSprayEffect(this.graphics, target, this.sprayParticleTime);
    }

    // 8. Explosions
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
    const playerId = ownership?.playerId;

    // Get unit type for renderer selection
    const unitType = unit.unitType ?? 'jackal';

    const palette = createColorPalette(playerId);

    // Selection ring
    if (isSelected && !this.turretsOnly) {
      this.graphics.lineStyle(3, COLORS.UNIT_SELECTED, 1);
      this.graphics.strokeCircle(x, y, radius + 5);
    }

    const ctx: UnitRenderContext = {
      graphics: this.graphics,
      x, y, radius, bodyRot: rotation, palette, isSelected, entity,
      skipTurrets: this.skipTurrets, turretsOnly: this.turretsOnly,
    };

    // Commander gets special 4-legged mech body regardless of unit type
    if (entity.commander) {
      drawCommanderUnit(ctx, this.getOrCreateLegs(entity, 'commander'));
    } else {
      // Select renderer based on unit type
      switch (unitType) {
        case 'jackal': drawScoutUnit(ctx, this.getVehicleWheels(entity.id)); break;
        case 'lynx': drawBurstUnit(ctx, this.getVehicleWheels(entity.id)); break;
        case 'daddy': drawBeamUnit(ctx, this.getOrCreateLegs(entity, 'daddy')); break;
        case 'badger': drawBrawlUnit(ctx, this.getTankTreads(entity.id)); break;
        case 'scorpion': drawMortarUnit(ctx, this.getVehicleWheels(entity.id)); break;
        case 'viper': drawSnipeUnit(ctx, this.getVehicleWheels(entity.id)); break;
        case 'mammoth': drawTankUnit(ctx, this.getTankTreads(entity.id)); break;
        case 'widow': drawArachnidUnit(ctx, this.getOrCreateLegs(entity, 'widow')); break;
        case 'tarantula': drawForceFieldUnit(ctx, this.getOrCreateLegs(entity, 'tarantula')); break;
        default: drawScoutUnit(ctx, this.getVehicleWheels(entity.id));
      }
    }

    if (!this.turretsOnly) {
      if (entity.commander) {
        renderCommanderCrown(this.graphics, x, y, radius);
      }

      const healthPercent = hp / maxHp;
      if (healthPercent < 1) {
        this.renderHealthBar(x, y - radius - 10, radius * 2, 4, healthPercent);
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

  // ==================== BUILDING RENDERING ====================

  private renderBuilding(entity: Entity): void {
    if (!entity.building) return;

    const { transform, building, ownership, buildable } = entity;
    const { x, y } = transform;
    const { width, height, hp, maxHp } = building;

    const left = x - width / 2;
    const top = y - height / 2;

    const isGhost = buildable?.isGhost ?? false;
    const isComplete = buildable?.isComplete ?? true;
    const buildProgress = buildable?.buildProgress ?? 1;

    if (isGhost) {
      const ghostColor = COLORS.GHOST;
      this.graphics.lineStyle(2, ghostColor, 0.6);
      this.graphics.strokeRect(left, top, width, height);
      this.graphics.fillStyle(ghostColor, 0.2);
      this.graphics.fillRect(left, top, width, height);
      return;
    }

    const isSelected = entity.selectable?.selected ?? false;
    if (isSelected) {
      this.graphics.lineStyle(3, COLORS.UNIT_SELECTED, 1);
      this.graphics.strokeRect(left - 4, top - 4, width + 8, height + 8);
    }

    const fillColor = ownership?.playerId ? getPlayerColor(ownership.playerId) : COLORS.BUILDING;

    if (!isComplete) {
      this.graphics.fillStyle(0x222222, 0.7);
      this.graphics.fillRect(left, top, width, height);
      const builtHeight = height * buildProgress;
      const builtTop = top + height - builtHeight;
      this.graphics.fillStyle(fillColor, 0.7);
      this.graphics.fillRect(left, builtTop, width, builtHeight);
      this.graphics.lineStyle(1, 0xaaaaaa, 0.5);
      const gridSize = 10;
      for (let gx = left; gx <= left + width; gx += gridSize) {
        this.graphics.lineBetween(gx, top, gx, top + height);
      }
      for (let gy = top; gy <= top + height; gy += gridSize) {
        this.graphics.lineBetween(left, gy, left + width, gy);
      }
    } else {
      this.graphics.fillStyle(fillColor, 0.9);
      this.graphics.fillRect(left, top, width, height);
      this.graphics.lineStyle(1, 0x665533, 0.5);
      this.graphics.strokeRect(left + 4, top + 4, width - 8, height - 8);
    }

    this.graphics.lineStyle(3, COLORS.BUILDING_OUTLINE, 1);
    this.graphics.strokeRect(left, top, width, height);

    let barY = top - 8;
    if (!isComplete) {
      this.renderBuildBar(x, barY, width, 4, buildProgress);
      barY -= 6;
    }
    if (hp < maxHp) {
      this.renderHealthBar(x, barY, width, 4, hp / maxHp);
    }

    const playerColor = getPlayerColor(ownership?.playerId);
    const buildingCtx: BuildingRenderContext = {
      graphics: this.graphics, entity, left, top, width, height, playerColor,
      sprayParticleTime: this.sprayParticleTime,
    };

    if (entity.factory && isComplete) {
      renderFactory(buildingCtx);
    }
    if (entity.buildingType === 'solar' && isComplete) {
      renderSolarPanel(buildingCtx);
    }
  }

  // ==================== PROJECTILE RENDERING ====================

  private renderProjectile(entity: Entity): void {
    if (!entity.projectile) return;

    const { transform, projectile, ownership } = entity;
    const { x, y } = transform;
    const config = projectile.config;
    const baseColor = getPlayerColor(ownership?.playerId);
    const color = getProjectileColor(baseColor);

    if (projectile.projectileType === 'beam') {
      const startX = projectile.startX ?? x;
      const startY = projectile.startY ?? y;
      const endX = projectile.endX ?? x;
      const endY = projectile.endY ?? y;
      const beamWidth = config.beamWidth ?? 2;
      const beamStyle = getGraphicsConfig().beamStyle;

      let randomOffsets = this.beamRandomOffsets.get(entity.id);
      if (!randomOffsets) {
        randomOffsets = {
          phaseOffset: Math.random() * Math.PI * 2,
          rotationOffset: Math.random() * Math.PI * 2,
          sizeScale: 0.8 + Math.random() * 0.4,
          pulseSpeed: 0.7 + Math.random() * 0.6,
        };
        this.beamRandomOffsets.set(entity.id, randomOffsets);
      }

      if (beamStyle === 'detailed' || beamStyle === 'complex') {
        this.graphics.lineStyle(beamWidth + 4, color, 0.3);
        this.graphics.lineBetween(startX, startY, endX, endY);
      }

      this.graphics.lineStyle(beamWidth, color, 0.9);
      this.graphics.lineBetween(startX, startY, endX, endY);

      if (beamStyle !== 'simple') {
        this.graphics.lineStyle(beamWidth / 2, 0xffffff, 1);
        this.graphics.lineBetween(startX, startY, endX, endY);
      }

      const baseRadius = beamWidth * 2 + 6;
      const explosionRadius = baseRadius * randomOffsets.sizeScale;

      if (beamStyle === 'simple') {
        this.graphics.fillStyle(color, 0.7);
        this.graphics.fillCircle(endX, endY, explosionRadius * 0.8);
      } else if (beamStyle === 'standard') {
        this.graphics.fillStyle(color, 0.6);
        this.graphics.fillCircle(endX, endY, explosionRadius);
        this.graphics.fillStyle(0xffffff, 0.8);
        this.graphics.fillCircle(endX, endY, explosionRadius * 0.4);
      } else {
        this.graphics.fillStyle(color, 0.4);
        this.graphics.fillCircle(endX, endY, explosionRadius * 1.3);
        this.graphics.fillStyle(color, 0.6);
        this.graphics.fillCircle(endX, endY, explosionRadius);
        this.graphics.fillStyle(0xffffff, 0.8);
        this.graphics.fillCircle(endX, endY, explosionRadius * 0.4);

        const pulseTime = this.sprayParticleTime * randomOffsets.pulseSpeed;
        const sparkCount = beamStyle === 'complex' ? 6 : 4;
        for (let i = 0; i < sparkCount; i++) {
          const baseAngle = (pulseTime / 150 + i / sparkCount) * Math.PI * 2;
          const angle = baseAngle + randomOffsets.rotationOffset;
          const sparkDist = explosionRadius * (0.8 + Math.sin(pulseTime / 50 + i * 2 + randomOffsets.phaseOffset) * 0.4);
          const sx = endX + Math.cos(angle) * sparkDist;
          const sy = endY + Math.sin(angle) * sparkDist;
          this.graphics.fillStyle(color, 0.7);
          this.graphics.fillCircle(sx, sy, 2);
        }
      }
    } else if (entity.dgunProjectile) {
      const radius = config.projectileRadius ?? 25;
      const pulsePhase = (projectile.timeAlive / 100) % 1;
      const pulseRadius = radius * (1.3 + 0.2 * Math.sin(pulsePhase * Math.PI * 2));

      this.graphics.fillStyle(0xff4400, 0.3);
      this.graphics.fillCircle(x, y, pulseRadius);
      this.graphics.fillStyle(0xff6600, 0.5);
      this.graphics.fillCircle(x, y, radius * 1.1);
      this.graphics.fillStyle(color, 0.9);
      this.graphics.fillCircle(x, y, radius);
      this.graphics.fillStyle(0xffff00, 0.8);
      this.graphics.fillCircle(x, y, radius * 0.5);
      this.graphics.fillStyle(0xffffff, 1);
      this.graphics.fillCircle(x, y, radius * 0.2);

      const velMag = magnitude(projectile.velocityX, projectile.velocityY);
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
      const radius = config.projectileRadius ?? 5;
      const trailLength = config.trailLength ?? 3;
      const velMag = magnitude(projectile.velocityX, projectile.velocityY);

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

      this.graphics.fillStyle(color, 0.9);
      this.graphics.fillCircle(x, y, radius);
      this.graphics.fillStyle(0xffffff, 0.8);
      this.graphics.fillCircle(x, y, radius * 0.4);

      if (config.splashRadius && !projectile.hasExploded) {
        this.graphics.lineStyle(1, color, 0.2);
        this.graphics.strokeCircle(x, y, config.splashRadius);
      }
    }
  }

  // ==================== UI BARS ====================

  private renderBuildBar(x: number, y: number, width: number, height: number, percent: number): void {
    const left = x - width / 2;
    this.graphics.fillStyle(COLORS.HEALTH_BAR_BG, 0.8);
    this.graphics.fillRect(left, y, width, height);
    this.graphics.fillStyle(COLORS.BUILD_BAR_FG, 0.9);
    this.graphics.fillRect(left, y, width * percent, height);
  }

  private renderHealthBar(x: number, y: number, width: number, height: number, percent: number): void {
    const left = x - width / 2;
    this.graphics.fillStyle(COLORS.HEALTH_BAR_BG, 0.8);
    this.graphics.fillRect(left, y, width, height);
    const healthColor = percent > 0.3 ? COLORS.HEALTH_BAR_FG : COLORS.HEALTH_BAR_LOW;
    this.graphics.fillStyle(healthColor, 0.9);
    this.graphics.fillRect(left, y, width * percent, height);
  }

  clearEffects(): void {
    this.debrisFragments.length = 0;
    this.burnMarks.length = 0;
    this.explosions.length = 0;
  }

  destroy(): void {
    this.graphics.destroy();
  }
}
