// Force-field panel cache builder — single source of truth for the
// per-unit `entity.unit.shieldPanels` array. Called once at entity
// creation by both the authoritative sim (WorldState.createUnitFromBlueprint)
// and the client-side hydration path (NetworkEntityFactory.createUnitFromNetwork)
// so beam-vs-mirror collision uses the exact same canonical rectangles
// on host and client.
//
// The shield panel is a square slab sized from radius.other and mounted
// from the host's turret mount. The material lives on the shield shot;
// this cache only materializes the mount-authored geometry into runtime units.
// Visual side support rails are rendered from the same panel sizing;
// the sim only needs the panel center offset and angle.

import type { CachedShieldPanel } from '../../types/sim';
import type { UnitBlueprint } from '../../types/blueprints';

/** Force-field panel size multiplier. Scales BOTH the sim collision
 *  rectangle (`halfWidth` / `halfHeight`) and the rendered plane —
 *  Render3DEntities reads `shieldPanels[0].halfWidth` directly so a
 *  bump here flows through to the visual panel without any other
 *  edit. 1.0 = legacy "panel side = 2 × radius.other". */
export const SHIELD_PANEL_SIZE_MULT = 2.0;

/** Mirror frame geometry derived from `panelHalfSide` (= radius.other
 *  × SHIELD_PANEL_SIZE_MULT).
 *
 *  - `side`              — full panel edge length (= 2 × halfSide).
 *  - `supportDiameter`   — diameter of the cylindrical side grabbers.
 *                          Floor of 0.34 keeps tiny units visible.
 *  - `supportRadius`     — half of `supportDiameter`.
 *  - `frameSegmentLength`— length of each grabber segment (panel side / 3).
 *  - `frameZ`            — chassis-local Z of each grabber's centerline
 *                          (offset out from the panel face by half the
 *                          support diameter).
 *
 *  Single source of truth for `ShieldPanelMesh3D`; death disassembly throws
 *  those exact live panel/frame parts, so no second geometry description can
 *  drift away from the rendered silhouette. */
type MirrorFrameGeometry = {
  side: number;
  supportDiameter: number;
  supportRadius: number;
  frameSegmentLength: number;
  frameZ: number;
};

export function getShieldFrameGeometry(panelHalfSide: number): MirrorFrameGeometry {
  const side = panelHalfSide * 2;
  const supportDiameter = Math.max(panelHalfSide * 0.075, 0.34);
  const supportRadius = supportDiameter * 0.5;
  const frameSegmentLength = side / 3;
  const frameZ = panelHalfSide + supportRadius;
  return { side, supportDiameter, supportRadius, frameSegmentLength, frameZ };
}

/** Mutates `panelsOut` (push), returns the bound radius the caller
 *  should assign to `unit.shieldBoundRadius`. Returns 0 when the
 *  blueprint declares no mirror-bearing turrets. */
export function buildShieldPanelCache(
  bp: UnitBlueprint,
  panelsOut: CachedShieldPanel[],
): number {
  const unitBodyRadius = bp.radius.other;
  const halfSide = unitBodyRadius * SHIELD_PANEL_SIZE_MULT;
  let shieldBoundRadius = 0;

  for (const mount of bp.turrets) {
    const panels = mount.shieldPanels ?? [];
    if (panels.length === 0) continue;
    const centerY = mount.mount.z * unitBodyRadius;
    const baseY = centerY - halfSide;
    const topY = centerY + halfSide;

    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i];
      const panelArmLength = panel.offsetX * unitBodyRadius;
      const panelOffsetY = panel.offsetY * unitBodyRadius;
      panelsOut.push({
        halfWidth: halfSide,
        offsetX: panelArmLength,
        offsetY: panelOffsetY,
        angle: panel.angle,
        baseY,
        topY,
      });
      // Bound radius covers everything from the unit center out to
      // the far edge of the panel: arm length + half-diagonal of the
      // square. Conservative, but it's only used for broadphase
      // culling so a slight over-estimate is fine.
      const farEdge = panelArmLength + Math.abs(panelOffsetY) + halfSide;
      if (farEdge > shieldBoundRadius) shieldBoundRadius = farEdge;
    }
  }

  return shieldBoundRadius;
}
