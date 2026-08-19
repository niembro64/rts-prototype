/**
 * Where a builder's work spray leaves its host.
 *
 * One derivation, two consumers. The simulation resolves this every fixed
 * tick to author the spray's authoritative source point; the client
 * presentation layer resolves the SAME function every render frame so the
 * stream stays attached to a builder that is moving between snapshots.
 *
 * That second caller is the reason this is a shared helper rather than a
 * private detail of commanderAbilities: a spray's world points ride the
 * presentation snapshot, which is far slower than the render loop
 * (architecture.json authors 5 Hz), so a commander driving across the map
 * left its own build spray standing still. Continuous world positions must
 * come from the interpolated pose, not from whatever tick last shipped —
 * see budget_design_philosophy.html, "One clock owns all continuous root
 * pose".
 *
 * Every input is live entity state: the host transform, its surface normal
 * and body orientation, and — for an articulated arm — the authoritative
 * local yaw/pitch that travel on the wire. Nothing here reads the tick-stamped
 * socket the articulation pass caches, precisely so a caller that is between
 * ticks still gets the right answer.
 */

import type { Vec3 } from '@/types/vec2';
import type { WorkEmitterSpec } from '@/types/constructionTypes';
import { getTransformCosSin } from '../math/MathHelpers';
import { getBuildingBlueprint, getUnitBlueprint } from './blueprints';
import { writeWorkEmitterSocketWorld } from './workStationSystem';
import type { Entity } from './types';

/** The authored work-emitter block for a host, or null when it has none. */
export function getWorkEmitterSpec(entity: Entity): WorkEmitterSpec | null {
  if (entity.unit !== null) {
    return getUnitBlueprint(entity.unit.unitBlueprintId).workEmitter ?? null;
  }
  if (entity.buildingBlueprintId !== null) {
    return getBuildingBlueprint(entity.buildingBlueprintId).workEmitter ?? null;
  }
  return null;
}

/**
 * Resolve one work-emitter point in world space from the host's current pose.
 *
 * An articulated emitter (the Commander's construction arm is the only one
 * today) rides its solved forearm socket; every other emitter is an authored
 * body-local point turned by the host's own transform.
 */
export function writeWorkEmitterOriginWorld(
  source: Entity,
  pointIndex: number,
  out: Vec3,
): Vec3 {
  const spec = getWorkEmitterSpec(source);
  const station = source.builder?.workStation ?? null;
  if (
    spec !== null &&
    station !== null &&
    pointIndex === 0 &&
    spec.attachment.kind === 'botArm'
  ) {
    return writeWorkEmitterSocketWorld(source, station, spec, out);
  }
  const point = spec?.points[pointIndex] ?? spec?.points[0];
  if (point === undefined) {
    out.x = source.transform.x;
    out.y = source.transform.y;
    out.z = source.transform.z;
    return out;
  }
  const scale = source.unit?.radius.other ?? 1;
  const localX = point.x * scale;
  const localY = point.y * scale;
  const { cos, sin } = getTransformCosSin(source.transform);
  out.x = source.transform.x + localX * cos - localY * sin;
  out.y = source.transform.y + localX * sin + localY * cos;
  out.z = source.transform.z + point.z * scale;
  return out;
}
