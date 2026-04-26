// SelectionLabelOverlay — floating unit / building names above selected entities.
//
// Shared between 2D and 3D via the WorldProjector pattern. Labels are small HTML
// divs positioned with CSS transform so they look crisp and composite smoothly
// with the canvas (same trick used by the other HUD overlays).
//
// Text source mirrors render/selection/SelectionUI.ts:
//   - Commander → "Commander"
//   - Unit      → UNIT_NAMES[unitType] ?? unitType
//   - Factory   → "Factory"
//   - Solar     → "Solar"

import type { Entity } from '../sim/types';
import type { WorldProjector, Vec2 } from './WorldProjector';
import { UNIT_NAMES } from '../uiLabels';

export const SELECTION_LABEL_STYLE = {
  /** Distance in world units above the entity top where the label sits. */
  paddingWorldUnits: 22,
  textColor: '#ffffff',
  bgColor: 'rgba(0, 0, 0, 0.55)',
  padding: '1px 5px',
  fontSize: '11px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

type Label = {
  el: HTMLDivElement;
  /** Last text we wrote so we can skip redundant DOM writes. */
  lastText: string;
};

function labelTextForUnit(entity: Entity): string {
  if (entity.commander) return 'Commander';
  const unitType = entity.unit?.unitType ?? 'jackal';
  return UNIT_NAMES[unitType] ?? unitType;
}

function labelTextForBuilding(entity: Entity): string {
  if (entity.buildingType === 'factory') return 'Factory';
  if (entity.buildingType === 'solar') return 'Solar';
  return 'Building';
}

export class SelectionLabelOverlay {
  private root: HTMLDivElement;
  private projector: WorldProjector;
  private pool: Label[] = [];
  private _scratch: Vec2 = { x: 0, y: 0 };

  constructor(parent: HTMLElement, projector: WorldProjector) {
    this.projector = projector;
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      overflow: 'hidden',
      zIndex: '5',
    });
    parent.appendChild(this.root);
  }

  private acquire(i: number): Label {
    let label = this.pool[i];
    if (!label) {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        color: SELECTION_LABEL_STYLE.textColor,
        backgroundColor: SELECTION_LABEL_STYLE.bgColor,
        padding: SELECTION_LABEL_STYLE.padding,
        fontSize: SELECTION_LABEL_STYLE.fontSize,
        fontFamily: SELECTION_LABEL_STYLE.fontFamily,
        borderRadius: '2px',
        whiteSpace: 'nowrap',
        willChange: 'transform',
        // Horizontal-center the label on its anchor point.
        transformOrigin: '50% 100%',
      });
      this.root.appendChild(el);
      label = { el, lastText: '' };
      this.pool.push(label);
    }
    label.el.style.display = '';
    return label;
  }

  update(
    selectedUnits: readonly Entity[],
    selectedBuildings: readonly Entity[],
  ): void {
    this.projector.refreshViewport();
    let used = 0;

    for (const u of selectedUnits) {
      if (!u.unit || u.unit.hp <= 0) continue;
      const radius = u.unit.unitRadiusCollider.scale;
      used = this.renderLabel(
        used,
        u.transform.x, u.transform.y, u.transform.z,
        radius,
        labelTextForUnit(u),
      );
    }

    for (const b of selectedBuildings) {
      if (!b.building || b.building.hp <= 0) continue;
      const halfExtent = Math.max(b.building.width, b.building.height) / 2;
      // Anchor at the building's top face (transform.z is center, +depth/2
      // is the top) so the label sits cleanly above terrain-lifted
      // structures, not buried inside them.
      const topZ = b.transform.z + b.building.depth / 2;
      used = this.renderLabel(
        used,
        b.transform.x, b.transform.y, topZ,
        halfExtent,
        labelTextForBuilding(b),
      );
    }

    for (let i = used; i < this.pool.length; i++) {
      this.pool[i].el.style.display = 'none';
    }
  }

  private renderLabel(
    used: number,
    worldX: number, worldY: number, worldZ: number,
    worldHalfExtent: number,
    text: string,
  ): number {
    if (!this.projector.project(worldX, worldY, worldZ, this._scratch)) return used;
    const scale = this.projector.worldToScreenScale(worldX, worldY, worldZ);
    if (scale <= 0) return used;

    // Anchor above the entity's top edge — above where the HP bar sits. Use
    // world units for padding so the label stays at a sensible offset as the
    // camera zooms (same convention the HP bar uses).
    const topPx =
      this._scratch.y
      - worldHalfExtent * scale
      - SELECTION_LABEL_STYLE.paddingWorldUnits * scale;

    const label = this.acquire(used);
    if (label.lastText !== text) {
      label.el.textContent = text;
      label.lastText = text;
    }
    // Anchor = bottom-center of the label: translate by -50% X to center, -100% Y
    // so the bottom of the label box sits on (scratch.x, topPx).
    label.el.style.transform =
      `translate3d(${this._scratch.x}px, ${topPx}px, 0) translate(-50%, -100%)`;

    return used + 1;
  }

  destroy(): void {
    this.root.remove();
    this.pool.length = 0;
  }
}
