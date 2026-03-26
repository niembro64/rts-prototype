// Generic turret renderer - draws weapon turrets driven by TurretConfig
// Turret visual is owned by the weapon, not the unit chassis

import Phaser from '../PhaserCompat';
import { type Turret, type EntityId, isLineShot } from '../sim/types';
import type { ColorPalette } from './types';
import { COLORS } from './types';
import { drawForceFieldGrate } from './helpers';
import { renderForceFieldEffect } from './effects';
import type { BarrelShape, ForceFieldTurretConfig } from '../../config';
import type { TurretStyle, ForceTurretStyle } from '@/types/graphics';

// Frame-batched time — set once per render frame to avoid per-turret Date.now() calls
let _nowSec = 0;
export function setTurretFrameTime(nowSec: number): void { _nowSec = nowSec; }

// When true, force field zone rendering is skipped during the normal turret pass
// (because zones were already drawn in an early opaque pass).
let _skipForceFieldZones = false;
export function setSkipForceFieldZones(skip: boolean): void { _skipForceFieldZones = skip; }

/**
 * Draw a weapon's turret at the given mount point.
 * Dispatches to the appropriate turret renderer based on turretConfig.type.
 */
export function drawTurret(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number,
  mountY: number,
  unitRadius: number,
  weapon: Turret,
  _palette: ColorPalette,
  spinAngle: number,
  entityId: EntityId,
  turretStyle: TurretStyle = 'full',
  forceTurretStyle: ForceTurretStyle = 'full',
): void {
  const turretConfig = weapon.config.barrel as BarrelShape | undefined;
  if (!turretConfig) return;

  // Force field turrets use their own separate LOD config
  if (turretConfig.type === 'complexSingleEmitter') {
    if (forceTurretStyle === 'none') {
      drawForceFieldZonesOnly(graphics, mountX, mountY, weapon, entityId);
    } else if (forceTurretStyle === 'simple') {
      drawForceFieldTurretSimple(graphics, mountX, mountY, unitRadius, weapon, turretConfig.grate, entityId);
    } else {
      drawForceFieldTurretFull(graphics, mountX, mountY, unitRadius, weapon, turretConfig.grate, entityId);
    }
    return;
  }

  // Non-force-field turrets use turretStyle
  if (turretStyle === 'none') return;

  switch (turretConfig.type) {
    case 'simpleMultiBarrel':
      drawMultibarrelTurret(graphics, mountX, mountY, unitRadius, weapon.rotation, turretConfig, turretStyle, spinAngle);
      break;
    case 'coneMultiBarrel':
      drawConeSpreadTurret(graphics, mountX, mountY, unitRadius, weapon, turretConfig, turretStyle, spinAngle);
      break;
    case 'simpleSingleBarrel': {
      const shotWidth = isLineShot(weapon.config.shot) ? weapon.config.shot.width : undefined;
      drawSingleBarrelTurret(graphics, mountX, mountY, unitRadius, weapon.rotation, turretConfig, turretStyle, shotWidth);
      break;
    }
  }
}

// ==================== MULTIBARREL (gatling, pulse) ====================

function drawMultibarrelTurret(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number, mountY: number,
  r: number,
  turretRot: number,
  config: Extract<BarrelShape, { type: 'simpleMultiBarrel' }>,
  turretStyle: TurretStyle,
  spinAngle: number,
): void {
  if (turretStyle === 'simple') {
    const endX = mountX + Math.cos(turretRot) * r * config.barrelLength;
    const endY = mountY + Math.sin(turretRot) * r * config.barrelLength;
    graphics.lineStyle(config.barrelThickness ?? 2, COLORS.WHITE, 1);
    graphics.lineBetween(mountX, mountY, endX, endY);
    return;
  }

  const { barrelCount, barrelLength, barrelThickness = 2, orbitRadius, depthScale } = config;
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
  weapon: Turret,
  config: Extract<BarrelShape, { type: 'coneMultiBarrel' }>,
  turretStyle: TurretStyle,
  spinAngle: number,
): void {
  const turretRot = weapon.rotation;

  if (turretStyle === 'simple') {
    const endX = mountX + Math.cos(turretRot) * r * config.barrelLength;
    const endY = mountY + Math.sin(turretRot) * r * config.barrelLength;
    graphics.lineStyle(config.barrelThickness ?? 2, COLORS.WHITE, 1);
    graphics.lineBetween(mountX, mountY, endX, endY);
    return;
  }

  const { barrelCount, barrelLength, barrelThickness = 2, baseOrbit, depthScale } = config;
  const barrelLen = r * barrelLength;
  const baseOrbitPx = baseOrbit * r;
  const spreadAngle = weapon.config.spread?.angle ?? Math.PI / 5;
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

// Pre-allocated quad points for barrel rectangle drawing
const _barrelQuad = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];

function drawSingleBarrelTurret(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number, mountY: number,
  r: number,
  turretRot: number,
  config: Extract<BarrelShape, { type: 'simpleSingleBarrel' }>,
  turretStyle: TurretStyle,
  shotWidth?: number,
): void {
  const turretLen = r * config.barrelLength;
  const thickness = shotWidth ?? config.barrelThickness ?? 2;
  const halfW = thickness * 0.5;

  // Direction along barrel and perpendicular
  const fwdX = Math.cos(turretRot);
  const fwdY = Math.sin(turretRot);
  const perpX = -fwdY;
  const perpY = fwdX;

  const endX = mountX + fwdX * turretLen;
  const endY = mountY + fwdY * turretLen;

  if (turretStyle === 'full') {
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(mountX, mountY, halfW);
  }

  // Draw barrel as a filled quad for pixel-perfect centering
  graphics.fillStyle(COLORS.WHITE, 1);
  _barrelQuad[0].x = mountX - perpX * halfW;
  _barrelQuad[0].y = mountY - perpY * halfW;
  _barrelQuad[1].x = mountX + perpX * halfW;
  _barrelQuad[1].y = mountY + perpY * halfW;
  _barrelQuad[2].x = endX + perpX * halfW;
  _barrelQuad[2].y = endY + perpY * halfW;
  _barrelQuad[3].x = endX - perpX * halfW;
  _barrelQuad[3].y = endY - perpY * halfW;
  graphics.fillPoints(_barrelQuad, true);
}

// ==================== FORCE FIELD (forceField, megaForceField) ====================

/** Simple force field turret: single pulsing circle + zones (no multi-ring grate) */
function drawForceFieldTurretSimple(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number, mountY: number,
  r: number,
  weapon: Turret,
  grateConfig: ForceFieldTurretConfig,
  entityId: EntityId,
): void {
  const progress = weapon.forceField?.range ?? 0;
  const transitionTimeMs = weapon.config.shot.type === 'force' ? weapon.config.shot.transitionTime : 1000;

  // Single pulsing circle at mount point — lerps white → blue with progress
  let color: number = COLORS.WHITE;
  if (progress > 0) {
    const time = _nowSec;
    const freq = (Math.PI * 2) / (transitionTimeMs / 1000);
    const t = (Math.sin(time * freq) * 0.5 + 0.5) * progress;
    // Lerp from white (0xf0f0f0) toward blue (0x3366ff)
    const cr = (0xf0 + ((0x33 - 0xf0) * t)) | 0;
    const cg = (0xf0 + ((0x66 - 0xf0) * t)) | 0;
    const cb = (0xf0 + ((0xff - 0xf0) * t)) | 0;
    color = (cr << 16) | (cg << 8) | cb;
  }
  graphics.fillStyle(color, 1);
  graphics.fillCircle(mountX, mountY, r * grateConfig.width);

  if (progress <= 0 || _skipForceFieldZones) return;
  drawForceFieldZones(graphics, mountX, mountY, weapon, entityId);
}

function drawForceFieldTurretFull(
  graphics: Phaser.GameObjects.Graphics,
  mountX: number, mountY: number,
  r: number,
  weapon: Turret,
  grateConfig: ForceFieldTurretConfig,
  entityId: EntityId,
): void {
  const turretRot = weapon.rotation;
  const progress = weapon.forceField?.range ?? 0;
  const transitionTimeMs = weapon.config.shot.type === 'force' ? weapon.config.shot.transitionTime : 1000;

  // Draw grate
  const grateOriginX = mountX + Math.cos(turretRot) * r * grateConfig.originOffset;
  const grateOriginY = mountY + Math.sin(turretRot) * r * grateConfig.originOffset;
  drawForceFieldGrate(graphics, grateOriginX, grateOriginY, turretRot, r, grateConfig, progress, transitionTimeMs);

  if (progress <= 0 || _skipForceFieldZones) return;

  drawForceFieldZones(graphics, mountX, mountY, weapon, entityId);
}

// Force field zone rendering (push/pull effects)
function drawForceFieldZones(
  graphics: Phaser.GameObjects.Graphics,
  cx: number, cy: number,
  weapon: Turret,
  entityId: EntityId,
): void {
  const progress = weapon.forceField?.range ?? 0;
  const fieldShot = weapon.config.shot.type === 'force' ? weapon.config.shot : null;
  const push = fieldShot?.push;
  if (!push) return;

  const pushInner = push.outerRange - (push.outerRange - push.innerRange) * progress;
  if (push.outerRange > pushInner) {
    // Fade alpha with progress so the field smoothly appears instead of
    // showing a hard-edged thin ring that looks like a bright outline.
    const fadeIn = Math.min(progress * 3, 1); // reaches full alpha at ~33% progress
    renderForceFieldEffect(
      graphics, cx, cy, 0, Math.PI * 2, push.outerRange,
      push.color, push.alpha * fadeIn, push.particleAlpha * fadeIn,
      pushInner, true, entityId
    );
  }
}

// Turret style 'none' path: force field zones only (no grate geometry)
function drawForceFieldZonesOnly(
  graphics: Phaser.GameObjects.Graphics,
  cx: number, cy: number,
  weapon: Turret,
  entityId: EntityId,
): void {
  const progress = weapon.forceField?.range ?? 0;
  if (progress <= 0 || _skipForceFieldZones) return;
  drawForceFieldZones(graphics, cx, cy, weapon, entityId);
}

/**
 * Render force field zones for a single entity (early opaque pass).
 * Called before unit bodies so that opaque pre-blended zones sit behind everything.
 */
export function renderForceFieldZonesEarly(
  graphics: Phaser.GameObjects.Graphics,
  entity: { turrets?: Turret[]; transform: { x: number; y: number; rotation: number }; unit?: { unitRadiusCollider: { scale: number }; unitType?: string }; id: EntityId },
  mounts: { x: number; y: number }[],
): void {
  if (!entity.turrets) return;
  const { x, y, rotation: bodyRot } = entity.transform;
  const r = entity.unit?.unitRadiusCollider.scale ?? 10;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  for (let i = 0; i < entity.turrets.length; i++) {
    const weapon = entity.turrets[i];
    const isForceField = (weapon.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
    if (!isForceField) continue;

    const progress = weapon.forceField?.range ?? 0;
    if (progress <= 0) continue;

    const mount = mounts[Math.min(i, mounts.length - 1)];
    const mountX = x + cos * mount.x * r - sin * mount.y * r;
    const mountY = y + sin * mount.x * r + cos * mount.y * r;

    drawForceFieldZones(graphics, mountX, mountY, weapon, entity.id);
  }
}
