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

export type GroundPrintStampContact = Readonly<{
  localX: number;
  localZ: number;
  /** Foot radius before the stamp's own circle multiplier. */
  footRadius: number;
  /** Ground distance one foothold covers before the foot plants again. */
  stride: number;
  /** Alternating pairs: 1 starts half a stride behind 0. */
  phase01: 0 | 1;
}>;

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
      const footRadius = legRadius * LEG_FOOT_RADIUS_MULTIPLIER;
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
          footRadius,
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
      const footRadius = Math.max(1, Math.max(footLength, footWidth) * 0.5);
      const hipX = r * legs.hip.xUnitRadiusRatio;
      const hipHalfTrack = r * legs.hip.yUnitRadiusRatio;
      return {
        trails: [],
        stamps: ([-1, 1] as const).map((side) => ({
          localX: hipX + halfStride,
          localZ: side * hipHalfTrack,
          footRadius,
          stride: gaitCycleDistance,
          phase01: side > 0 ? 1 : 0,
        })),
      };
    }
    case 'amphibian': {
      // Mirrors AmphibianRig3D's land gait: four flippers sweeping on a
      // shared distance cycle, front-left with rear-right. Each stroke
      // leaves a drag mark under the panel's outer half.
      const cfg = loc.config;
      const cycleDistance = Math.max(1, r * cfg.cycleDistanceFrac);
      const footRadius = Math.max(1, r * cfg.rootChordFrac * 0.35);
      return {
        trails: [],
        stamps: cfg.mounts.map((mount) => {
          const offset = mount.offset;
          const side = offset.yUnitRadiusRatio < 0 ? -1 : 1;
          const front = offset.xUnitRadiusRatio >= 0;
          const phase01 = (((front ? 0 : 1) ^ (side === 1 ? 1 : 0)) as 0 | 1);
          return {
            localX: r * offset.xUnitRadiusRatio,
            localZ: r * offset.yUnitRadiusRatio + side * r * mount.lengthFrac * 0.6,
            footRadius,
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
