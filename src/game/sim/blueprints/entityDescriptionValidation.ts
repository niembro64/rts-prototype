/** Shared player-facing metadata contract for every unit and building. */
export type EntityDescriptionFields = Readonly<{
  fullName: unknown;
  shortName: unknown;
  shortDescription: unknown;
  longDescription: unknown;
}>;

const ENTITY_SHORT_DESCRIPTION_MAX_WORDS = 5;
const ENTITY_LONG_DESCRIPTION_MIN_WORDS = 6;

function entityDescriptionWordCount(value: string): number {
  const normalized = value.trim();
  return normalized.length === 0 ? 0 : normalized.split(/\s+/u).length;
}

function requireTrimmedText(label: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`Invalid ${label}: ${field} must be non-empty trimmed text`);
  }
  return value;
}

export function validateEntityDescription(
  label: string,
  fields: EntityDescriptionFields,
): void {
  requireTrimmedText(label, 'fullName', fields.fullName);
  const shortName = requireTrimmedText(label, 'shortName', fields.shortName);
  if (!/^[A-Z0-9-]{5}$/.test(shortName)) {
    throw new Error(
      `Invalid ${label}: shortName must be exactly five uppercase letters, digits, or hyphens`,
    );
  }
  const shortDescription = requireTrimmedText(
    label,
    'shortDescription',
    fields.shortDescription,
  );
  const shortWordCount = entityDescriptionWordCount(shortDescription);
  if (shortWordCount > ENTITY_SHORT_DESCRIPTION_MAX_WORDS) {
    throw new Error(
      `Invalid ${label}: shortDescription must contain fewer than 6 words; got ${shortWordCount}`,
    );
  }

  const longDescription = requireTrimmedText(
    label,
    'longDescription',
    fields.longDescription,
  );
  const longWordCount = entityDescriptionWordCount(longDescription);
  if (longWordCount < ENTITY_LONG_DESCRIPTION_MIN_WORDS) {
    throw new Error(
      `Invalid ${label}: longDescription must contain at least 6 words; got ${longWordCount}`,
    );
  }
}
