// UnitDebrisProfile3D — canonical pre-derivation of the geometry the
// death-debris renderer needs to spawn one piece per atomic visual part
// of a unit (treads, wheels, leg segments, turret heads, barrels, mirror
// panels, chassis edge slabs).
//
// Why this exists: Debris3D used to read unit / turret / shot blueprints
// directly inside its template builder, which made debris a second
// renderer-specific interpretation of the same visual structure that
// Render3DEntities / Locomotion3D / BodyShape3D already build. This
// module concentrates that interpretation in one place: the profile is
// the single place that turns blueprints into the debris-shaped
// fragment list, and Debris3D becomes a pure consumer that just pose-
// rotates the per-turret pieces and emits the rest verbatim.
//
// Coordinate system: every fragment is in chassis-local sim coords
// (+X forward, +Y left, +Z up). Body yaw is applied at debris emit
// time by Debris3D.spawn from `ctx.rotation`; per-turret yaw and
// pitch come from `ctx.turretPoses[ti]`.

import { type DebrisBarrelProfile, getDebrisBarrelProfile } from './DebrisBarrelProfile3D';
import { getBodyEdgeTemplates } from './BodyShape3D';
import {
  TREAD_CHASSIS_LIFT_Y,
  getChassisLiftY,
  getSegmentMidYAt,
} from '../math/BodyDimensions';
import { resolveMirroredLegConfigs } from '../math/LegLayout';
import { turretBodyRadiusFromRadius } from '../math';
import {
  getTurretBlueprint,
  getUnitBlueprint,
} from '../sim/blueprints';
import {
  MIRROR_ARM_LENGTH_MULT,
  MIRROR_PANEL_SIZE_MULT,
  getMirrorFrameGeometry,
} from '../sim/mirrorPanelCache';

// Must match Locomotion3D. Tread height and chassis lift share one value.
const TREAD_Y = TREAD_CHASSIS_LIFT_Y / 2;
const FOOT_Y = 1;

/** Logical color category — Debris3D resolves to a real RGB number at
 *  emission time so the profile module doesn't need to import any of
 *  the renderer's constant palettes. */
export type DebrisColorRole =
  | 'primary'        // unit player color (chassis edges, turret head, mirror arms/grabbers)
  | 'tread'
  | 'wheel'
  | 'leg'
  | 'barrel'
  | 'mirrorPanel';

export type DebrisStaticFragment =
  | {
      kind: 'box';
      x: number; y: number; z: number;
      yaw: number;
      sx: number; sy: number; sz: number;
      color: DebrisColorRole;
    }
  | {
      kind: 'cyl';
      ax: number; ay: number; az: number;
      bx: number; by: number; bz: number;
      thickness: number;
      color: DebrisColorRole;
    };

export interface DebrisMirrorPanelProfile {
  panelCount: number;
  armLength: number;
  side: number;
  supportDiameter: number;
  supportRadius: number;
  frameSegmentLength: number;
  frameZ: number;
  panelCenterY: number;
}

export interface DebrisTurretMount {
  /** Mount X in chassis-local (already scaled by unit radius). */
  mountX: number;
  /** Mount Z in chassis-local (sim Y). */
  mountZ: number;
  /** Mount vertical offset (sim Z) — head + barrel pivot height. */
  shotHeight: number;
  /** Visual radius of the turret head sphere. */
  headRadius: number;
  /** Mirror-host turrets skip their head/barrels (the mirror panels
   *  are the visible body); the consumer respects this flag. */
  isMirrorHost: boolean;
  /** Pre-resolved barrel geometry (shot-width / barrel-thickness /
   *  cone orbits) — null when the turret has no visible barrel. */
  barrelProfile: DebrisBarrelProfile | null;
  /** Pre-resolved mirror panel dimensions (panel count, arm length,
   *  support cylinder radii) — null when the turret has no panels. */
  mirrorPanels: DebrisMirrorPanelProfile | null;
}

/** Slot in the per-bp.turrets-index array. `null` slots correspond to
 *  blueprint mounts that produce no debris (missing turret blueprint,
 *  construction emitters), and exist only so that `ctx.turretPoses[ti]`
 *  lookups stay aligned with the original bp.turrets indexing. */
export type DebrisTurretSlot = DebrisTurretMount | null;

export interface DebrisUnitProfile {
  /** Vertical lift of the chassis above the ground plane — used by
   *  consumers to position chassis-relative fragments (mirror panels
   *  baseline, body edges) and to apply the same lift Locomotion3D
   *  did to the live mesh. */
  chassisLiftY: number;
  /** Pose-INDEPENDENT fragments — locomotion parts and body edges.
   *  Debris3D emits each one verbatim, applying only the body yaw
   *  from the death context. */
  staticFragments: DebrisStaticFragment[];
  /** Pose-DEPENDENT turret mounts — Debris3D applies the live
   *  per-turret yaw + pitch to position barrels and mirror panels. */
  turretMounts: DebrisTurretSlot[];
}

/** Build the complete debris-fragment derivation for one unit type at
 *  a given visual radius. Returns `null` when the unit blueprint
 *  cannot be resolved — callers should fall back to a generic
 *  scatter pattern. */
export function getDebrisUnitProfile(
  unitType: string,
  r: number,
): DebrisUnitProfile | null {
  let bp;
  try {
    bp = getUnitBlueprint(unitType);
  } catch {
    return null;
  }

  const chassisLiftY = getChassisLiftY(bp, r);
  const staticFragments: DebrisStaticFragment[] = [];

  // --- Locomotion ---
  const loc = bp.locomotion;
  if (loc?.type === 'treads') {
    // Each side's full tread slab — same size the 3D locomotion draws.
    const cfg = loc.config;
    const length = r * cfg.treadLength;
    const width = r * cfg.treadWidth;
    const offset = r * cfg.treadOffset;
    for (const side of [-1, 1]) {
      staticFragments.push({
        kind: 'box',
        x: 0, y: TREAD_Y, z: side * offset,
        yaw: 0,
        sx: length, sy: TREAD_CHASSIS_LIFT_Y, sz: width,
        color: 'tread',
      });
    }
  } else if (loc?.type === 'wheels') {
    // Four corner wheels as short tire cylinders (matches the live
    // renderer's buildWheels — axle along the unit's lateral axis,
    // radius = r·wheelRadius, width = r·treadWidth).
    const cfg = loc.config;
    const wheelR = Math.max(1, r * cfg.wheelRadius);
    const tireWidth = Math.max(0.5, r * cfg.treadWidth);
    const fx = r * cfg.wheelDistX;
    const fz = r * cfg.wheelDistY;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        staticFragments.push({
          kind: 'cyl',
          ax: sx * fx, ay: wheelR, az: sz * fz - tireWidth / 2,
          bx: sx * fx, by: wheelR, bz: sz * fz + tireWidth / 2,
          thickness: wheelR,
          color: 'wheel',
        });
      }
    }
  } else if (loc?.type === 'legs') {
    // One cylinder per upper segment + one per lower segment, placed at
    // their rest-pose hip/knee/foot positions — same math Locomotion3D
    // uses to initialize legs.
    const { all } = resolveMirroredLegConfigs(loc.config, r);
    const upperThick = Math.max(1, loc.config.upperThickness) * 0.6;
    const lowerThick = Math.max(1, loc.config.lowerThickness) * 0.6;
    for (const lc of all) {
      const hipX = lc.attachOffsetX;
      const hipZ = lc.attachOffsetY;
      // Hip Y matches Locomotion3D: either an authored absolute
      // attach height or the lifted midpoint of the body segment.
      const hipY = bp.legAttachHeightFrac !== null
        ? bp.legAttachHeightFrac * r
        : chassisLiftY + getSegmentMidYAt(bp.bodyShape, r, hipX);
      const restDist =
        (lc.upperLegLength + lc.lowerLegLength) * lc.snapDistanceMultiplier;
      const footA = lc.snapTargetAngle;
      const footX = hipX + Math.cos(footA) * restDist;
      const footZ = hipZ + Math.sin(footA) * restDist;
      // Approximate knee at the midpoint of hip↔foot, lifted up — matches
      // the visible "knee bends upward" pose from Locomotion3D.
      const kneeX = (hipX + footX) / 2;
      const kneeZ = (hipZ + footZ) / 2;
      const kneeY = hipY + lc.upperLegLength * 0.15;
      staticFragments.push({
        kind: 'cyl',
        ax: hipX, ay: hipY, az: hipZ,
        bx: kneeX, by: kneeY, bz: kneeZ,
        thickness: upperThick,
        color: 'leg',
      });
      staticFragments.push({
        kind: 'cyl',
        ax: kneeX, ay: kneeY, az: kneeZ,
        bx: footX, by: FOOT_Y, bz: footZ,
        thickness: lowerThick,
        color: 'leg',
      });
    }
  }

  // --- Turret mounts ---
  // Per-turret: head sphere (skipped on mirror hosts), barrel cylinders,
  // mirror panel slabs + arms + grabbers. Only the static dimensions
  // belong here; per-turret yaw + pitch are applied by Debris3D at
  // emission using ctx.turretPoses[ti].
  const turretMounts: DebrisTurretSlot[] = [];
  for (let ti = 0; ti < bp.turrets.length; ti++) {
    const mount = bp.turrets[ti];
    let tb;
    try {
      tb = getTurretBlueprint(mount.turretId);
    } catch {
      // Keep slot aligned with bp.turrets indexing so the consumer can
      // index ctx.turretPoses by `ti`.
      turretMounts.push(null);
      continue;
    }
    if (tb.constructionEmitter) {
      turretMounts.push(null);
      continue;
    }

    const localMount = mount.mount;
    const mountX = localMount.x * r;
    const mountZ = localMount.y * r;
    // Per-turret body radius. The unit blueprint's mount is the
    // source-of-truth center for the turret sphere and barrel pivot;
    // debris uses the same mount instead of adding mirror-specific
    // vertical offsets.
    const headRadius = turretBodyRadiusFromRadius(tb.radius);
    const shotHeight = localMount.z * r;
    const isMirrorHost = (tb.mirrorPanels?.length ?? 0) > 0;

    // Mirror-host turrets skip their head + barrels — the visible body
    // is the panels themselves. Render3DEntities does the same skip.
    const barrelProfile = isMirrorHost
      ? null
      : getDebrisBarrelProfile(tb, headRadius);

    let mirrorPanels: DebrisMirrorPanelProfile | null = null;
    if (tb.mirrorPanels && tb.mirrorPanels.length > 0) {
      // Match the live mirrorPanelCache sizing so debris panels tumble
      // at the same scale they had while alive — bumping
      // MIRROR_PANEL_SIZE_MULT in mirrorPanelCache feeds through here
      // automatically.
      const armLength = r * MIRROR_ARM_LENGTH_MULT;
      const panelHalfSide = r * MIRROR_PANEL_SIZE_MULT;
      const frame = getMirrorFrameGeometry(panelHalfSide);
      // Same liftGroup convention as Render3DEntities: subtract
      // chassisLift so the live world-y lands at the blueprint-authored
      // mirror turret mount after debris adds chassisLiftY.
      const panelCenterY = localMount.z * r - chassisLiftY;
      mirrorPanels = {
        panelCount: tb.mirrorPanels.length,
        armLength,
        side: frame.side,
        supportDiameter: frame.supportDiameter,
        supportRadius: frame.supportRadius,
        frameSegmentLength: frame.frameSegmentLength,
        frameZ: frame.frameZ,
        panelCenterY,
      };
    }

    turretMounts.push({
      mountX,
      mountZ,
      shotHeight,
      headRadius,
      isMirrorHost,
      barrelProfile,
      mirrorPanels,
    });
  }

  // --- Chassis body edges ---
  // Read the per-renderer body shape (scout=diamond, tank=pentagon,
  // arachnid=two spheroids, etc.) and emit one tall slab per polygon
  // edge at the true edge position. Each fragment's `sy` mirrors the
  // body segment it came from, so debris slab heights match the live
  // unit silhouette.
  const edges = getBodyEdgeTemplates(bp.bodyShape, r);
  for (const e of edges) {
    staticFragments.push({
      kind: 'box',
      x: e.x, y: chassisLiftY + e.height / 2, z: e.z,
      yaw: e.yaw,
      sx: e.length, sy: e.height, sz: e.thickness,
      color: 'primary',
    });
  }

  return {
    chassisLiftY,
    staticFragments,
    turretMounts,
  };
}
