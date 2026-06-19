import type {
  NetworkServerSnapshotSimEvent,
} from './NetworkTypes';
import {
  dequantizeNormal,
  dequantizeProjectilePosition,
  dequantizeRotation,
  dequantizeVelocity,
  quantizeNormal,
  quantizeProjectilePosition,
  quantizeRotation,
  quantizeVelocity,
} from './snapshotQuantization';
import {
  AUDIO_EVENT_SOURCE_TYPE_CODES,
  AUDIO_EVENT_TYPE_CODES,
  DEATH_HAS_BASE_Z,
  DEATH_HAS_COLLISION_RADIUS,
  DEATH_HAS_ROTATION,
  DEATH_HAS_TURRET_POSES,
  DEATH_HAS_UNIT_TYPE,
  DEATH_HAS_VISUAL_RADIUS,
  EVENT_AUDIO_ONLY_VALUE,
  EVENT_HAS_AUDIO_ONLY,
  EVENT_HAS_DEATH_CONTEXT,
  EVENT_HAS_ENTITY_ID,
  EVENT_HAS_IMPACT_CONTEXT,
  EVENT_HAS_KILLER_PLAYER_ID,
  EVENT_HAS_PLAYER_ID,
  EVENT_HAS_SHIELD_IMPACT,
  EVENT_HAS_SOURCE_KEY,
  EVENT_HAS_SOURCE_TYPE,
  EVENT_HAS_VICTIM_PLAYER_ID,
  EVENT_HAS_WATER_SPLASH_CONTEXT,
} from './audioEventWireFormat';

const PACKED_AUDIO_EVENTS_VERSION = 2;

const AUDIO_EVENT_TYPES = [
  'fire',
  'hit',
  'death',
  'laserStart',
  'laserStop',
  'shieldStart',
  'shieldStop',
  'shieldImpact',
  'ping',
  'attackAlert',
  'projectileExpire',
  'waterSplash',
] as const satisfies readonly NetworkServerSnapshotSimEvent['type'][];

const AUDIO_EVENT_SOURCE_TYPES = [
  'turret',
  'unit',
  'building',
  'system',
] as const;

export type PackedAudioEventsWire = {
  v: typeof PACKED_AUDIO_EVENTS_VERSION;
  s: string[];
  e: number[][];
  d: number[][] | undefined;
  i: number[][] | undefined;
  t: number[][] | undefined;
};

const _packStrings: string[] = [];
const _packStringSlots = new Map<string, number>();
const _packEventRows: number[][] = [];
const _packDeathRows: number[][] = [];
const _packImpactRows: number[][] = [];
const _packTurretPoseRows: number[][] = [];
const _packEventRowPool: number[][] = [];
const _packDeathRowPool: number[][] = [];
const _packImpactRowPool: number[][] = [];
const _packTurretPoseRowPool: number[][] = [];

function releaseRows(rows: number[][], pool: number[][]): void {
  for (let i = 0; i < rows.length; i++) {
    rows[i].length = 0;
    pool.push(rows[i]);
  }
  rows.length = 0;
}

function resetAudioPackScratch(): void {
  _packStrings.length = 0;
  _packStringSlots.clear();
  releaseRows(_packEventRows, _packEventRowPool);
  releaseRows(_packDeathRows, _packDeathRowPool);
  releaseRows(_packImpactRows, _packImpactRowPool);
  releaseRows(_packTurretPoseRows, _packTurretPoseRowPool);
}

function rentRow(pool: number[][]): number[] {
  const row = pool.pop();
  if (row !== undefined) {
    row.length = 0;
    return row;
  }
  return [];
}

export function packAudioEventsForWire(
  events: readonly NetworkServerSnapshotSimEvent[] | undefined,
): PackedAudioEventsWire | undefined {
  if (events === undefined) return undefined;
  if (events.length === 0) return undefined;

  resetAudioPackScratch();
  const strings = _packStrings;
  const stringSlots = _packStringSlots;
  const eventRows = _packEventRows;
  const deathRows = _packDeathRows;
  const impactRows = _packImpactRows;
  const turretPoseRows = _packTurretPoseRows;

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    const typeCode = AUDIO_EVENT_TYPE_CODES[event.type];
    if (typeCode === undefined) continue;

    let flags = 0;
    if (event.sourceType !== null) flags |= EVENT_HAS_SOURCE_TYPE;
    if (event.sourceKey !== null) flags |= EVENT_HAS_SOURCE_KEY;
    if (event.playerId !== null) flags |= EVENT_HAS_PLAYER_ID;
    if (event.entityId !== null) flags |= EVENT_HAS_ENTITY_ID;
    if (event.shieldImpact !== null) flags |= EVENT_HAS_SHIELD_IMPACT;
    if (event.killerPlayerId !== null) flags |= EVENT_HAS_KILLER_PLAYER_ID;
    if (event.victimPlayerId !== null) flags |= EVENT_HAS_VICTIM_PLAYER_ID;
    if (event.audioOnly !== null) {
      flags |= EVENT_HAS_AUDIO_ONLY;
      if (event.audioOnly) flags |= EVENT_AUDIO_ONLY_VALUE;
    }
    if (event.deathContext !== null) flags |= EVENT_HAS_DEATH_CONTEXT;
    if (event.impactContext !== null) flags |= EVENT_HAS_IMPACT_CONTEXT;
    if (event.waterSplash !== null) flags |= EVENT_HAS_WATER_SPLASH_CONTEXT;

    const row = rentRow(_packEventRowPool);
    row.push(
      typeCode,
      flags,
      stringSlot(strings, stringSlots, event.turretBlueprintId),
      quantizeProjectilePosition(event.pos.x),
      quantizeProjectilePosition(event.pos.y),
      quantizeProjectilePosition(event.pos.z),
    );

    if (event.sourceType !== null) {
      row.push(AUDIO_EVENT_SOURCE_TYPE_CODES[event.sourceType] ?? 0);
    }
    if (event.sourceKey !== null) {
      row.push(stringSlot(strings, stringSlots, event.sourceKey));
    }
    if (event.playerId !== null) row.push(event.playerId);
    if (event.entityId !== null) row.push(event.entityId);
    if (event.shieldImpact !== null) {
      row.push(
        quantizeNormal(event.shieldImpact.normal.x),
        quantizeNormal(event.shieldImpact.normal.y),
        quantizeNormal(event.shieldImpact.normal.z),
        event.shieldImpact.playerId,
      );
    }
    if (event.killerPlayerId !== null) row.push(event.killerPlayerId);
    if (event.victimPlayerId !== null) row.push(event.victimPlayerId);
    if (event.audioOnly !== null) row.push(event.audioOnly ? 1 : 0);
    if (event.waterSplash !== null) {
      row.push(
        quantizeVelocity(event.waterSplash.velocity.x),
        quantizeVelocity(event.waterSplash.velocity.y),
        quantizeVelocity(event.waterSplash.velocity.z),
        event.waterSplash.mass,
      );
    }
    if (event.deathContext !== null) {
      appendDeathContextRow(event.deathContext, strings, stringSlots, deathRows, turretPoseRows);
    }
    if (event.impactContext !== null) {
      const impactRow = rentRow(_packImpactRowPool);
      impactRow.push(
        quantizeProjectilePosition(event.impactContext.radiusCollision),
        quantizeProjectilePosition(event.impactContext.deathExplosionRadius),
        quantizeProjectilePosition(event.impactContext.projectile.pos.x),
        quantizeProjectilePosition(event.impactContext.projectile.pos.y),
        quantizeVelocity(event.impactContext.projectile.vel.x),
        quantizeVelocity(event.impactContext.projectile.vel.y),
        quantizeVelocity(event.impactContext.entity.vel.x),
        quantizeVelocity(event.impactContext.entity.vel.y),
        quantizeProjectilePosition(event.impactContext.entity.radiusCollision),
        quantizeNormal(event.impactContext.penetrationDir.x),
        quantizeNormal(event.impactContext.penetrationDir.y),
      );
      impactRows.push(impactRow);
    }
    eventRows.push(row);
  }

  return {
    v: PACKED_AUDIO_EVENTS_VERSION,
    s: strings,
    e: eventRows,
    d: deathRows.length > 0 ? deathRows : undefined,
    i: impactRows.length > 0 ? impactRows : undefined,
    t: turretPoseRows.length > 0 ? turretPoseRows : undefined,
  };
}

export function unpackAudioEventsFromWire(
  packed: PackedAudioEventsWire,
): NetworkServerSnapshotSimEvent[] {
  const events: NetworkServerSnapshotSimEvent[] = [];
  const strings = packed.s;
  const deathRows = packed.d ?? [];
  const impactRows = packed.i ?? [];
  const turretPoseRows = packed.t ?? [];
  let deathOffset = 0;
  let impactOffset = 0;
  let turretPoseOffset = 0;

  for (let rowIndex = 0; rowIndex < packed.e.length; rowIndex++) {
    const row = packed.e[rowIndex];
    const type = AUDIO_EVENT_TYPES[row[0]];
    if (type === undefined) continue;

    const flags = row[1] ?? 0;
    let cursor = 6;
    const event: NetworkServerSnapshotSimEvent = {
      type,
      turretBlueprintId: (strings[row[2]] ?? '') as NetworkServerSnapshotSimEvent['turretBlueprintId'],
      sourceType: null,
      sourceKey: null,
      pos: {
        x: dequantizeProjectilePosition(row[3] ?? 0),
        y: dequantizeProjectilePosition(row[4] ?? 0),
        z: dequantizeProjectilePosition(row[5] ?? 0),
      },
      playerId: null,
      entityId: null,
      deathContext: null,
      impactContext: null,
      waterSplash: null,
      shieldImpact: null,
      killerPlayerId: null,
      victimPlayerId: null,
      audioOnly: null,
    };

    if ((flags & EVENT_HAS_SOURCE_TYPE) !== 0) {
      event.sourceType = AUDIO_EVENT_SOURCE_TYPES[row[cursor++]] ?? 'system';
    }
    if ((flags & EVENT_HAS_SOURCE_KEY) !== 0) {
      event.sourceKey = strings[row[cursor++]] ?? '';
    }
    if ((flags & EVENT_HAS_PLAYER_ID) !== 0) event.playerId = row[cursor++];
    if ((flags & EVENT_HAS_ENTITY_ID) !== 0) event.entityId = row[cursor++];
    if ((flags & EVENT_HAS_SHIELD_IMPACT) !== 0) {
      event.shieldImpact = {
        normal: {
          x: dequantizeNormal(row[cursor++] ?? 0),
          y: dequantizeNormal(row[cursor++] ?? 0),
          z: dequantizeNormal(row[cursor++] ?? 0),
        },
        playerId: row[cursor++],
      };
    }
    if ((flags & EVENT_HAS_KILLER_PLAYER_ID) !== 0) event.killerPlayerId = row[cursor++];
    if ((flags & EVENT_HAS_VICTIM_PLAYER_ID) !== 0) event.victimPlayerId = row[cursor++];
    if ((flags & EVENT_HAS_AUDIO_ONLY) !== 0) event.audioOnly = row[cursor++] !== 0;
    if ((flags & EVENT_HAS_WATER_SPLASH_CONTEXT) !== 0) {
      event.waterSplash = {
        velocity: {
          x: dequantizeVelocity(row[cursor++] ?? 0),
          y: dequantizeVelocity(row[cursor++] ?? 0),
          z: dequantizeVelocity(row[cursor++] ?? 0),
        },
        mass: row[cursor++] ?? 0,
      };
    }
    if ((flags & EVENT_HAS_DEATH_CONTEXT) !== 0) {
      const result = unpackDeathContextRow(
        deathRows[deathOffset++],
        strings,
        turretPoseRows,
        turretPoseOffset,
      );
      event.deathContext = result.context;
      turretPoseOffset = result.nextTurretPoseOffset;
    }
    if ((flags & EVENT_HAS_IMPACT_CONTEXT) !== 0) {
      event.impactContext = unpackImpactContextRow(impactRows[impactOffset++]);
    }
    events.push(event);
  }

  return events;
}

export function isPackedAudioEventsWire(value: unknown): value is PackedAudioEventsWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedAudioEventsWire>;
  return (
    candidate.v === PACKED_AUDIO_EVENTS_VERSION &&
    Array.isArray(candidate.s) &&
    Array.isArray(candidate.e)
  );
}

function stringSlot(
  strings: string[],
  slots: Map<string, number>,
  value: string,
): number {
  const existing = slots.get(value);
  if (existing !== undefined) return existing;
  const next = strings.length;
  strings.push(value);
  slots.set(value, next);
  return next;
}

function appendDeathContextRow(
  context: NonNullable<NetworkServerSnapshotSimEvent['deathContext']>,
  strings: string[],
  stringSlots: Map<string, number>,
  deathRows: number[][],
  turretPoseRows: number[][],
): void {
  let flags = 0;
  if (context.visualRadius !== undefined) flags |= DEATH_HAS_VISUAL_RADIUS;
  if (context.collisionRadius !== undefined) flags |= DEATH_HAS_COLLISION_RADIUS;
  if (context.baseZ !== undefined) flags |= DEATH_HAS_BASE_Z;
  if (context.unitBlueprintId !== undefined) flags |= DEATH_HAS_UNIT_TYPE;
  if (context.rotation !== undefined) flags |= DEATH_HAS_ROTATION;
  if (context.turretPoses !== undefined) flags |= DEATH_HAS_TURRET_POSES;

  const row = rentRow(_packDeathRowPool);
  row.push(
    flags,
    quantizeVelocity(context.unitVel.x),
    quantizeVelocity(context.unitVel.y),
    quantizeNormal(context.hitDir.x),
    quantizeNormal(context.hitDir.y),
    quantizeVelocity(context.projectileVel.x),
    quantizeVelocity(context.projectileVel.y),
    context.attackMagnitude,
    quantizeProjectilePosition(context.radius),
    context.color,
  );

  if (context.visualRadius !== undefined) row.push(quantizeProjectilePosition(context.visualRadius));
  if (context.collisionRadius !== undefined) row.push(quantizeProjectilePosition(context.collisionRadius));
  if (context.baseZ !== undefined) row.push(quantizeProjectilePosition(context.baseZ));
  if (context.unitBlueprintId !== undefined) {
    row.push(stringSlot(strings, stringSlots, context.unitBlueprintId));
  }
  if (context.rotation !== undefined) row.push(quantizeRotation(context.rotation));
  if (context.turretPoses !== undefined) {
    row.push(context.turretPoses.length);
    for (let i = 0; i < context.turretPoses.length; i++) {
      const pose = context.turretPoses[i];
      const poseRow = rentRow(_packTurretPoseRowPool);
      poseRow.push(
        quantizeRotation(pose.rotation),
        quantizeRotation(pose.pitch),
      );
      turretPoseRows.push(poseRow);
    }
  }

  deathRows.push(row);
}

function unpackDeathContextRow(
  row: number[] | undefined,
  strings: readonly string[],
  turretPoseRows: readonly number[][],
  turretPoseOffset: number,
): {
  context: NonNullable<NetworkServerSnapshotSimEvent['deathContext']>;
  nextTurretPoseOffset: number;
} {
  const source = row ?? [];
  const flags = source[0] ?? 0;
  let cursor = 10;
  const context: NonNullable<NetworkServerSnapshotSimEvent['deathContext']> = {
    unitVel: {
      x: dequantizeVelocity(source[1] ?? 0),
      y: dequantizeVelocity(source[2] ?? 0),
    },
    hitDir: {
      x: dequantizeNormal(source[3] ?? 0),
      y: dequantizeNormal(source[4] ?? 0),
    },
    projectileVel: {
      x: dequantizeVelocity(source[5] ?? 0),
      y: dequantizeVelocity(source[6] ?? 0),
    },
    attackMagnitude: source[7] ?? 0,
    radius: dequantizeProjectilePosition(source[8] ?? 0),
    color: source[9] ?? 0,
  };

  if ((flags & DEATH_HAS_VISUAL_RADIUS) !== 0) {
    context.visualRadius = dequantizeProjectilePosition(source[cursor++] ?? 0);
  }
  if ((flags & DEATH_HAS_COLLISION_RADIUS) !== 0) {
    context.collisionRadius = dequantizeProjectilePosition(source[cursor++] ?? 0);
  }
  if ((flags & DEATH_HAS_BASE_Z) !== 0) {
    context.baseZ = dequantizeProjectilePosition(source[cursor++] ?? 0);
  }
  if ((flags & DEATH_HAS_UNIT_TYPE) !== 0) {
    context.unitBlueprintId = strings[source[cursor++]] as NonNullable<typeof context.unitBlueprintId>;
  }
  if ((flags & DEATH_HAS_ROTATION) !== 0) {
    context.rotation = dequantizeRotation(source[cursor++] ?? 0);
  }
  if ((flags & DEATH_HAS_TURRET_POSES) !== 0) {
    const count = source[cursor++] ?? 0;
    const poses: NonNullable<typeof context.turretPoses> = [];
    for (let i = 0; i < count; i++) {
      const pose = turretPoseRows[turretPoseOffset + i] ?? [];
      poses.push({
        rotation: dequantizeRotation(pose[0] ?? 0),
        pitch: dequantizeRotation(pose[1] ?? 0),
      });
    }
    context.turretPoses = poses;
    turretPoseOffset += count;
  }

  return {
    context,
    nextTurretPoseOffset: turretPoseOffset,
  };
}

function unpackImpactContextRow(
  row: number[] | undefined,
): NonNullable<NetworkServerSnapshotSimEvent['impactContext']> {
  const source = row ?? [];
  return {
    radiusCollision: dequantizeProjectilePosition(source[0] ?? 0),
    deathExplosionRadius: dequantizeProjectilePosition(source[1] ?? 0),
    projectile: {
      pos: {
        x: dequantizeProjectilePosition(source[2] ?? 0),
        y: dequantizeProjectilePosition(source[3] ?? 0),
      },
      vel: {
        x: dequantizeVelocity(source[4] ?? 0),
        y: dequantizeVelocity(source[5] ?? 0),
      },
    },
    entity: {
      vel: {
        x: dequantizeVelocity(source[6] ?? 0),
        y: dequantizeVelocity(source[7] ?? 0),
      },
      radiusCollision: dequantizeProjectilePosition(source[8] ?? 0),
    },
    penetrationDir: {
      x: dequantizeNormal(source[9] ?? 0),
      y: dequantizeNormal(source[10] ?? 0),
    },
  };
}
