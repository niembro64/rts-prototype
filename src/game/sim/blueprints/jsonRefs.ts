import { AUDIO } from '../../../audioConfig';
import type { SoundEntry } from '../../../types/audio';
import { isObject, type JsonObject } from './jsonValidation';

type AudioRef = { $audio: string };

function isAudioRef(value: unknown): value is AudioRef {
  return isObject(value) && typeof value.$audio === 'string';
}

function resolveAudioPath(path: string): SoundEntry {
  const parts = path.split('.');
  let cursor: unknown = AUDIO;
  for (const part of parts) {
    if (!isObject(cursor) || !(part in cursor)) {
      throw new Error(`Invalid blueprint audio reference: ${path}`);
    }
    cursor = cursor[part];
  }
  if (!isObject(cursor) || typeof cursor.synth !== 'string') {
    throw new Error(`Blueprint audio reference does not resolve to a SoundEntry: ${path}`);
  }
  return cursor as SoundEntry;
}

export function resolveBlueprintRefs<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => resolveBlueprintRefs(item)) as T;
  }
  if (isAudioRef(value)) {
    return resolveAudioPath(value.$audio) as T;
  }
  if (!isObject(value)) return value;

  const resolved: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    resolved[key] = resolveBlueprintRefs(child);
  }
  return resolved as T;
}

type InheritableBlueprint = Record<string, unknown> & { $extends?: string };

function mergeBlueprintObjects(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override;
  if (override.$replace === true) {
    const replacement: JsonObject = {};
    for (const [key, value] of Object.entries(override)) {
      if (key === '$replace' || key === '$extends') continue;
      replacement[key] = value;
    }
    return replacement;
  }
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === '$extends' || key === '$replace') continue;
    merged[key] = isObject(value) && isObject(base[key])
      ? mergeBlueprintObjects(base[key], value)
      : value;
  }
  return merged;
}

/** Materialize explicitly inherited blueprint variants. Arrays replace while
 * nested objects merge. An object with `$replace: true` replaces its inherited
 * object wholesale (the marker itself is stripped), which keeps discriminated
 * unions such as bodyShape from retaining fields from the old variant. The
 * owning loader then applies its normal exhaustive validation. */
export function resolveBlueprintRecordInheritance<T>(
  source: Record<string, InheritableBlueprint>,
  blueprintLabel: string,
): Record<string, T> {
  const resolved: Record<string, T> = {};
  const resolving = new Set<string>();

  const resolveOne = (id: string): T => {
    const cached = resolved[id];
    if (cached !== undefined) return cached;
    const own = source[id];
    if (own === undefined) throw new Error(`Unknown inherited ${blueprintLabel} "${id}"`);
    if (resolving.has(id)) throw new Error(`Cyclic ${blueprintLabel} inheritance at "${id}"`);
    resolving.add(id);
    const materialized = own.$extends === undefined
      ? mergeBlueprintObjects({}, own)
      : mergeBlueprintObjects(resolveOne(own.$extends), own);
    resolving.delete(id);
    resolved[id] = materialized as T;
    return resolved[id];
  };

  for (const id of Object.keys(source)) resolveOne(id);
  return resolved;
}
