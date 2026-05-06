// Mirror panel cache builder — single source of truth for the
// per-unit `entity.unit.mirrorPanels` array. Called once at entity
// creation by both the authoritative sim (WorldState.createUnitFromBlueprint)
// and the client-side hydration path (NetworkEntityFactory.createUnitFromNetwork)
// so beam-vs-mirror collision uses the exact same canonical rectangles
// on host and client.
//
// The mirror panel is a square slab sized from radius.body, mounted at
// ARM'S LENGTH from the turret body sphere along the turret's facing
// direction. Vertical position comes from the mirror turret's
// blueprint-authored 3D mount so panel collision and visuals stay
// attached to the same pivot as the turret.
// Visual side support rails are rendered from the same panel sizing;
// the sim only needs the panel center offset (offsetX = arm length,
// offsetY = 0) and angle = 0 (panel normal = turret yaw direction).

import type { CachedMirrorPanel } from '../../types/sim';
import type { UnitBlueprint } from '../../types/blueprints';
import { getTurretBlueprint } from './blueprints';
import { applySurfaceTilt } from './terrain/terrainSurface';

type SurfaceNormal = { nx: number; ny: number; nz: number };

const _FLAT_NORMAL: SurfaceNormal = { nx: 0, ny: 0, nz: 1 };

/** Forward arm length (from turret body center to panel center) as a
 *  multiple of unit radius.body. 1.0 puts the panel center at the
 *  body edge; bigger values stretch the support rails further out. */
export const MIRROR_ARM_LENGTH_MULT = 1.8;

/** Mirror panel size multiplier. Scales BOTH the sim collision
 *  rectangle (`halfWidth` / `halfHeight`) and the rendered plane —
 *  Render3DEntities reads `mirrorPanels[0].halfWidth` directly so a
 *  bump here flows through to the visual panel without any other
 *  edit. 1.0 = legacy "panel side = 2 × radius.body". */
export const MIRROR_PANEL_SIZE_MULT = 2.0;

/** Mirror frame geometry derived from `panelHalfSide` (= radius.body
 *  × MIRROR_PANEL_SIZE_MULT).
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
 *  Single source of truth shared by `MirrorMesh3D` (live mirror) and
 *  `Debris3D` (post-death debris) so the dead-mirror tumbling pieces
 *  always match the live silhouette. Past drift bug:
 *  Debris3D fell out of sync when MirrorMesh3D's constants moved. */
export type MirrorFrameGeometry = {
  side: number;
  supportDiameter: number;
  supportRadius: number;
  frameSegmentLength: number;
  frameZ: number;
};

export function getMirrorFrameGeometry(panelHalfSide: number): MirrorFrameGeometry {
  const side = panelHalfSide * 2;
  const supportDiameter = Math.max(panelHalfSide * 0.075, 0.34);
  const supportRadius = supportDiameter * 0.5;
  const frameSegmentLength = side / 3;
  const frameZ = panelHalfSide + supportRadius;
  return { side, supportDiameter, supportRadius, frameSegmentLength, frameZ };
}

/** Compute the rigid mirror arm's panel CENTER in world coords. The
 *  arm extends from `(pivotX, pivotY, pivotZ)` along the chassis-local
 *  3D direction
 *
 *      a_local(α, β) = (cos α · cos β, sin α · cos β, sin β)
 *
 *  and is then ROTATED by the host's chassis tilt (surface normal) so
 *  the panel rides with the unit on slopes. (α, β) are chassis-local
 *  angles — the same numbers stored on `weapon.rotation` /
 *  `weapon.pitch`.
 *
 *  SINGLE SOURCE OF TRUTH for the rigid-arm extend formula — shared
 *  by the aim solver (iterating panel-center for bisector refinement),
 *  the panel hit test (collision), and the debris emitter. Pass
 *  `surfaceNormal: undefined` to get the flat-ground fast path.
 *
 *  `out` is mutated and returned to keep this allocation-free in the
 *  per-tick aim-solver loop. */
export function getMirrorPanelCenter(
  pivotX: number, pivotY: number, pivotZ: number,
  armLength: number,
  mirrorYaw: number, mirrorPitch: number,
  surfaceNormal: SurfaceNormal | undefined,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const cosYaw = Math.cos(mirrorYaw);
  const sinYaw = Math.sin(mirrorYaw);
  const cosPitch = Math.cos(mirrorPitch);
  const sinPitch = Math.sin(mirrorPitch);
  // Chassis-local arm vector before tilt.
  const ax = cosYaw * cosPitch * armLength;
  const ay = sinYaw * cosPitch * armLength;
  const az = sinPitch * armLength;
  const tilted = applySurfaceTilt(ax, ay, az, surfaceNormal ?? _FLAT_NORMAL);
  out.x = pivotX + tilted.x;
  out.y = pivotY + tilted.y;
  out.z = pivotZ + tilted.z;
  return out;
}

/** Unit-length arm direction in WORLD frame for the same (yaw, pitch,
 *  surfaceNormal) pose `getMirrorPanelCenter` extends along. The
 *  panel's face normal IS this direction (panel face perpendicular to
 *  the arm), so the hit test reaches for the same vector instead of
 *  recomputing the components inline. Mutates `out` and returns it. */
export function getMirrorArmDirection(
  mirrorYaw: number, mirrorPitch: number,
  surfaceNormal: SurfaceNormal | undefined,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const cosYaw = Math.cos(mirrorYaw);
  const sinYaw = Math.sin(mirrorYaw);
  const cosPitch = Math.cos(mirrorPitch);
  const sinPitch = Math.sin(mirrorPitch);
  const ax = cosYaw * cosPitch;
  const ay = sinYaw * cosPitch;
  const az = sinPitch;
  const tilted = applySurfaceTilt(ax, ay, az, surfaceNormal ?? _FLAT_NORMAL);
  out.x = tilted.x;
  out.y = tilted.y;
  out.z = tilted.z;
  return out;
}

/** Mirror arm pivot — the turret pivot point the rigid arm extends
 *  from. Built from the chassis-local panel offsets (`offsetY` lateral
 *  to chassis forward, panel midY along chassis-local up) rotated
 *  through the host's chassis tilt and added to the host's ground
 *  anchor. Pass `surfaceNormal: undefined` for the flat-ground fast
 *  path. Mutates `out` and returns it. */
export function getMirrorPivot(
  unitX: number, unitY: number, unitGroundZ: number,
  /** Chassis-perpendicular axis (unit length) — pre-computed by the
   *  caller from the unit yaw to avoid redundant trig. */
  perpX: number, perpY: number,
  panel: CachedMirrorPanel,
  surfaceNormal: SurfaceNormal | undefined,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  // Chassis-local pivot offset: lateral component along the chassis
  // perpendicular direction (which is itself in chassis-tilted XY,
  // already), and vertical component along chassis-local +Z. The
  // tilt rotates ALL of it, so a steeply-banked unit has its mirror
  // pivot riding sideways with the body just like the head sphere.
  const localX = perpX * panel.offsetY;
  const localY = perpY * panel.offsetY;
  // panel.baseY/topY are authored at zero pitch in chassis-local up,
  // so their midpoint is the chassis-local pivot height.
  const localZ = (panel.baseY + panel.topY) / 2;
  const tilted = applySurfaceTilt(localX, localY, localZ, surfaceNormal ?? _FLAT_NORMAL);
  out.x = unitX + tilted.x;
  out.y = unitY + tilted.y;
  out.z = unitGroundZ + tilted.z;
  return out;
}

/** Mutates `panelsOut` (push), returns the bound radius the caller
 *  should assign to `unit.mirrorBoundRadius`. Returns 0 when the
 *  blueprint declares no mirror-bearing turrets. */
export function buildMirrorPanelCache(
  bp: UnitBlueprint,
  panelsOut: CachedMirrorPanel[],
): number {
  const unitBodyRadius = bp.radius.body;
  const halfSide = unitBodyRadius * MIRROR_PANEL_SIZE_MULT;
  const armLength = unitBodyRadius * MIRROR_ARM_LENGTH_MULT;
  let mirrorBoundRadius = 0;

  for (const mount of bp.turrets) {
    const tb = getTurretBlueprint(mount.turretId);
    if (!tb.mirrorPanels) continue;
    const centerY = mount.mount.z * unitBodyRadius;
    const baseY = centerY - halfSide;
    const topY = centerY + halfSide;

    for (let i = 0; i < tb.mirrorPanels.length; i++) {
      panelsOut.push({
        halfWidth: halfSide,
        // Panel center sits forward of the turret pivot by armLength
        // along the turret's local +X axis. The world-space yaw of
        // that offset is the mirror turret's rotation, applied at
        // collision time in MirrorPanelHit.findClosestPanelHit.
        offsetX: armLength,
        offsetY: 0,
        angle: 0,
        baseY,
        topY,
      });
      // Bound radius covers everything from the unit center out to
      // the far edge of the panel: arm length + half-diagonal of the
      // square. Conservative, but it's only used for broadphase
      // culling so a slight over-estimate is fine.
      const farEdge = armLength + halfSide;
      if (farEdge > mirrorBoundRadius) mirrorBoundRadius = farEdge;
    }
  }

  return mirrorBoundRadius;
}
