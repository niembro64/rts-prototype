// Force-field panel cache builder — single source of truth for the
// per-unit `entity.unit.forceFieldPanels` array. Called once at entity
// creation by both the authoritative sim (WorldState.createUnitFromBlueprint)
// and the client-side hydration path (NetworkEntityFactory.createUnitFromNetwork)
// so beam-vs-mirror collision uses the exact same canonical rectangles
// on host and client.
//
// The force-field panel is a square slab sized from radius.body and mounted
// from the host's turret mount. The material lives on the force-field shot;
// this cache only materializes the mount-authored geometry into runtime units.
// Visual side support rails are rendered from the same panel sizing;
// the sim only needs the panel center offset and angle.

import type { CachedForceFieldPanel } from '../../types/sim';
import type { UnitBlueprint } from '../../types/blueprints';

/** Forward arm length (from turret body center to panel center) as a
 *  multiple of unit radius.body. 1.0 puts the panel center at the
 *  body edge; bigger values stretch the support rails further out. */
export const FORCE_FIELD_PANEL_ARM_LENGTH_MULT = 1.8;

/** Force-field panel size multiplier. Scales BOTH the sim collision
 *  rectangle (`halfWidth` / `halfHeight`) and the rendered plane —
 *  Render3DEntities reads `forceFieldPanels[0].halfWidth` directly so a
 *  bump here flows through to the visual panel without any other
 *  edit. 1.0 = legacy "panel side = 2 × radius.body". */
export const FORCE_FIELD_PANEL_SIZE_MULT = 2.0;

/** Mirror frame geometry derived from `panelHalfSide` (= radius.body
 *  × FORCE_FIELD_PANEL_SIZE_MULT).
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
 *  Single source of truth shared by `ForceFieldPanelMesh3D` (live mirror) and
 *  `Debris3D` (post-death debris) so the dead-mirror tumbling pieces
 *  always match the live silhouette. Past drift bug:
 *  Debris3D fell out of sync when ForceFieldPanelMesh3D's constants moved. */
export type MirrorFrameGeometry = {
  side: number;
  supportDiameter: number;
  supportRadius: number;
  frameSegmentLength: number;
  frameZ: number;
};

export function getForceFieldFrameGeometry(panelHalfSide: number): MirrorFrameGeometry {
  const side = panelHalfSide * 2;
  const supportDiameter = Math.max(panelHalfSide * 0.075, 0.34);
  const supportRadius = supportDiameter * 0.5;
  const frameSegmentLength = side / 3;
  const frameZ = panelHalfSide + supportRadius;
  return { side, supportDiameter, supportRadius, frameSegmentLength, frameZ };
}

/** Compute the rigid mirror arm's panel CENTER in world coords by
 *  extending an arm of length `armLength` from `(pivotX, pivotY,
 *  pivotZ)` along the 3D direction
 *
 *      a(α, β) = (cos α · cos β,  sin α · cos β,  sin β)
 *
 *  where α = forceFieldPanelYaw and β = forceFieldPanelPitch.
 *
 *  SINGLE SOURCE OF TRUTH for the rigid-arm extend formula — shared
 *  by the aim solver, the panel hit test (collision), and the debris
 *  emitter (so dead Lorises drop debris in the same spot the live
 *  panel was). The PIVOT itself is computed differently per call site
 *  (live aim/hit-test use a chassis-tilt-aware mount from
 *  resolveWeaponWorldMount; upright fallback/debris use the body-mid-Z
 *  anchor) so the pivot stays at the call site, but the arm extension
 *  lives here.
 *
 *  `out` is mutated and returned to keep this allocation-free in the
 *  per-tick aim-solver loop. */
export function getForceFieldPanelCenter(
  pivotX: number, pivotY: number, pivotZ: number,
  armLength: number,
  forceFieldPanelYaw: number, forceFieldPanelPitch: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const cosYaw = Math.cos(forceFieldPanelYaw);
  const sinYaw = Math.sin(forceFieldPanelYaw);
  const cosPitch = Math.cos(forceFieldPanelPitch);
  const sinPitch = Math.sin(forceFieldPanelPitch);
  out.x = pivotX + cosYaw * cosPitch * armLength;
  out.y = pivotY + sinYaw * cosPitch * armLength;
  out.z = pivotZ + sinPitch * armLength;
  return out;
}

/** Unit-length arm direction `a(α, β)` from the same `(yaw, pitch)`
 *  pose `getForceFieldPanelCenter` extends along. The panel's face normal
 *  IS this direction (panel face is perpendicular to the arm), so the
 *  hit test reaches for the same vector instead of recomputing the
 *  components inline. Mutates `out` and returns it. */
export function getMirrorArmDirection(
  forceFieldPanelYaw: number, forceFieldPanelPitch: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const cosYaw = Math.cos(forceFieldPanelYaw);
  const sinYaw = Math.sin(forceFieldPanelYaw);
  const cosPitch = Math.cos(forceFieldPanelPitch);
  const sinPitch = Math.sin(forceFieldPanelPitch);
  out.x = cosYaw * cosPitch;
  out.y = sinYaw * cosPitch;
  out.z = sinPitch;
  return out;
}

/** Upright (slope-IGNORANT) mirror arm pivot — the turret pivot point
 *  the rigid arm extends from, computed from the chassis-local panel
 *  cache + the unit's ground anchor. Used by the hit test
 *  (`ForceFieldPanelHit.findClosestPanelHit`) when no slope-aware pivot is
 *  supplied, plus debris/fallback code.
 *
 *  Live mirror aim and hit-test paths prefer the tilt-aware runtime
 *  turret mount. This helper remains the stable fallback for callers
 *  that do not have a turret entity/mount available. Mutates `out`
 *  and returns it. */
export function getMirrorUprightPivot(
  unitX: number, unitY: number, unitGroundZ: number,
  /** Chassis-perpendicular axis (unit length) — pre-computed by the
   *  caller from the unit yaw to avoid redundant trig. */
  perpX: number, perpY: number,
  panel: CachedForceFieldPanel,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  out.x = unitX + perpX * panel.offsetY;
  out.y = unitY + perpY * panel.offsetY;
  // panel.baseY/topY are authored at zero pitch, so their midpoint
  // is the pivot height regardless of pitch.
  out.z = unitGroundZ + (panel.baseY + panel.topY) / 2;
  return out;
}

/** Mutates `panelsOut` (push), returns the bound radius the caller
 *  should assign to `unit.forceFieldBoundRadius`. Returns 0 when the
 *  blueprint declares no mirror-bearing turrets. */
export function buildForceFieldPanelCache(
  bp: UnitBlueprint,
  panelsOut: CachedForceFieldPanel[],
): number {
  const unitBodyRadius = bp.radius.body;
  const halfSide = unitBodyRadius * FORCE_FIELD_PANEL_SIZE_MULT;
  let forceFieldBoundRadius = 0;

  for (const mount of bp.turrets) {
    const panels = mount.forceFieldPanels ?? [];
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
      if (farEdge > forceFieldBoundRadius) forceFieldBoundRadius = farEdge;
    }
  }

  return forceFieldBoundRadius;
}
