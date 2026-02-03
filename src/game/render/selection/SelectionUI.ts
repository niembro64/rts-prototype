// Selection UI rendering - labels, commander crown

import Phaser from 'phaser';
import type { EntitySource } from '../types';
import { COLORS, UNIT_NAMES } from '../types';
import { drawStar } from '../helpers';

/**
 * Render labels above selected units and buildings
 */
export function renderSelectedLabels(
  _graphics: Phaser.GameObjects.Graphics,
  entitySource: EntitySource,
  getLabel: () => Phaser.GameObjects.Text
): void {
  // Labels for selected units - skip dead units
  for (const entity of entitySource.getUnits()) {
    if (entity.selectable?.selected && entity.unit && entity.unit.hp > 0) {
      const { x, y } = entity.transform;
      const { collisionRadius } = entity.unit;
      // Detect unit type by checking all weapons
      const weapons = entity.weapons ?? [];
      let weaponId = 'scout'; // default
      if (weapons.length > 1) {
        weaponId = 'widow';
      } else {
        for (const weapon of weapons) {
          weaponId = weapon.config.id;
        }
      }

      // Commander gets special label
      const name = entity.commander
        ? 'Commander'
        : UNIT_NAMES[weaponId] ?? weaponId;

      const label = getLabel();
      label.setText(name);
      label.setPosition(x, y - collisionRadius - 18); // Above health bar
    }
  }

  // Labels for selected buildings - skip dead buildings
  for (const entity of entitySource.getBuildings()) {
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

      const label = getLabel();
      label.setText(name);
      label.setPosition(x, y - height / 2 - 14); // Above building
    }
  }
}

/**
 * Render commander crown
 */
export function renderCommanderCrown(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  radius: number
): void {
  // Gold circle
  graphics.lineStyle(2, COLORS.COMMANDER, 0.9);
  graphics.strokeCircle(x, y, radius + 8);

  // Crown points (5 points)
  const dotCount = 5;
  for (let i = 0; i < dotCount; i++) {
    const angle = (i / dotCount) * Math.PI * 2 - Math.PI / 2;
    const dotX = x + Math.cos(angle) * (radius + 8);
    const dotY = y + Math.sin(angle) * (radius + 8);
    // Star shape at each point
    graphics.fillStyle(COLORS.COMMANDER, 1);
    drawStar(graphics, dotX, dotY, 4, 5);
  }

  // Inner gold ring
  graphics.lineStyle(1, COLORS.COMMANDER, 0.5);
  graphics.strokeCircle(x, y, radius + 3);
}
