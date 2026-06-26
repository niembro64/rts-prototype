// snapshot::envelope_emit — snapshot payload-emission kernels (projectiles,
// minimap, economy, resource-movements, audio, spray), extracted from the
// flat snapshot.rs as a child submodule (pure code motion, file-size
// discipline). Reads the parent writer + scratch pools via `use super::*`.
#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::*;
#[allow(unused_imports)]
use wasm_bindgen::prelude::*;

/// Append the envelope's `projectiles: {...}` nested object.
/// Supports `spawns`, `despawns`, `velocityUpdates`, `beamUpdates`.
/// Called between emit_economy and _continue (pool order: projectiles
/// sits after economy and before gameState).
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_projectiles(
    has_spawns: u8,
    spawn_count: u32,
    has_despawns: u8,
    despawn_count: u32,
    has_velocity_updates: u8,
    velocity_update_count: u32,
    has_beam_updates: u8,
    beam_update_count: u32,
) {
    let w = messagepack_writer();
    let mut nested_count: usize = 0;
    if has_spawns != 0 {
        nested_count += 1;
    }
    if has_despawns != 0 {
        nested_count += 1;
    }
    if has_velocity_updates != 0 {
        nested_count += 1;
    }
    if has_beam_updates != 0 {
        nested_count += 1;
    }
    if nested_count == 0 {
        return;
    }

    w.write_str("projectiles");
    w.write_map_header(nested_count);

    // Sub-key order in ProjectileSnapshot (stateSerializerProjectiles.ts
    // _projectilesBuf pool init): spawns, despawns, velocityUpdates,
    // beamUpdates. We emit only the present subset.
    if has_spawns != 0 {
        let n = spawn_count as usize;
        let scratch = snapshot_encode_proj_spawn_scratch();
        w.write_str("spawns");
        w.write_array_header(n);
        for i in 0..n {
            let base = i * SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE;
            let flags = scratch.buf[base + 31] as u32;
            let has_max_lifespan = (flags & 0x01) != 0;
            let has_shot_blueprint_code = (flags & 0x02) != 0;
            let has_source_turret_blueprint_code = (flags & 0x04) != 0;
            let has_is_dgun_true = (flags & 0x08) != 0;
            let has_from_parent_true = (flags & 0x10) != 0;
            let has_beam = (flags & 0x20) != 0;
            let has_target = (flags & 0x40) != 0;
            let has_homing = (flags & 0x80) != 0;
            let has_is_dgun_false = (flags & 0x100) != 0;
            let has_from_parent_false = (flags & 0x200) != 0;
            let has_source_turret_entity_id =
                (flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID) != 0;
            let has_parent_shot_entity_id =
                (flags & PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID) != 0;
            let has_is_dgun = has_is_dgun_true || has_is_dgun_false;
            let has_from_parent = has_from_parent_true || has_from_parent_false;

            // Field count = always-present 14 (id, pos, rotation,
            // velocity, projectileType, turretBlueprintCode, playerId,
            // sourceEntityId, sourceHostEntityId, sourceRootEntityId,
            // sourceTeamId, spawnTick, turretIndex, barrelIndex).
            let mut field_count: usize = 14;
            if has_max_lifespan {
                field_count += 1;
            }
            if has_shot_blueprint_code {
                field_count += 1;
            }
            if has_source_turret_blueprint_code {
                field_count += 1;
            }
            if has_source_turret_entity_id {
                field_count += 1;
            }
            if has_parent_shot_entity_id {
                field_count += 1;
            }
            if has_is_dgun {
                field_count += 1;
            }
            if has_from_parent {
                field_count += 1;
            }
            if has_beam {
                field_count += 1;
            }
            if has_target {
                field_count += 1;
            }
            if has_homing {
                field_count += 1;
            }
            w.write_map_header(field_count);

            // Pool order from createPooledProjectileSpawn.
            w.write_str("id");
            w.write_uint(scratch.buf[base] as u64);
            w.write_str("pos");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(scratch.buf[base + 1]);
            w.write_str("y");
            w.write_number(scratch.buf[base + 2]);
            w.write_str("z");
            w.write_number(scratch.buf[base + 3]);
            w.write_str("rotation");
            w.write_number(scratch.buf[base + 4]);
            w.write_str("velocity");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(scratch.buf[base + 5]);
            w.write_str("y");
            w.write_number(scratch.buf[base + 6]);
            w.write_str("z");
            w.write_number(scratch.buf[base + 7]);
            w.write_str("projectileType");
            w.write_uint(scratch.buf[base + 8] as u64);
            if has_max_lifespan {
                w.write_str("maxLifespan");
                w.write_number(scratch.buf[base + 9]);
            }
            w.write_str("turretBlueprintCode");
            w.write_uint(scratch.buf[base + 10] as u64);
            if has_shot_blueprint_code {
                w.write_str("shotBlueprintCode");
                w.write_uint(scratch.buf[base + 11] as u64);
            }
            if has_source_turret_blueprint_code {
                w.write_str("sourceTurretBlueprintCode");
                w.write_uint(scratch.buf[base + 12] as u64);
            }
            if has_source_turret_entity_id {
                w.write_str("sourceTurretEntityId");
                w.write_uint(scratch.buf[base + 25] as u64);
            }
            w.write_str("playerId");
            w.write_uint(scratch.buf[base + 13] as u64);
            w.write_str("sourceEntityId");
            w.write_uint(scratch.buf[base + 14] as u64);
            w.write_str("sourceHostEntityId");
            w.write_uint(scratch.buf[base + 26] as u64);
            w.write_str("sourceRootEntityId");
            w.write_uint(scratch.buf[base + 27] as u64);
            w.write_str("sourceTeamId");
            w.write_uint(scratch.buf[base + 28] as u64);
            w.write_str("spawnTick");
            w.write_uint(scratch.buf[base + 29] as u64);
            if has_parent_shot_entity_id {
                w.write_str("parentShotEntityId");
                w.write_uint(scratch.buf[base + 30] as u64);
            }
            w.write_str("turretIndex");
            w.write_uint(scratch.buf[base + 15] as u64);
            w.write_str("barrelIndex");
            w.write_uint(scratch.buf[base + 16] as u64);
            if has_is_dgun {
                w.write_str("isDGun");
                w.write_bool(has_is_dgun_true);
            }
            if has_from_parent {
                w.write_str("fromParentDetonation");
                w.write_bool(has_from_parent_true);
            }
            if has_beam {
                w.write_str("beam");
                w.write_map_header(2);
                w.write_str("start");
                w.write_map_header(3);
                w.write_str("x");
                w.write_number(scratch.buf[base + 17]);
                w.write_str("y");
                w.write_number(scratch.buf[base + 18]);
                w.write_str("z");
                w.write_number(scratch.buf[base + 19]);
                w.write_str("end");
                w.write_map_header(3);
                w.write_str("x");
                w.write_number(scratch.buf[base + 20]);
                w.write_str("y");
                w.write_number(scratch.buf[base + 21]);
                w.write_str("z");
                w.write_number(scratch.buf[base + 22]);
            }
            if has_target {
                w.write_str("targetEntityId");
                w.write_uint(scratch.buf[base + 23] as u64);
            }
            if has_homing {
                w.write_str("homingTurnRate");
                w.write_number(scratch.buf[base + 24]);
            }
        }
    }
    if has_despawns != 0 {
        let n = despawn_count as usize;
        let scratch = snapshot_encode_proj_despawn_scratch();
        w.write_str("despawns");
        w.write_array_header(n);
        for i in 0..n {
            // Despawn DTO: {id: number}
            w.write_map_header(1);
            w.write_str("id");
            w.write_uint(scratch.buf[i] as u64);
        }
    }
    if has_velocity_updates != 0 {
        let n = velocity_update_count as usize;
        let scratch = snapshot_encode_proj_vel_scratch();
        w.write_str("velocityUpdates");
        w.write_array_header(n);
        for i in 0..n {
            let base = i * SNAPSHOT_ENCODE_PROJ_VEL_STRIDE;
            let id = scratch.buf[base] as u32;
            let px = scratch.buf[base + 1];
            let py = scratch.buf[base + 2];
            let pz = scratch.buf[base + 3];
            let vx = scratch.buf[base + 4];
            let vy = scratch.buf[base + 5];
            let vz = scratch.buf[base + 6];
            let clear_homing_target = scratch.buf[base + 7] != 0.0;
            let target_entity_id = scratch.buf[base + 8] as u32;
            // velocityUpdate DTO: {id, pos: {x, y, z}, velocity: {x, y, z}, targetEntityId?, clearHomingTarget?}
            let mut field_count = 3;
            if target_entity_id > 0 {
                field_count += 1;
            }
            if clear_homing_target {
                field_count += 1;
            }
            w.write_map_header(field_count);
            w.write_str("id");
            w.write_uint(id as u64);
            w.write_str("pos");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(px);
            w.write_str("y");
            w.write_number(py);
            w.write_str("z");
            w.write_number(pz);
            w.write_str("velocity");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(vx);
            w.write_str("y");
            w.write_number(vy);
            w.write_str("z");
            w.write_number(vz);
            if target_entity_id > 0 {
                w.write_str("targetEntityId");
                w.write_uint(target_entity_id as u64);
            }
            if clear_homing_target {
                w.write_str("clearHomingTarget");
                w.write_bool(true);
            }
        }
    }
    if has_beam_updates != 0 {
        let n = beam_update_count as usize;
        let header_scratch = snapshot_encode_beam_update_scratch();
        let point_scratch = snapshot_encode_beam_point_scratch();
        w.write_str("beamUpdates");
        w.write_array_header(n);
        let mut point_offset: usize = 0;
        for i in 0..n {
            let h = i * SNAPSHOT_ENCODE_BEAM_UPDATE_STRIDE;
            let id = header_scratch.buf[h] as u32;
            let flags = header_scratch.buf[h + 1] as u32;
            let has_obstruction_t = (flags & 0x01) != 0;
            let has_endpoint_damageable_false = (flags & 0x02) != 0;
            let has_endpoint_damageable_true = (flags & 0x04) != 0;
            let has_endpoint_damageable =
                has_endpoint_damageable_false || has_endpoint_damageable_true;
            let obstruction_t = header_scratch.buf[h + 2];
            let point_count = header_scratch.buf[h + 3] as usize;

            // BeamUpdate DTO field count = always 2 (id + points) +
            // optional obstructionT + optional endpointDamageable.
            let mut field_count: usize = 2;
            if has_obstruction_t {
                field_count += 1;
            }
            if has_endpoint_damageable {
                field_count += 1;
            }
            w.write_map_header(field_count);

            // Pool order in createPooledBeamUpdate: id, points,
            // obstructionT, endpointDamageable.
            w.write_str("id");
            w.write_uint(id as u64);
            w.write_str("points");
            w.write_array_header(point_count);
            for p in 0..point_count {
                let pb = (point_offset + p) * SNAPSHOT_ENCODE_BEAM_POINT_STRIDE;
                let x = point_scratch.buf[pb];
                let y = point_scratch.buf[pb + 1];
                let z = point_scratch.buf[pb + 2];
                let vx = point_scratch.buf[pb + 3];
                let vy = point_scratch.buf[pb + 4];
                let vz = point_scratch.buf[pb + 5];
                let pflags = point_scratch.buf[pb + 6] as u32;
                let has_reflector_entity_id = (pflags & 0x01) != 0;
                let has_reflector_kind = (pflags & 0x02) != 0;
                let has_reflector_player = (pflags & 0x08) != 0;
                let has_normal_x = (pflags & 0x10) != 0;
                let has_normal_y = (pflags & 0x20) != 0;
                let has_normal_z = (pflags & 0x40) != 0;
                let reflector_entity_id = point_scratch.buf[pb + 7] as u32;
                let reflector_player = point_scratch.buf[pb + 8] as u32;
                let nx = point_scratch.buf[pb + 9];
                let ny = point_scratch.buf[pb + 10];
                let nz = point_scratch.buf[pb + 11];

                // BeamPoint DTO field count = always 6 (x,y,z,vx,vy,vz)
                // + optional reflector + normal fields. Acceleration is
                // intentionally not on the wire; clients extrapolate from
                // velocity only between path corrections.
                let mut pf_count: usize = 6;
                if has_reflector_entity_id {
                    pf_count += 1;
                }
                if has_reflector_kind {
                    pf_count += 1;
                }
                if has_reflector_player {
                    pf_count += 1;
                }
                if has_normal_x {
                    pf_count += 1;
                }
                if has_normal_y {
                    pf_count += 1;
                }
                if has_normal_z {
                    pf_count += 1;
                }
                w.write_map_header(pf_count);

                // Pool order from createPooledBeamPoint: x, y, z,
                // vx, vy, vz, [reflectorEntityId,
                // reflectorKind, reflectorPlayerId, normalX/Y/Z].
                w.write_str("x");
                w.write_number(x);
                w.write_str("y");
                w.write_number(y);
                w.write_str("z");
                w.write_number(z);
                w.write_str("vx");
                w.write_number(vx);
                w.write_str("vy");
                w.write_number(vy);
                w.write_str("vz");
                w.write_number(vz);
                if has_reflector_entity_id {
                    w.write_str("reflectorEntityId");
                    w.write_uint(reflector_entity_id as u64);
                }
                if has_reflector_kind {
                    w.write_str("reflectorKind");
                    w.write_str("shield");
                }
                if has_reflector_player {
                    w.write_str("reflectorPlayerId");
                    w.write_uint(reflector_player as u64);
                }
                if has_normal_x {
                    w.write_str("normalX");
                    w.write_number(nx);
                }
                if has_normal_y {
                    w.write_str("normalY");
                    w.write_number(ny);
                }
                if has_normal_z {
                    w.write_str("normalZ");
                    w.write_number(nz);
                }
            }
            point_offset += point_count;
            if has_obstruction_t {
                w.write_str("obstructionT");
                w.write_number(obstruction_t);
            }
            if has_endpoint_damageable {
                w.write_str("endpointDamageable");
                w.write_bool(has_endpoint_damageable_true);
            }
        }
    }
}

/// Append compact `projectiles: { v: 1, s?, d?, u?, b? }` from the
/// caller-filled projectile scratches. Matches
/// snapshotProjectileWirePack.ts while keeping the Rust send path
/// out of the TypeScript packed-binary writer.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_packed_projectiles(
    has_spawns: u8,
    spawn_count: u32,
    has_despawns: u8,
    despawn_count: u32,
    has_velocity_updates: u8,
    velocity_update_count: u32,
    has_beam_updates: u8,
    beam_update_count: u32,
    beam_point_count: u32,
) -> u32 {
    let w = messagepack_writer();
    let mut packed_key_count: usize = 1; // v
    if has_spawns != 0 {
        packed_key_count += 1;
    }
    if has_despawns != 0 {
        packed_key_count += 1;
    }
    if has_velocity_updates != 0 {
        packed_key_count += 1;
    }
    if has_beam_updates != 0 {
        packed_key_count += 1;
    }

    w.write_str("projectiles");
    w.write_map_header(packed_key_count);
    w.write_str("v");
    w.write_uint(PACKED_PROJECTILES_VERSION);

    if has_spawns != 0 {
        pack_projectile_spawns(spawn_count as usize);
        let packed = snapshot_encode_packed_projectile_scratch();
        w.write_str("s");
        w.write_bin(packed.out.as_slice());
    }
    if has_despawns != 0 {
        pack_projectile_despawns(despawn_count as usize);
        let packed = snapshot_encode_packed_projectile_scratch();
        w.write_str("d");
        w.write_bin(packed.out.as_slice());
    }
    if has_velocity_updates != 0 {
        pack_projectile_velocity_updates(velocity_update_count as usize);
        let packed = snapshot_encode_packed_projectile_scratch();
        w.write_str("u");
        w.write_bin(packed.out.as_slice());
    }
    if has_beam_updates != 0 {
        pack_projectile_beam_updates(beam_update_count as usize, beam_point_count as usize);
        let packed = snapshot_encode_packed_projectile_scratch();
        w.write_str("b");
        w.write_bin(packed.out.as_slice());
    }

    w.buf.len() as u32
}

/// Append the minimapEntities array. Called after the last
/// entity in the envelope's `entities[]` is written and BEFORE
/// snapshot_encode_envelope_continue runs (minimapEntities sits
/// between entities and economy in the pool insertion order).
/// Reads count entries from the minimap scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_minimap(count: u32) {
    let w = messagepack_writer();
    let scratch = snapshot_encode_minimap_scratch();
    let n = count as usize;
    w.write_str("minimapEntities");
    w.write_array_header(n);
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_MINIMAP_STRIDE;
        let id = scratch.buf[base] as u32;
        let pos_x = scratch.buf[base + 1];
        let pos_y = scratch.buf[base + 2];
        let type_tag = scratch.buf[base + 3] as u8;
        let player_id = scratch.buf[base + 4] as u8;
        let radar_packed = scratch.buf[base + 5] as u8;
        let has_radar = (radar_packed & 0x01) != 0;
        let radar_value = (radar_packed & 0x02) != 0;

        // Pool insertion order for the minimap DTO: id, pos, type,
        // playerId, radarOnly.
        let field_count = if has_radar { 5 } else { 4 };
        w.write_map_header(field_count);
        w.write_str("id");
        w.write_uint(id as u64);
        w.write_str("pos");
        w.write_map_header(2);
        w.write_str("x");
        w.write_number(pos_x);
        w.write_str("y");
        w.write_number(pos_y);
        w.write_str("type");
        match type_tag {
            SNAPSHOT_ENTITY_TYPE_UNIT => w.write_str("unit"),
            SNAPSHOT_ENTITY_TYPE_BUILDING => w.write_str("building"),
            SNAPSHOT_ENTITY_TYPE_TOWER => w.write_str("tower"),
            _ => w.write_str(""),
        }
        w.write_str("playerId");
        w.write_uint(player_id as u64);
        if has_radar {
            w.write_str("radarOnly");
            w.write_bool(radar_value);
        }
    }
}

/// Append compact `minimapEntities: { v: 2, b }` from the minimap
/// scratch. Matches snapshotMinimapWirePack.ts V2 while keeping the
/// Rust snapshot send path out of the TypeScript packed-binary writer.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_packed_minimap(count: u32) -> u32 {
    let w = messagepack_writer();
    pack_minimap_entities_v2(count as usize);
    let packed = snapshot_encode_packed_minimap_scratch();

    w.write_str("minimapEntities");
    w.write_map_header(2);
    w.write_str("v");
    w.write_uint(PACKED_MINIMAP_ENTITIES_VERSION);
    w.write_str("b");
    w.write_bin(packed.out.as_slice());
    w.buf.len() as u32
}

/// Append the economy key. Sits between minimapEntities and
/// sprayTargets in pool insertion order. Body is a Record<PlayerId,
/// EconomySnapshot>; the caller pre-packs the economy scratch with
/// per-player data sorted ASC by playerId (so msgpack key iteration
/// matches @msgpack/msgpack on a JS object with integer-string keys),
/// then passes the player count.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_economy(player_count: u32) -> u32 {
    let w = messagepack_writer();
    let n = player_count as usize;
    w.write_str("economy");
    w.write_map_header(n);
    if n == 0 {
        return w.buf.len() as u32;
    }
    let scratch = snapshot_encode_economy_scratch();
    let mut key_buf = [0u8; 12];
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_ECONOMY_STRIDE;
        let player_id = scratch.buf[base] as u32;
        let key_str = u32_to_decimal(&mut key_buf, player_id);
        w.write_str(key_str);

        // Per-player DTO field count = 4 (stockpile, income,
        // expenditure, metal — all required).
        w.write_map_header(4);
        // stockpile: { curr, max }
        w.write_str("stockpile");
        w.write_map_header(2);
        w.write_str("curr");
        w.write_number(scratch.buf[base + 1]);
        w.write_str("max");
        w.write_number(scratch.buf[base + 2]);
        // income: { base, production }
        w.write_str("income");
        w.write_map_header(2);
        w.write_str("base");
        w.write_number(scratch.buf[base + 3]);
        w.write_str("production");
        w.write_number(scratch.buf[base + 4]);
        // expenditure
        w.write_str("expenditure");
        w.write_number(scratch.buf[base + 5]);
        // metal: { stockpile, income, expenditure }
        w.write_str("metal");
        w.write_map_header(3);
        w.write_str("stockpile");
        w.write_map_header(2);
        w.write_str("curr");
        w.write_number(scratch.buf[base + 6]);
        w.write_str("max");
        w.write_number(scratch.buf[base + 7]);
        w.write_str("income");
        w.write_map_header(2);
        w.write_str("base");
        w.write_number(scratch.buf[base + 8]);
        w.write_str("extraction");
        w.write_number(scratch.buf[base + 9]);
        w.write_str("expenditure");
        w.write_number(scratch.buf[base + 10]);
    }
    w.buf.len() as u32
}

/// Append `resourceMovements: [...]`. Sits between economy and
/// sprayTargets in pool insertion order. Each movement is emitted as
/// the full DTO map; targetEntityId is null when the row's has-target
/// flag is unset.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_resource_movements(count: u32) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    w.write_str("resourceMovements");
    w.write_array_header(n);
    if n == 0 {
        return w.buf.len() as u32;
    }

    let scratch = snapshot_encode_resource_movement_scratch();
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_RESOURCE_MOVEMENT_STRIDE;
        w.write_map_header(6);

        w.write_str("playerId");
        w.write_uint(scratch.buf[base] as u64);

        w.write_str("sourceEntityId");
        w.write_uint(scratch.buf[base + 1] as u64);

        w.write_str("targetEntityId");
        if scratch.buf[base + 6] != 0.0 {
            w.write_uint(scratch.buf[base + 2] as u64);
        } else {
            w.write_nil();
        }

        w.write_str("resource");
        w.write_uint(scratch.buf[base + 3] as u64);

        w.write_str("amountPerSecond");
        w.write_number(scratch.buf[base + 4]);

        w.write_str("direction");
        w.write_uint(scratch.buf[base + 5] as u64);
    }
    w.buf.len() as u32
}

/// Append `audioEvents: [...]`. Sits between sprayTargets and
/// projectiles in iteration order. Per-event pool-iteration order
/// matches NetworkServerSnapshotSimEvent / createPooledSimEvent:
/// type, turretBlueprintId, sourceType, sourceKey, pos, playerId, entityId,
/// deathContext, impactContext, waterSplash, shieldImpact,
/// killerPlayerId, victimPlayerId, audioOnly.
///
/// D.3j-27 adds deathContext + impactContext support. Caller pre-packs
/// per-context scratches in event order; the encoder walks audio
/// events with local offsets into each context scratch.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_audio_events(count: u32) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    let scratch = snapshot_encode_audio_event_scratch();
    let death_scratch = snapshot_encode_death_context_scratch();
    let pose_scratch = snapshot_encode_turret_pose_scratch();
    let impact_scratch = snapshot_encode_impact_context_scratch();
    w.write_str("audioEvents");
    w.write_array_header(n);
    let mut death_offset: usize = 0;
    let mut pose_offset: usize = 0;
    let mut impact_offset: usize = 0;
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE;
        let type_code = scratch.buf[base] as u8;
        let pos_x = scratch.buf[base + 1];
        let pos_y = scratch.buf[base + 2];
        let pos_z = scratch.buf[base + 3];
        let player_id = scratch.buf[base + 4] as u32;
        let entity_id = scratch.buf[base + 5] as u32;
        let killer_player_id = scratch.buf[base + 6] as u32;
        let victim_player_id = scratch.buf[base + 7] as u32;
        let ff_nx = scratch.buf[base + 8];
        let ff_ny = scratch.buf[base + 9];
        let ff_nz = scratch.buf[base + 10];
        let ff_player_id = scratch.buf[base + 11] as u32;
        let source_type_code = scratch.buf[base + 12] as u8;
        let turret_id_slot = scratch.buf[base + 13] as u32;
        let source_key_slot = scratch.buf[base + 14] as u32;
        let flags = scratch.buf[base + 15] as u32;

        let has_source_type = (flags & 0x001) != 0;
        let has_source_key = (flags & 0x002) != 0;
        let has_player_id = (flags & 0x004) != 0;
        let has_entity_id = (flags & 0x008) != 0;
        let has_ff_impact = (flags & 0x010) != 0;
        let has_killer = (flags & 0x020) != 0;
        let has_victim = (flags & 0x040) != 0;
        let has_audio_only = (flags & 0x080) != 0;
        let audio_only_value = (flags & 0x100) != 0;
        let has_death_context = (flags & 0x200) != 0;
        let has_impact_context = (flags & 0x400) != 0;
        let has_water_splash = (flags & 0x800) != 0;

        // Per-event field count: 3 always (type, turretBlueprintId, pos) +
        // optionals.
        let mut field_count: usize = 3;
        if has_source_type {
            field_count += 1;
        }
        if has_source_key {
            field_count += 1;
        }
        if has_player_id {
            field_count += 1;
        }
        if has_entity_id {
            field_count += 1;
        }
        if has_death_context {
            field_count += 1;
        }
        if has_impact_context {
            field_count += 1;
        }
        if has_water_splash {
            field_count += 1;
        }
        if has_ff_impact {
            field_count += 1;
        }
        if has_killer {
            field_count += 1;
        }
        if has_victim {
            field_count += 1;
        }
        if has_audio_only {
            field_count += 1;
        }
        w.write_map_header(field_count);

        // Pool-iteration order as documented above.
        w.write_str("type");
        w.write_str(audio_event_type_str(type_code));
        w.write_str("turretBlueprintId");
        write_string_from_scratch(w, turret_id_slot);
        if has_source_type {
            w.write_str("sourceType");
            w.write_str(audio_event_source_type_str(source_type_code));
        }
        if has_source_key {
            w.write_str("sourceKey");
            write_string_from_scratch(w, source_key_slot);
        }
        w.write_str("pos");
        w.write_map_header(3);
        w.write_str("x");
        w.write_number(pos_x);
        w.write_str("y");
        w.write_number(pos_y);
        w.write_str("z");
        w.write_number(pos_z);
        if has_player_id {
            w.write_str("playerId");
            w.write_uint(player_id as u64);
        }
        if has_entity_id {
            w.write_str("entityId");
            w.write_uint(entity_id as u64);
        }
        if has_death_context {
            let db = death_offset * SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE;
            let unit_vel_x = death_scratch.buf[db];
            let unit_vel_y = death_scratch.buf[db + 1];
            let hit_dir_x = death_scratch.buf[db + 2];
            let hit_dir_y = death_scratch.buf[db + 3];
            let proj_vel_x = death_scratch.buf[db + 4];
            let proj_vel_y = death_scratch.buf[db + 5];
            let attack_magnitude = death_scratch.buf[db + 6];
            let radius = death_scratch.buf[db + 7];
            let color = death_scratch.buf[db + 8];
            let visual_radius = death_scratch.buf[db + 9];
            let death_collision_radius = death_scratch.buf[db + 10];
            let base_z = death_scratch.buf[db + 11];
            let rotation = death_scratch.buf[db + 12];
            let unit_type_slot = death_scratch.buf[db + 13] as u32;
            let turret_pose_count = death_scratch.buf[db + 14] as usize;
            let dflags = death_scratch.buf[db + 15] as u32;

            let has_visual_radius = (dflags & 0x01) != 0;
            let has_collision_radius = (dflags & 0x02) != 0;
            let has_base_z = (dflags & 0x04) != 0;
            let has_unit_type = (dflags & 0x08) != 0;
            let has_rotation = (dflags & 0x10) != 0;
            let has_turret_poses = (dflags & 0x20) != 0;

            // Field count: 6 always (unitVel, hitDir, projectileVel,
            // attackMagnitude, radius, color) + optionals.
            let mut dc_field_count: usize = 6;
            if has_visual_radius {
                dc_field_count += 1;
            }
            if has_collision_radius {
                dc_field_count += 1;
            }
            if has_base_z {
                dc_field_count += 1;
            }
            if has_unit_type {
                dc_field_count += 1;
            }
            if has_rotation {
                dc_field_count += 1;
            }
            if has_turret_poses {
                dc_field_count += 1;
            }

            w.write_str("deathContext");
            w.write_map_header(dc_field_count);

            // Literal order from damageHelpers.ts: unitVel, hitDir,
            // projectileVel, attackMagnitude, radius, visualRadius,
            // collisionRadius, baseZ, color, unitBlueprintId, rotation, turretPoses.
            w.write_str("unitVel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(unit_vel_x);
            w.write_str("y");
            w.write_number(unit_vel_y);
            w.write_str("hitDir");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(hit_dir_x);
            w.write_str("y");
            w.write_number(hit_dir_y);
            w.write_str("projectileVel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(proj_vel_x);
            w.write_str("y");
            w.write_number(proj_vel_y);
            w.write_str("attackMagnitude");
            w.write_number(attack_magnitude);
            w.write_str("radius");
            w.write_number(radius);
            if has_visual_radius {
                w.write_str("visualRadius");
                w.write_number(visual_radius);
            }
            if has_collision_radius {
                w.write_str("collisionRadius");
                w.write_number(death_collision_radius);
            }
            if has_base_z {
                w.write_str("baseZ");
                w.write_number(base_z);
            }
            w.write_str("color");
            w.write_number(color);
            if has_unit_type {
                w.write_str("unitBlueprintId");
                write_string_from_scratch(w, unit_type_slot);
            }
            if has_rotation {
                w.write_str("rotation");
                w.write_number(rotation);
            }
            if has_turret_poses {
                w.write_str("turretPoses");
                w.write_array_header(turret_pose_count);
                for p in 0..turret_pose_count {
                    let pb = (pose_offset + p) * SNAPSHOT_ENCODE_TURRET_POSE_STRIDE;
                    let rot = pose_scratch.buf[pb];
                    let pitch = pose_scratch.buf[pb + 1];
                    // Inner pose DTO: {rotation, pitch}
                    w.write_map_header(2);
                    w.write_str("rotation");
                    w.write_number(rot);
                    w.write_str("pitch");
                    w.write_number(pitch);
                }
                pose_offset += turret_pose_count;
            }
            death_offset += 1;
        }
        if has_impact_context {
            let ib = impact_offset * SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE;
            let radius_collision = impact_scratch.buf[ib];
            let death_explosion_radius = impact_scratch.buf[ib + 1];
            let proj_pos_x = impact_scratch.buf[ib + 2];
            let proj_pos_y = impact_scratch.buf[ib + 3];
            let proj_vel_x = impact_scratch.buf[ib + 4];
            let proj_vel_y = impact_scratch.buf[ib + 5];
            let entity_vel_x = impact_scratch.buf[ib + 6];
            let entity_vel_y = impact_scratch.buf[ib + 7];
            let entity_radius = impact_scratch.buf[ib + 8];
            let pen_dir_x = impact_scratch.buf[ib + 9];
            let pen_dir_y = impact_scratch.buf[ib + 10];

            w.write_str("impactContext");
            // Per the ImpactContext type def, all 5 fields are
            // required: radiusCollision, deathExplosionRadius, projectile,
            // entity, penetrationDir.
            w.write_map_header(5);
            w.write_str("radiusCollision");
            w.write_number(radius_collision);
            w.write_str("deathExplosionRadius");
            w.write_number(death_explosion_radius);
            w.write_str("projectile");
            w.write_map_header(2);
            w.write_str("pos");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(proj_pos_x);
            w.write_str("y");
            w.write_number(proj_pos_y);
            w.write_str("vel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(proj_vel_x);
            w.write_str("y");
            w.write_number(proj_vel_y);
            w.write_str("entity");
            w.write_map_header(2);
            w.write_str("vel");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(entity_vel_x);
            w.write_str("y");
            w.write_number(entity_vel_y);
            w.write_str("radiusCollision");
            w.write_number(entity_radius);
            w.write_str("penetrationDir");
            w.write_map_header(2);
            w.write_str("x");
            w.write_number(pen_dir_x);
            w.write_str("y");
            w.write_number(pen_dir_y);
            impact_offset += 1;
        }
        if has_water_splash {
            w.write_str("waterSplash");
            w.write_map_header(2);
            w.write_str("velocity");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(scratch.buf[base + 16]);
            w.write_str("y");
            w.write_number(scratch.buf[base + 17]);
            w.write_str("z");
            w.write_number(scratch.buf[base + 18]);
            w.write_str("mass");
            w.write_number(scratch.buf[base + 19]);
        }
        if has_ff_impact {
            w.write_str("shieldImpact");
            // Pool order: normal, playerId (from copySimEventInto's
            // defensive literal).
            w.write_map_header(2);
            w.write_str("normal");
            w.write_map_header(3);
            w.write_str("x");
            w.write_number(ff_nx);
            w.write_str("y");
            w.write_number(ff_ny);
            w.write_str("z");
            w.write_number(ff_nz);
            w.write_str("playerId");
            w.write_uint(ff_player_id as u64);
        }
        if has_killer {
            w.write_str("killerPlayerId");
            w.write_uint(killer_player_id as u64);
        }
        if has_victim {
            w.write_str("victimPlayerId");
            w.write_uint(victim_player_id as u64);
        }
        if has_audio_only {
            w.write_str("audioOnly");
            w.write_bool(audio_only_value);
        }
    }
    w.buf.len() as u32
}

/// Append compact `audioEvents: { v, s, e, d?, i?, t? }` from the
/// caller-filled scratch buffers. This matches snapshotAudioWirePack.ts
/// byte-for-byte while avoiding transient nested JS row arrays on the
/// Rust snapshot send path.
#[wasm_bindgen]
pub fn snapshot_encode_envelope_emit_packed_audio_events(
    count: u32,
    string_count: u32,
    death_context_count: u32,
    impact_context_count: u32,
    turret_pose_count: u32,
) -> u32 {
    let w = messagepack_writer();
    let n = count as usize;
    let string_n = string_count as usize;
    let death_n = death_context_count as usize;
    let impact_n = impact_context_count as usize;
    let pose_n = turret_pose_count as usize;
    let scratch = snapshot_encode_audio_event_scratch();
    let death_scratch = snapshot_encode_death_context_scratch();
    let impact_scratch = snapshot_encode_impact_context_scratch();
    let pose_scratch = snapshot_encode_turret_pose_scratch();

    w.write_str("audioEvents");
    let mut packed_key_count = 3usize; // v, s, e
    if death_n > 0 {
        packed_key_count += 1;
    }
    if impact_n > 0 {
        packed_key_count += 1;
    }
    if pose_n > 0 {
        packed_key_count += 1;
    }
    w.write_map_header(packed_key_count);

    w.write_str("v");
    w.write_uint(2);

    w.write_str("s");
    w.write_array_header(string_n);
    for slot in 0..string_n {
        write_string_from_scratch(w, slot as u32);
    }

    w.write_str("e");
    w.write_array_header(n);
    for i in 0..n {
        let base = i * SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE;
        let flags = scratch.buf[base + 15] as u32;
        let mut row_len = 6usize;
        if (flags & 0x001) != 0 {
            row_len += 1;
        }
        if (flags & 0x002) != 0 {
            row_len += 1;
        }
        if (flags & 0x004) != 0 {
            row_len += 1;
        }
        if (flags & 0x008) != 0 {
            row_len += 1;
        }
        if (flags & 0x010) != 0 {
            row_len += 4;
        }
        if (flags & 0x020) != 0 {
            row_len += 1;
        }
        if (flags & 0x040) != 0 {
            row_len += 1;
        }
        if (flags & 0x080) != 0 {
            row_len += 1;
        }
        if (flags & 0x800) != 0 {
            row_len += 4;
        }

        w.write_array_header(row_len);
        w.write_number(scratch.buf[base]);
        w.write_number(flags as f64);
        w.write_number(scratch.buf[base + 13]);
        w.write_number(scratch.buf[base + 1]);
        w.write_number(scratch.buf[base + 2]);
        w.write_number(scratch.buf[base + 3]);
        if (flags & 0x001) != 0 {
            w.write_number(scratch.buf[base + 12]);
        }
        if (flags & 0x002) != 0 {
            w.write_number(scratch.buf[base + 14]);
        }
        if (flags & 0x004) != 0 {
            w.write_number(scratch.buf[base + 4]);
        }
        if (flags & 0x008) != 0 {
            w.write_number(scratch.buf[base + 5]);
        }
        if (flags & 0x010) != 0 {
            w.write_number(scratch.buf[base + 8]);
            w.write_number(scratch.buf[base + 9]);
            w.write_number(scratch.buf[base + 10]);
            w.write_number(scratch.buf[base + 11]);
        }
        if (flags & 0x020) != 0 {
            w.write_number(scratch.buf[base + 6]);
        }
        if (flags & 0x040) != 0 {
            w.write_number(scratch.buf[base + 7]);
        }
        if (flags & 0x080) != 0 {
            w.write_number(if (flags & 0x100) != 0 { 1.0 } else { 0.0 });
        }
        if (flags & 0x800) != 0 {
            w.write_number(scratch.buf[base + 16]);
            w.write_number(scratch.buf[base + 17]);
            w.write_number(scratch.buf[base + 18]);
            w.write_number(scratch.buf[base + 19]);
        }
    }

    if death_n > 0 {
        w.write_str("d");
        w.write_array_header(death_n);
        for i in 0..death_n {
            let base = i * SNAPSHOT_ENCODE_DEATH_CONTEXT_STRIDE;
            let flags = death_scratch.buf[base] as u32;
            let mut row_len = 10usize;
            if (flags & 0x01) != 0 {
                row_len += 1;
            }
            if (flags & 0x02) != 0 {
                row_len += 1;
            }
            if (flags & 0x04) != 0 {
                row_len += 1;
            }
            if (flags & 0x08) != 0 {
                row_len += 1;
            }
            if (flags & 0x10) != 0 {
                row_len += 1;
            }
            if (flags & 0x20) != 0 {
                row_len += 1;
            }

            w.write_array_header(row_len);
            w.write_number(flags as f64);
            for offset in 1..=9 {
                w.write_number(death_scratch.buf[base + offset]);
            }
            if (flags & 0x01) != 0 {
                w.write_number(death_scratch.buf[base + 10]);
            }
            if (flags & 0x02) != 0 {
                w.write_number(death_scratch.buf[base + 11]);
            }
            if (flags & 0x04) != 0 {
                w.write_number(death_scratch.buf[base + 12]);
            }
            if (flags & 0x08) != 0 {
                w.write_number(death_scratch.buf[base + 13]);
            }
            if (flags & 0x10) != 0 {
                w.write_number(death_scratch.buf[base + 14]);
            }
            if (flags & 0x20) != 0 {
                w.write_number(death_scratch.buf[base + 15]);
            }
        }
    }

    if impact_n > 0 {
        w.write_str("i");
        w.write_array_header(impact_n);
        for i in 0..impact_n {
            let base = i * SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE;
            w.write_array_header(SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE);
            for offset in 0..SNAPSHOT_ENCODE_IMPACT_CONTEXT_STRIDE {
                w.write_number(impact_scratch.buf[base + offset]);
            }
        }
    }

    if pose_n > 0 {
        w.write_str("t");
        w.write_array_header(pose_n);
        for i in 0..pose_n {
            let base = i * SNAPSHOT_ENCODE_TURRET_POSE_STRIDE;
            w.write_array_header(SNAPSHOT_ENCODE_TURRET_POSE_STRIDE);
            w.write_number(pose_scratch.buf[base]);
            w.write_number(pose_scratch.buf[base + 1]);
        }
    }

    w.buf.len() as u32
}
