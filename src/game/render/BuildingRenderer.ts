// Standalone building rendering function extracted from EntityRenderer

import Phaser from 'phaser';
import type { Entity } from '../sim/types';
import { COLORS } from './types';
import type { BuildingRenderContext } from './types';
import { getPlayerColor } from './helpers';
import { renderFactory, renderSolarPanel } from './buildings';

export function renderBuilding(
  graphics: Phaser.GameObjects.Graphics,
  entity: Entity,
  sprayParticleTime: number,
  renderBuildBar: (x: number, y: number, width: number, height: number, percent: number) => void,
  renderHealthBar: (x: number, y: number, width: number, height: number, percent: number) => void,
): void {
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
    graphics.lineStyle(2, ghostColor, 0.6);
    graphics.strokeRect(left, top, width, height);
    graphics.fillStyle(ghostColor, 0.2);
    graphics.fillRect(left, top, width, height);
    return;
  }

  const isSelected = entity.selectable?.selected ?? false;
  if (isSelected) {
    graphics.lineStyle(3, COLORS.UNIT_SELECTED, 1);
    graphics.strokeRect(left - 4, top - 4, width + 8, height + 8);
  }

  const fillColor = ownership?.playerId ? getPlayerColor(ownership.playerId) : COLORS.BUILDING;

  if (!isComplete) {
    graphics.fillStyle(0x222222, 0.7);
    graphics.fillRect(left, top, width, height);
    const builtHeight = height * buildProgress;
    const builtTop = top + height - builtHeight;
    graphics.fillStyle(fillColor, 0.7);
    graphics.fillRect(left, builtTop, width, builtHeight);
    graphics.lineStyle(1, 0xaaaaaa, 0.5);
    const gridSize = 10;
    for (let gx = left; gx <= left + width; gx += gridSize) {
      graphics.lineBetween(gx, top, gx, top + height);
    }
    for (let gy = top; gy <= top + height; gy += gridSize) {
      graphics.lineBetween(left, gy, left + width, gy);
    }
  } else {
    graphics.fillStyle(fillColor, 0.9);
    graphics.fillRect(left, top, width, height);
    graphics.lineStyle(1, 0x665533, 0.5);
    graphics.strokeRect(left + 4, top + 4, width - 8, height - 8);
  }

  graphics.lineStyle(3, COLORS.BUILDING_OUTLINE, 1);
  graphics.strokeRect(left, top, width, height);

  let barY = top - 8;
  if (!isComplete) {
    renderBuildBar(x, barY, width, 4, buildProgress);
    barY -= 6;
  }
  if (hp < maxHp) {
    renderHealthBar(x, barY, width, 4, hp / maxHp);
  }

  const playerColor = getPlayerColor(ownership?.playerId);
  const buildingCtx: BuildingRenderContext = {
    graphics, entity, left, top, width, height, playerColor,
    sprayParticleTime,
  };

  if (entity.factory && isComplete) {
    renderFactory(buildingCtx);
  }
  if (entity.buildingType === 'solar' && isComplete) {
    renderSolarPanel(buildingCtx);
  }
}
