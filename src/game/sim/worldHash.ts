import { canonicalHashValue, canonicalStringify } from '../canonicalData';

type HashableWorld = {
  getHashMetadata(): unknown;
  getAllEntities(): HashableEntity[];
};

type HashableCommandQueue = {
  getHashState(): unknown;
};

type HashableEntity = Record<string, unknown> & {
  id: number;
  type: string;
  body?: { physicsBody?: HashableBody | null } | null;
};

type HashableBody = {
  slot: number;
  shape: unknown;
  mass: number;
  isStatic: boolean;
  label: string;
  entityId?: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  groundLaunchAx: number;
  groundLaunchAy: number;
  groundLaunchAz: number;
  surfaceNormalX: number;
  surfaceNormalY: number;
  surfaceNormalZ: number;
  radius: number;
  halfX: number;
  halfY: number;
  halfZ: number;
  invMass: number;
  restitution: number;
  groundOffset: number;
  sleepTicks: number;
  sleeping: boolean;
  upwardSurfaceContact: boolean;
};

export type WorldHashSample = {
  tick: number;
  hash: string;
};

export type SimulationWorldHashInput = {
  world: HashableWorld;
  commandQueue: HashableCommandQueue;
  simulationState: unknown;
  economyState: unknown;
};

export function computeSimulationWorldHash(input: SimulationWorldHashInput): string {
  return canonicalHashValue({
    version: 1,
    world: buildWorldHashState(input.world),
    commandQueue: input.commandQueue.getHashState(),
    simulation: toHashValue(input.simulationState),
    economy: toHashValue(input.economyState),
  });
}

export function buildWorldHashState(world: HashableWorld): unknown {
  const metadata = world.getHashMetadata() as Record<string, unknown>;
  return {
    ...metadata,
    entities: world.getAllEntities()
      .slice()
      .sort((a, b) => a.id - b.id)
      .map(hashEntity),
  };
}

function hashEntity(entity: HashableEntity): unknown {
  return {
    id: entity.id,
    type: entity.type,
    transform: toHashValue(entity.transform),
    body: hashBody(entity.body?.physicsBody),
    selectable: toHashValue(entity.selectable),
    ownership: toHashValue(entity.ownership),
    cloak: toHashValue(entity.cloak),
    detector: toHashValue(entity.detector),
    unit: toHashValue(entity.unit),
    building: toHashValue(entity.building),
    combat: toHashValue(entity.combat),
    projectile: toHashValue(entity.projectile),
    buildable: toHashValue(entity.buildable),
    builder: toHashValue(entity.builder),
    factory: toHashValue(entity.factory),
    commander: toHashValue(entity.commander),
    dgunProjectile: toHashValue(entity.dgunProjectile),
    buildingType: toHashValue(entity.buildingType),
    coveredDepositIds: toHashValue(entity.coveredDepositIds),
    metalExtractionRate: toHashValue(entity.metalExtractionRate),
    cachedFullVisionRadius: toHashValue(entity._cachedFullVisionRadius),
  };
}

function hashBody(body: HashableBody | null | undefined): unknown {
  if (body === null || body === undefined) return null;
  return {
    slot: body.slot,
    shape: body.shape,
    mass: body.mass,
    isStatic: body.isStatic,
    label: body.label,
    entityId: body.entityId ?? null,
    x: body.x,
    y: body.y,
    z: body.z,
    vx: body.vx,
    vy: body.vy,
    vz: body.vz,
    ax: body.ax,
    ay: body.ay,
    az: body.az,
    groundLaunchAx: body.groundLaunchAx,
    groundLaunchAy: body.groundLaunchAy,
    groundLaunchAz: body.groundLaunchAz,
    surfaceNormalX: body.surfaceNormalX,
    surfaceNormalY: body.surfaceNormalY,
    surfaceNormalZ: body.surfaceNormalZ,
    radius: body.radius,
    halfX: body.halfX,
    halfY: body.halfY,
    halfZ: body.halfZ,
    invMass: body.invMass,
    restitution: body.restitution,
    groundOffset: body.groundOffset,
    sleepTicks: body.sleepTicks,
    sleeping: body.sleeping,
    upwardSurfaceContact: body.upwardSurfaceContact,
  };
}

function toHashValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    return { nonFiniteNumber: String(value) };
  }
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (value === undefined) return null;
  if (typeof value === 'function' || typeof value === 'symbol') return null;

  if (Array.isArray(value)) return value.map((item) => toHashValue(item, seen));

  if (value instanceof Set) {
    return [...value]
      .map((item) => toHashValue(item, seen))
      .sort(compareHashValues);
  }

  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, item]) => [toHashValue(key, seen), toHashValue(item, seen)])
      .sort((a, b) => compareHashValues(a[0], b[0]));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return { circular: true };
    seen.add(value);
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = toHashValue(record[key], seen);
    }
    seen.delete(value);
    return out;
  }

  return null;
}

function compareHashValues(a: unknown, b: unknown): number {
  const aText = canonicalStringify(a);
  const bText = canonicalStringify(b);
  return aText < bText ? -1 : aText > bText ? 1 : 0;
}

export function sortedNumberArray(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

export function sortedEntityIdSet(values: Iterable<number>): number[] {
  return sortedNumberArray(values);
}
