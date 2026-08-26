// GroundPrintLayout3D — where a unit touches the ground, from its BLUEPRINT.
//
// Ground prints used to read their contact points off the locomotion rig
// (wheel and tread samplers, IK feet). A rig only exists down to the detail
// rung that draws locomotion; below it the unit is a proxy with no rig at
// all, so marks simply stopped and a zoomed-out army walked without leaving
// a trace — the gaps the player found on zooming back in. The rig was also
// the reason only rovers, tanks and crawlers ever marked the ground.
//
// The contact points are a property of the unit, not of its mesh: the same
// authored mounts the rig builds from. This resolves them once per
// blueprint+radius so GroundPrint3D can place every mark from the unit's
// pose alone, at every rung, for every ground locomotion type.
//
// Trails (wheels, treads) are exact — the rig placed its samplers at these
// same mounts. Stamps (feet, flippers) describe a rest foothold and a
// stride: with a rig present its real planted feet are used instead; without
// one the stride reproduces the gait's cadence from distance travelled.

import type { Entity } from '../sim/types';
import { getUnitBlueprint } from '../sim/blueprints';
import { resolveMirroredLegConfigs } from '../math/LegLayout';
import { LEG_FOOT_RADIUS_MULTIPLIER } from './LocomotionRigShared3D';

export type GroundPrintTrailContact = Readonly<{
  /** Chassis-local: X forward, Z lateral (blueprint y), world units. */
  localX: number;
  localZ: number;
  width: number;
}>;

/** The mark one foothold leaves, sized to the part that touches the ground:
 *  a sphere foot or a pointed leg tip leaves a round print; a sole or a
 *  stroking flipper leaves an oriented rectangle (length along the unit's
 *  heading, width across it). Sizes are final print sizes. */
export type GroundPrintStampShape =
  | Readonly<{ kind: 'circle'; radius: number }>
  | Readonly<{ kind: 'rect'; halfLength: number; halfWidth: number }>;

export type GroundPrintStampContact = Readonly<{
  localX: number;
  localZ: number;
  shape: GroundPrintStampShape;
  /** Ground distance one foothold covers before the foot plants again. */
  stride: number;
  /** Alternating pairs: 1 starts half a stride behind 0. */
  phase01: 0 | 1;
}>;

/** A sphere foot compacts soil a little past its own radius. This is the
 *  crawler print size the marks were tuned at. */
const SPHERE_FOOT_PRINT_MULT = 1.35;
/** A sole squashes soil just past its outline. */
const SOLE_PRINT_MULT = 1.1;

export type GroundPrintLayout = Readonly<{
  trails: readonly GroundPrintTrailContact[];
  stamps: readonly GroundPrintStampContact[];
}>;

const layoutCache = new Map<string, GroundPrintLayout | null>();

/** The unit's ground contacts, or null when the unit never touches the
 *  ground with anything that marks it (air, hover, submarine). */
export function resolveGroundPrintLayout(entity: Entity): GroundPrintLayout | null {
  const unit = entity.unit;
  if (!unit) return null;
  const r = unit.radius.other;
  const key = `${unit.unitBlueprintId}:${r}`;
  const cached = layoutCache.get(key);
  if (cached !== undefined) return cached;
  let layout: GroundPrintLayout | null = null;
  try {
    layout = buildLayout(unit.unitBlueprintId, r);
  } catch {
    layout = null;
  }
  layoutCache.set(key, layout);
  return layout;
}

function buildLayout(blueprintId: string, r: number): GroundPrintLayout | null {
  const loc = getUnitBlueprint(blueprintId).unitLocomotion;
  if (!loc) return null;
  switch (loc.type) {
    case 'rover': {
      // Mirrors RoverRig3D: the rut is narrower than the tyre — tyres
      // squash the soil under their contact patch, not the full width.
      const tireWidth = Math.max(0.5, r * loc.config.treadWidth);
      const width = Math.max(0.5, tireWidth * 0.65);
      return {
        trails: loc.config.mounts.map((mount) => ({
          localX: r * mount.xUnitRadiusRatio,
          localZ: r * mount.yUnitRadiusRatio,
          width,
        })),
        stamps: [],
      };
    }
    case 'tank':
    case 'amphibious-tank': {
      // Mirrors TankRig3D: the whole belt presses ground.
      const width = Math.max(0.5, r * loc.config.treadWidth);
      return {
        trails: loc.config.mounts.map((mount) => ({
          localX: r * mount.xUnitRadiusRatio,
          localZ: r * mount.yUnitRadiusRatio,
          width,
        })),
        stamps: [],
      };
    }
    case 'crawler': {
      const cfg = loc.config;
      const { left, all, sides } = resolveMirroredLegConfigs(cfg, r);
      const legRadius = Math.max(cfg.radius, 1) * 0.6;
      // With feet the leg ends in a sphere of LEG_FOOT_RADIUS_MULTIPLIER x
      // the leg radius; without, the lower segment tapers to a point that
      // only dents the ground (Daddy, Tick).
      const shape: GroundPrintStampShape = cfg.hasFeet
        ? { kind: 'circle', radius: legRadius * LEG_FOOT_RADIUS_MULTIPLIER * SPHERE_FOOT_PRINT_MULT }
        : { kind: 'circle', radius: Math.max(1.1, legRadius * 0.6) };
      const stamps: GroundPrintStampContact[] = [];
      for (let i = 0; i < all.length; i++) {
        const leg = all[i];
        const side = sides[i];
        // Same alternating diagonal-pair pattern buildCrawler bakes.
        const sideIndex = i < left.length ? i : i - left.length;
        const sideParity = side === 1 ? 1 : 0;
        const phase01 = ((sideIndex & 1) ^ sideParity) as 0 | 1;
        // The foothold's home is the rig's snap-sphere centre: the
        // attachment pushed outward along its own ray by the authored
        // fraction of the leg. A foot steps once it leaves that sphere, so
        // one stride is the sphere's diameter.
        const total = leg.upperLegLength + leg.lowerLegLength;
        const attachX = leg.attachOffsetX;
        const attachZ = leg.attachOffsetY;
        const attachDistance = Math.hypot(attachX, attachZ);
        const rayX = attachDistance > 1e-6 ? attachX / attachDistance : 0;
        const rayZ = attachDistance > 1e-6 ? attachZ / attachDistance : side;
        const originRatio = Math.max(0, Math.min(1, leg.footSphereOriginExtensionRatio));
        stamps.push({
          localX: attachX + rayX * total * originRatio,
          localZ: attachZ + rayZ * total * originRatio,
          shape,
          stride: Math.max(2, total * Math.max(0, leg.footSphereRadiusLegLengthRatio) * 2),
          phase01,
        });
      }
      return { trails: [], stamps };
    }
    case 'bot': {
      // Mirrors BotRig3D: each foot touches down half a stride ahead of its
      // hip and plants once per gait cycle; the left leg leads by half.
      const legs = loc.config.legs;
      const legLength = r * (
        legs.segments.upper.lengthUnitRadiusRatio + legs.segments.lower.lengthUnitRadiusRatio
      );
      const stepLength = Math.max(1, legLength * legs.strideLengthRatio);
      const gaitCycleDistance = stepLength * 0.48 * 4;
      const halfStride = gaitCycleDistance * 0.25;
      const footLength = legLength * legs.footLengthRatio;
      const footWidth = legs.radius * legs.footWidthRatio;
      // The sole BotRig3D's makeFoot lays down: 0.80 x 0.90 of the authored
      // foot box, a rectangle pointing the way the leg does.
      const shape: GroundPrintStampShape = {
        kind: 'rect',
        halfLength: Math.max(1, footLength * 0.8 * 0.5 * SOLE_PRINT_MULT),
        halfWidth: Math.max(0.6, footWidth * 0.9 * 0.5 * SOLE_PRINT_MULT),
      };
      const hipX = r * legs.hip.xUnitRadiusRatio;
      const hipHalfTrack = r * legs.hip.yUnitRadiusRatio;
      return {
        trails: [],
        stamps: ([-1, 1] as const).map((side) => ({
          localX: hipX + halfStride,
          localZ: side * hipHalfTrack,
          shape,
          stride: gaitCycleDistance,
          phase01: side > 0 ? 1 : 0,
        })),
      };
    }
    case 'amphibian': {
      // Mirrors AmphibianRig3D's land gait: four flippers on a shared
      // distance cycle, front-left with rear-right, each panel hinged at
      // its mount and swept fore-aft about the vertical by the authored
      // ground sweep. The outer part of the panel drags, so each stroke
      // leaves a smear ALONG the body — as long as the tip's sweep, as
      // wide as the tip chord.
      const cfg = loc.config;
      const cycleDistance = Math.max(1, r * cfg.cycleDistanceFrac);
      const tipChord = Math.max(0.25, r * cfg.tipChordFrac);
      const sweepSin = Math.sin(Math.max(0, cfg.groundSweepAngleDeg) * Math.PI / 180);
      return {
        trails: [],
        stamps: cfg.mounts.map((mount) => {
          const offset = mount.offset;
          const side = offset.yUnitRadiusRatio < 0 ? -1 : 1;
          const front = offset.xUnitRadiusRatio >= 0;
          const phase01 = (((front ? 0 : 1) ^ (side === 1 ? 1 : 0)) as 0 | 1);
          const length = r * mount.lengthFrac;
          return {
            localX: r * offset.xUnitRadiusRatio,
            localZ: r * offset.yUnitRadiusRatio + side * length * 0.8,
            shape: {
              kind: 'rect',
              halfLength: Math.max(1, length * 0.8 * sweepSin),
              halfWidth: Math.max(0.6, tipChord * 0.5),
            },
            stride: cycleDistance,
            phase01,
          };
        }),
      };
    }
    case 'drone':
    case 'plane':
    case 'submarine':
    case 'aerosub':
      return null;
  }
}
