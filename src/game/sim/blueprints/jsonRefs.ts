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
