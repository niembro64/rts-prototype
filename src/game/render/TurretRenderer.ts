// Generic turret renderer - draws weapon turrets driven by TurretConfig
// Turret visual is owned by the weapon, not the unit chassis

import Phaser from 'phaser';
import type { UnitWeapon, EntityId } from '../sim/types';
import type { ColorPalette, LodLevel } from './types';
import { COLORS } from './types';
import { drawForceFieldGrate } from './helpers';
import { renderForceFieldEffect } from './effects';
import type { TurretConfig, ForceFieldTurretConfig } from '../../config';

/**
 * Draw a weapon's turret at the given mount point.
 * Dispatches to the appropriate turret renderer based on turretConfig.type.
 */
export function drawTurret(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number,
  mountY: number,
  unitRadius: number,
  weapon: UnitWeapon,
  lod: LodLevel,
  palette: ColorPalette,
  spinAngle: number,
  entityId: EntityId,
): void {
  const turretConfig = weapon.config.turretShape as TurretConfig | undefined;
  if (!turretConfig) return;

  // Min LOD: only force field zones (no barrel geometry)
  if (lod === 'min') {
    if (turretConfig.type === 'forceField') {
      drawForceFieldZonesOnly(graphics, mountX, mountY, weapon, lod, entityId);
    }
    return;
  }

  switch (turretConfig.type) {
    case 'multibarrel':
      drawMultibarrelTurret(graphics, mountX, mountY, unitRadius, weapon.turretRotation, turretConfig, lod, spinAngle);
      break;
    case 'coneSpread':
      drawConeSpreadTurret(graphics, mountX, mountY, unitRadius, weapon, turretConfig, lod, spinAngle);
      break;
    case 'single':
      drawSingleBarrelTurret(graphics, mountX, mountY, unitRadius, weapon.turretRotation, turretConfig, lod);
      break;
    case 'beamEmitter':
      drawBeamEmitterTurret(graphics, mountX, mountY, unitRadius, weapon.turretRotation, turretConfig, lod, palette);
      break;
    case 'forceField':
      drawForceFieldTurretFull(graphics, mountX, mountY, unitRadius, weapon, turretConfig.grate, lod, entityId);
      break;
  }
}

// ==================== MULTIBARREL (gatling, pulse) ====================

function drawMultibarrelTurret(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number, mountY: number,
  r: number,
  turretRot: number,
  config: Extract<TurretConfig, { type: 'multibarrel' }>,
  lod: LodLevel,
  spinAngle: number,
): void {
  if (lod === 'low') {
    const endX = mountX + Math.cos(turretRot) * r * config.barrelLength;
    const endY = mountY + Math.sin(turretRot) * r * config.barrelLength;
    graphics.lineStyle(config.barrelThickness, COLORS.WHITE, 1);
    graphics.lineBetween(mountX, mountY, endX, endY);
    return;
  }

  const { barrelCount, barrelLength, barrelThickness, orbitRadius, depthScale } = config;
  const orbit = orbitRadius * r;
  const baseTurretLen = r * barrelLength;
  const TWO_PI_N = (2 * Math.PI) / barrelCount;

  const perpCos = Math.cos(turretRot + Math.PI / 2);
  const perpSin = Math.sin(turretRot + Math.PI / 2);
  const fwdCos = Math.cos(turretRot);
  const fwdSin = Math.sin(turretRot);

  for (let i = 0; i < barrelCount; i++) {
    const phase = spinAngle + i * TWO_PI_N;
    const lateralOffset = Math.sin(phase) * orbit;
    const depthFactor = 1.0 - Math.cos(phase) * depthScale;
    const turretLen = baseTurretLen * depthFactor;

    const offX = perpCos * lateralOffset;
    const offY = perpSin * lateralOffset;
    const endX = mountX + fwdCos * turretLen + offX;
    const endY = mountY + fwdSin * turretLen + offY;

    graphics.lineStyle(barrelThickness, COLORS.WHITE, 1);
    graphics.lineBetween(mountX + offX, mountY + offY, endX, endY);
  }
}

// ==================== CONE SPREAD (shotgun) ====================

function drawConeSpreadTurret(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number, mountY: number,
  r: number,
  weapon: UnitWeapon,
  config: Extract<TurretConfig, { type: 'coneSpread' }>,
  lod: LodLevel,
  spinAngle: number,
): void {
  const turretRot = weapon.turretRotation;

  if (lod === 'low') {
    const endX = mountX + Math.cos(turretRot) * r * config.barrelLength;
    const endY = mountY + Math.sin(turretRot) * r * config.barrelLength;
    graphics.lineStyle(config.barrelThickness, COLORS.WHITE, 1);
    graphics.lineBetween(mountX, mountY, endX, endY);
    return;
  }

  const { barrelCount, barrelLength, barrelThickness, baseOrbit, depthScale } = config;
  const barrelLen = r * barrelLength;
  const baseOrbitPx = baseOrbit * r;
  const spreadAngle = weapon.config.spreadAngle ?? Math.PI / 5;
  const spreadHalf = spreadAngle / 2;
  const tipOrbit = baseOrbitPx + barrelLen * Math.tan(spreadHalf);
  const TWO_PI_N = (2 * Math.PI) / barrelCount;

  const fwdCos = Math.cos(turretRot);
  const fwdSin = Math.sin(turretRot);
  const perpCos = Math.cos(turretRot + Math.PI / 2);
  const perpSin = Math.sin(turretRot + Math.PI / 2);

  for (let i = 0; i < barrelCount; i++) {
    const phase = spinAngle + i * TWO_PI_N;
    const sinPhase = Math.sin(phase);
    const cosPhase = Math.cos(phase);
    const depthFactor = 1.0 - cosPhase * depthScale;
    const len = barrelLen * depthFactor;

    const baseOff = sinPhase * baseOrbitPx;
    const bx = mountX + perpCos * baseOff;
    const by = mountY + perpSin * baseOff;

    const tipOff = sinPhase * tipOrbit;
    const tipX = mountX + fwdCos * len + perpCos * tipOff;
    const tipY = mountY + fwdSin * len + perpSin * tipOff;

    graphics.lineStyle(barrelThickness, COLORS.WHITE, 1);
    graphics.lineBetween(bx, by, tipX, tipY);
  }
}

// ==================== SINGLE BARREL (mortar, cannon, railgun) ====================

function drawSingleBarrelTurret(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number, mountY: number,
  r: number,
  turretRot: number,
  config: Extract<TurretConfig, { type: 'single' }>,
  lod: LodLevel,
): void {
  const turretLen = r * config.barrelLength;
  const endX = mountX + Math.cos(turretRot) * turretLen;
  const endY = mountY + Math.sin(turretRot) * turretLen;

  if (lod === 'high') {
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(mountX, mountY, Math.max(r * 0.06, config.barrelThickness * 0.5));
  }
  graphics.lineStyle(config.barrelThickness, COLORS.WHITE, 1);
  graphics.lineBetween(mountX, mountY, endX, endY);
}

// ==================== BEAM EMITTER (beam, megaBeam, disruptor) ====================

function drawBeamEmitterTurret(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number, mountY: number,
  r: number,
  turretRot: number,
  config: Extract<TurretConfig, { type: 'beamEmitter' }>,
  lod: LodLevel,
  palette: ColorPalette,
): void {
  const beamLen = r * config.barrelLength;
  const beamEndX = mountX + Math.cos(turretRot) * beamLen;
  const beamEndY = mountY + Math.sin(turretRot) * beamLen;

  if (lod === 'high') {
    // Emitter housing
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(mountX, mountY, r * 0.12);

    graphics.lineStyle(config.barrelThickness, COLORS.WHITE, 1);
    graphics.lineBetween(mountX, mountY, beamEndX, beamEndY);
  } else {
    graphics.lineStyle(config.barrelThickness, COLORS.WHITE, 1);
    graphics.lineBetween(mountX, mountY, beamEndX, beamEndY);
  }
}

// ==================== FORCE FIELD (forceField, megaForceField) ====================

function drawForceFieldTurretFull(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number, mountY: number,
  r: number,
  weapon: UnitWeapon,
  grateConfig: ForceFieldTurretConfig,
  lod: LodLevel,
  entityId: EntityId,
): void {
  const turretRot = weapon.turretRotation;
  const progress = weapon.currentForceFieldRange ?? 0;
  const transitionTimeMs = weapon.config.forceFieldTransitionTime ?? 1000;

  // Draw grate
  const grateOriginX = mountX + Math.cos(turretRot) * r * grateConfig.originOffset;
  const grateOriginY = mountY + Math.sin(turretRot) * r * grateConfig.originOffset;
  drawForceFieldGrate(graphics, grateOriginX, grateOriginY, turretRot, r, grateConfig, progress, transitionTimeMs);

  if (progress <= 0) return;

  drawForceFieldZones(graphics, mountX, mountY, weapon, lod, entityId);
}

// Force field zone rendering (push/pull effects) - used by both min and normal LOD paths
function drawForceFieldZones(
  graphics: Phaser.GameObjects.Graphics,
  cx: number, cy: number,
  weapon: UnitWeapon,
  lod: LodLevel,
  entityId: EntityId,
): void {
  const turretRot = weapon.turretRotation;
  const progress = weapon.currentForceFieldRange ?? 0;
  const sliceAngle = weapon.config.forceFieldAngle ?? Math.PI / 4;
  const { push, pull } = weapon.config;

  if (push) {
    const pushInner = push.outerRange - (push.outerRange - push.innerRange) * progress;
    if (push.outerRange > pushInner) {
      renderForceFieldEffect(
        graphics, cx, cy, turretRot, sliceAngle, push.outerRange,
        push.color, push.alpha, push.particleAlpha,
        pushInner, true, lod, entityId
      );
    }
  }

  if (pull) {
    const pullOuter = pull.innerRange + (pull.outerRange - pull.innerRange) * progress;
    if (pullOuter > pull.innerRange) {
      renderForceFieldEffect(
        graphics, cx, cy, turretRot, sliceAngle, pullOuter,
        pull.color, pull.alpha, pull.particleAlpha,
        pull.innerRange, false, lod, entityId
      );
    }
  }
}

// Min LOD path: force field zones only (no grate geometry)
function drawForceFieldZonesOnly(
  graphics: Phaser.GameObjects.Graphics,
  cx: number, cy: number,
  weapon: UnitWeapon,
  lod: LodLevel,
  entityId: EntityId,
): void {
  const progress = weapon.currentForceFieldRange ?? 0;
  if (progress <= 0) return;
  drawForceFieldZones(graphics, cx, cy, weapon, lod, entityId);
}
