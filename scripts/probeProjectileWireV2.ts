import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import {
  packProjectilesForWire,
  unpackProjectilesFromWire,
  isPackedProjectileSnapshotWire,
  type PackedProjectileSnapshotWire,
} from '../src/game/network/snapshotProjectileWirePack';
import {
  PROJECTILE_SPAWN_WIRE_STRIDE,
  PROJECTILE_VELOCITY_WIRE_STRIDE,
  PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
  PROJECTILE_BEAM_POINT_WIRE_STRIDE,
  PROJECTILE_SPAWN_FLAG_BEAM,
  PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE,
  PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE,
  PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE,
  PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN,
  PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE,
  PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T,
  PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_X,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID,
} from '../src/game/network/stateSerializerProjectiles';
import type {
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotVelocityUpdate,
} from '../src/game/network/NetworkTypes';

type ProjSnap = {
  spawns?: NetworkServerSnapshotProjectileSpawn[];
  despawns?: { id: number }[];
  velocityUpdates?: NetworkServerSnapshotVelocityUpdate[];
  beamUpdates?: NetworkServerSnapshotBeamUpdate[];
};

function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function makeSpawn(id: number, withBeam = false, withHoming = false): NetworkServerSnapshotProjectileSpawn {
  const base: NetworkServerSnapshotProjectileSpawn = {
    id,
    pos: { x: rand(-2000, 2000), y: rand(-2000, 2000), z: rand(0, 200) },
    rotation: rand(0, 6283),
    velocity: { x: rand(-300, 300), y: rand(-300, 300), z: rand(-50, 100) },
    projectileType: rand(0, 20),
    turretBlueprintCode: rand(0, 40),
    playerId: rand(1, 5),
    sourceEntityId: rand(1, 5000),
    turretIndex: rand(0, 4),
    barrelIndex: rand(0, 2),
    maxLifespan: 3000,
    shotBlueprintCode: rand(0, 30),
    sourceTurretBlueprintCode: rand(0, 40),
  };
  if (withBeam) {
    base.beam = {
      start: { x: rand(-2000, 2000), y: rand(-2000, 2000), z: rand(0, 200) },
      end: { x: rand(-2000, 2000), y: rand(-2000, 2000), z: rand(0, 200) },
    };
  }
  if (withHoming) {
    base.targetEntityId = rand(1, 5000);
    base.homingTurnRate = rand(50, 500);
  }
  return base;
}

function makeVelocityUpdate(id: number, clearHoming = false): NetworkServerSnapshotVelocityUpdate {
  const u: NetworkServerSnapshotVelocityUpdate = {
    id,
    pos: { x: rand(-2000, 2000), y: rand(-2000, 2000), z: rand(0, 200) },
    velocity: { x: rand(-300, 300), y: rand(-300, 300), z: rand(-50, 100) },
  };
  if (clearHoming) u.clearHomingTarget = true;
  return u;
}

function makeBeamPoint(): NetworkServerSnapshotBeamPoint {
  return {
    x: rand(-2000, 2000),
    y: rand(-2000, 2000),
    z: rand(0, 200),
    vx: rand(-300, 300),
    vy: rand(-300, 300),
    vz: rand(-50, 50),
  };
}

function makeReflectorPoint(): NetworkServerSnapshotBeamPoint {
  return {
    x: rand(-2000, 2000),
    y: rand(-2000, 2000),
    z: rand(0, 200),
    vx: 0,
    vy: 0,
    vz: 0,
    mirrorEntityId: rand(1, 5000),
    reflectorKind: Math.random() < 0.5 ? 'mirror' : 'forceField',
    reflectorPlayerId: rand(1, 5),
    normalX: rand(-1000, 1000),
    normalY: rand(-1000, 1000),
    normalZ: rand(-1000, 1000),
  };
}

function makeBeamUpdate(id: number, pointCount: number): NetworkServerSnapshotBeamUpdate {
  const points: NetworkServerSnapshotBeamPoint[] = [];
  for (let i = 0; i < pointCount; i++) {
    if (i > 0 && i < pointCount - 1) points.push(makeReflectorPoint());
    else points.push(makeBeamPoint());
  }
  const update: NetworkServerSnapshotBeamUpdate = {
    id,
    points,
    obstructionT: 800,
    endpointDamageable: true,
  };
  return update;
}

function buildV1Packed(snap: ProjSnap): {
  v: 1;
  s: number[] | undefined;
  d: number[] | undefined;
  u: number[] | undefined;
  b: number[] | undefined;
  p: number[] | undefined;
} {
  const spawns = snap.spawns;
  const despawns = snap.despawns;
  const updates = snap.velocityUpdates;
  const beams = snap.beamUpdates;

  let s: number[] | undefined;
  if (spawns !== undefined) {
    s = new Array(spawns.length * PROJECTILE_SPAWN_WIRE_STRIDE);
    for (let i = 0; i < spawns.length; i++) {
      writeSpawnV1(s, i * PROJECTILE_SPAWN_WIRE_STRIDE, spawns[i]);
    }
  }

  let d: number[] | undefined;
  if (despawns !== undefined) {
    d = new Array(despawns.length);
    for (let i = 0; i < despawns.length; i++) d[i] = despawns[i].id;
  }

  let u: number[] | undefined;
  if (updates !== undefined) {
    u = new Array(updates.length * PROJECTILE_VELOCITY_WIRE_STRIDE);
    for (let i = 0; i < updates.length; i++) {
      writeVelocityV1(u, i * PROJECTILE_VELOCITY_WIRE_STRIDE, updates[i]);
    }
  }

  let b: number[] | undefined;
  let p: number[] | undefined;
  if (beams !== undefined) {
    b = new Array(beams.length * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE);
    let totalPoints = 0;
    for (let i = 0; i < beams.length; i++) totalPoints += beams[i].points.length;
    p = new Array(totalPoints * PROJECTILE_BEAM_POINT_WIRE_STRIDE);
    let pointIndex = 0;
    for (let i = 0; i < beams.length; i++) {
      writeBeamUpdateV1(b, i * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE, beams[i]);
      for (let pp = 0; pp < beams[i].points.length; pp++) {
        writeBeamPointV1(p, pointIndex * PROJECTILE_BEAM_POINT_WIRE_STRIDE, beams[i].points[pp]);
        pointIndex++;
      }
    }
  }

  return { v: 1, s, d, u, b, p };
}

function writeSpawnV1(values: number[], base: number, spawn: NetworkServerSnapshotProjectileSpawn): void {
  values[base + 0] = spawn.id;
  values[base + 1] = spawn.pos.x;
  values[base + 2] = spawn.pos.y;
  values[base + 3] = spawn.pos.z;
  values[base + 4] = spawn.rotation;
  values[base + 5] = spawn.velocity.x;
  values[base + 6] = spawn.velocity.y;
  values[base + 7] = spawn.velocity.z;
  values[base + 8] = spawn.projectileType;
  values[base + 9] = spawn.maxLifespan ?? 0;
  values[base + 10] = spawn.turretBlueprintCode;
  values[base + 11] = spawn.shotBlueprintCode ?? 0;
  values[base + 12] = spawn.sourceTurretBlueprintCode ?? 0;
  values[base + 13] = spawn.playerId;
  values[base + 14] = spawn.sourceEntityId;
  values[base + 15] = spawn.turretIndex;
  values[base + 16] = spawn.barrelIndex;
  const beam = spawn.beam;
  values[base + 17] = beam !== undefined ? beam.start.x : 0;
  values[base + 18] = beam !== undefined ? beam.start.y : 0;
  values[base + 19] = beam !== undefined ? beam.start.z : 0;
  values[base + 20] = beam !== undefined ? beam.end.x : 0;
  values[base + 21] = beam !== undefined ? beam.end.y : 0;
  values[base + 22] = beam !== undefined ? beam.end.z : 0;
  values[base + 23] = spawn.targetEntityId ?? 0;
  values[base + 24] = spawn.homingTurnRate ?? 0;
  values[base + 25] = 0;
  let flags = 0;
  if (spawn.maxLifespan !== undefined) flags |= PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN;
  if (spawn.shotBlueprintCode !== undefined) flags |= PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE;
  if (spawn.sourceTurretBlueprintCode !== undefined) flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE;
  if (spawn.isDGun) flags |= PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE;
  if (spawn.fromParentDetonation) flags |= PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE;
  if (spawn.beam !== undefined) flags |= PROJECTILE_SPAWN_FLAG_BEAM;
  if (spawn.targetEntityId !== undefined) flags |= PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID;
  if (spawn.homingTurnRate !== undefined) flags |= PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE;
  values[base + 26] = flags;
}

function writeVelocityV1(values: number[], base: number, u: NetworkServerSnapshotVelocityUpdate): void {
  values[base + 0] = u.id;
  values[base + 1] = u.pos.x;
  values[base + 2] = u.pos.y;
  values[base + 3] = u.pos.z;
  values[base + 4] = u.velocity.x;
  values[base + 5] = u.velocity.y;
  values[base + 6] = u.velocity.z;
  values[base + 7] = u.clearHomingTarget === true ? 1 : 0;
}

function writeBeamUpdateV1(values: number[], base: number, u: NetworkServerSnapshotBeamUpdate): void {
  values[base + 0] = u.id;
  let flags = 0;
  if (u.obstructionT !== undefined) flags |= PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T;
  if (u.endpointDamageable === true) flags |= PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE;
  values[base + 1] = flags;
  values[base + 2] = u.obstructionT ?? 0;
  values[base + 3] = u.points.length;
}

function writeBeamPointV1(values: number[], base: number, p: NetworkServerSnapshotBeamPoint): void {
  values[base + 0] = p.x;
  values[base + 1] = p.y;
  values[base + 2] = p.z;
  values[base + 3] = p.vx;
  values[base + 4] = p.vy;
  values[base + 5] = p.vz;
  let flags = 0;
  if (p.mirrorEntityId !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID;
  if (p.reflectorKind !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND;
  if (p.reflectorPlayerId !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID;
  if (p.normalX !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_X;
  if (p.normalY !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y;
  if (p.normalZ !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z;
  values[base + 6] = flags;
  values[base + 7] = p.mirrorEntityId ?? 0;
  values[base + 8] = (p.reflectorPlayerId ?? 0) as number;
  values[base + 9] = p.normalX ?? 0;
  values[base + 10] = p.normalY ?? 0;
  values[base + 11] = p.normalZ ?? 0;
}

function compareById<T extends { id: number }>(
  label: string,
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
): number {
  const aLen = a?.length ?? 0;
  const bLen = b?.length ?? 0;
  if (aLen !== bLen) {
    console.log(`  MISMATCH ${label}: lengths ${aLen} vs ${bLen}`);
    return 1;
  }
  if (a === undefined || b === undefined) return 0;
  const byIdA = new Map<number, T>();
  for (let i = 0; i < a.length; i++) byIdA.set(a[i].id, a[i]);
  let mismatches = 0;
  for (let i = 0; i < b.length; i++) {
    const item = b[i];
    const src = byIdA.get(item.id);
    if (src === undefined) {
      mismatches++;
      if (mismatches <= 3) {
        console.log(`  MISMATCH ${label}: decoded id ${item.id} has no source`);
      }
      continue;
    }
    if (JSON.stringify(src) !== JSON.stringify(item)) {
      mismatches++;
      if (mismatches <= 3) {
        console.log(`  MISMATCH ${label} id=${item.id}:`);
        console.log(`    src: ${JSON.stringify(src)}`);
        console.log(`    rt : ${JSON.stringify(item)}`);
      }
    }
  }
  return mismatches;
}

function compareDespawns(
  label: string,
  a: readonly { id: number }[] | undefined,
  b: readonly { id: number }[] | undefined,
): number {
  const aLen = a?.length ?? 0;
  const bLen = b?.length ?? 0;
  if (aLen !== bLen) {
    console.log(`  MISMATCH ${label}: lengths ${aLen} vs ${bLen}`);
    return 1;
  }
  if (a === undefined || b === undefined) return 0;
  const aIds = a.map((d) => d.id).sort((x, y) => x - y);
  const bIds = b.map((d) => d.id).sort((x, y) => x - y);
  let mismatches = 0;
  for (let i = 0; i < aIds.length; i++) {
    if (aIds[i] !== bIds[i]) {
      mismatches++;
      if (mismatches <= 3) {
        console.log(`  MISMATCH ${label} idx=${i}: src ${aIds[i]} vs rt ${bIds[i]}`);
      }
    }
  }
  return mismatches;
}

function probe(label: string, snap: ProjSnap): void {
  const v1 = buildV1Packed(snap);
  const v1Bytes = msgpackEncode({ projectiles: v1 }, { ignoreUndefined: true }).byteLength;
  const v2 = packProjectilesForWire(snap);
  if (v2 === undefined) throw new Error('v2 packed missing');
  const v2Bytes = msgpackEncode({ projectiles: v2 }, { ignoreUndefined: true }).byteLength;
  const reduction = ((1 - v2Bytes / v1Bytes) * 100).toFixed(1);

  // Round-trip parity: decode V2 back and compare to original.
  // Stash to ensure msgpack round-trip preserves Uint8Array.
  const v2Wire = msgpackDecode(
    msgpackEncode(v2, { ignoreUndefined: true }),
  ) as PackedProjectileSnapshotWire;
  if (!isPackedProjectileSnapshotWire(v2Wire)) {
    console.log(`  ERROR ${label}: round-trip wire is not detected as packed`);
    return;
  }
  const decoded = unpackProjectilesFromWire(v2Wire);

  let mismatches = 0;
  mismatches += compareById('spawns', snap.spawns, decoded.spawns);
  mismatches += compareDespawns('despawns', snap.despawns, decoded.despawns);
  mismatches += compareById('velocityUpdates', snap.velocityUpdates, decoded.velocityUpdates);
  mismatches += compareById('beamUpdates', snap.beamUpdates, decoded.beamUpdates);

  console.log(
    `${label}: V1 ${v1Bytes} B -> V2 ${v2Bytes} B (${reduction}% reduction); ` +
      `parity ${mismatches === 0 ? 'OK' : `${mismatches} MISMATCHES`}`,
  );
}

function main(): void {
  Math.random();

  // High-count velocity-update probe (the steady-state workload).
  {
    const spawns: NetworkServerSnapshotProjectileSpawn[] = [];
    const velocityUpdates: NetworkServerSnapshotVelocityUpdate[] = [];
    const despawns: { id: number }[] = [];
    for (let i = 1; i <= 5000; i++) {
      velocityUpdates.push(makeVelocityUpdate(i, Math.random() < 0.01));
    }
    probe('5000 velocity updates', { velocityUpdates });
  }

  {
    const velocityUpdates: NetworkServerSnapshotVelocityUpdate[] = [];
    for (let i = 1; i <= 1000; i++) {
      velocityUpdates.push(makeVelocityUpdate(i));
    }
    probe('1000 velocity updates', { velocityUpdates });
  }

  // Spawn-heavy probe (rare bursts).
  {
    const spawns: NetworkServerSnapshotProjectileSpawn[] = [];
    for (let i = 1; i <= 200; i++) {
      const withBeam = i % 7 === 0;
      const withHoming = i % 3 === 0;
      spawns.push(makeSpawn(i, withBeam, withHoming));
    }
    probe('200 spawns mixed', { spawns });
  }

  // Despawn burst probe.
  {
    const despawns: { id: number }[] = [];
    for (let i = 0; i < 500; i++) despawns.push({ id: rand(1, 20000) });
    probe('500 despawns (random IDs)', { despawns });
  }

  {
    const despawns: { id: number }[] = [];
    for (let i = 1; i <= 500; i++) despawns.push({ id: i * 3 });
    probe('500 despawns (sorted IDs)', { despawns });
  }

  // Beam-heavy probe (~20 active beams with reflections).
  {
    const beamUpdates: NetworkServerSnapshotBeamUpdate[] = [];
    for (let i = 1; i <= 20; i++) {
      beamUpdates.push(makeBeamUpdate(i, 2 + (i % 4)));
    }
    probe('20 beams with reflections', { beamUpdates });
  }

  // Combined snapshot probe (mixed steady-state).
  {
    const spawns: NetworkServerSnapshotProjectileSpawn[] = [];
    for (let i = 1; i <= 30; i++) spawns.push(makeSpawn(i, false, i % 2 === 0));
    const despawns: { id: number }[] = [];
    for (let i = 0; i < 30; i++) despawns.push({ id: rand(1, 5000) });
    const velocityUpdates: NetworkServerSnapshotVelocityUpdate[] = [];
    for (let i = 1; i <= 5000; i++) velocityUpdates.push(makeVelocityUpdate(i));
    const beamUpdates: NetworkServerSnapshotBeamUpdate[] = [];
    for (let i = 1; i <= 10; i++) beamUpdates.push(makeBeamUpdate(i, 2));
    probe('combined 5000-cap tick', { spawns, despawns, velocityUpdates, beamUpdates });
  }
}

main();
