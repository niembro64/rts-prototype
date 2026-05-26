use core::fmt::Write;
use wasm_bindgen::prelude::*;

const RUNTIME_PROTOCOL: &str = "ba-rust-sim-runtime-v1";
const RENDER_PACKET_PROTOCOL: &str = "ba-rust-render-packet-v1";
const FNV1A_64_OFFSET: u64 = 0xcbf29ce484222325;
const FNV1A_64_PRIME: u64 = 0x100000001b3;

#[derive(Clone)]
struct RuntimeManifest {
    manifest_hash: String,
    manifest_hash_value: u64,
    game_id: String,
    room_code: String,
    map_seed: u32,
    initial_rng_seed: u32,
    command_schema_version: u32,
    sim_version: String,
    map_width_land_cells: u32,
    map_length_land_cells: u32,
    player_count: u32,
}

#[derive(Clone)]
struct RuntimeCommandBundle {
    target_tick: u32,
    peer_id: u32,
    seq: u32,
    command_count: u32,
}

#[wasm_bindgen]
pub struct LockstepRuntime {
    manifest: RuntimeManifest,
    tick: u32,
    rng_state: u32,
    pending_bundles: Vec<RuntimeCommandBundle>,
    total_enqueued_bundle_count: u32,
    total_enqueued_command_count: u32,
    total_applied_bundle_count: u32,
    total_applied_command_count: u32,
    last_applied_bundle_count: u32,
    last_applied_command_count: u32,
}

#[wasm_bindgen]
impl LockstepRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new(
        manifest_hash: String,
        game_id: String,
        room_code: String,
        map_seed: u32,
        initial_rng_seed: u32,
        command_schema_version: u32,
        sim_version: String,
        map_width_land_cells: u32,
        map_length_land_cells: u32,
        player_count: u32,
    ) -> Result<LockstepRuntime, JsValue> {
        if player_count == 0 {
            return Err(js_error(
                "battle manifest must include at least one player slot",
            ));
        }
        if map_width_land_cells == 0 || map_length_land_cells == 0 {
            return Err(js_error("battle manifest map dimensions must be non-zero"));
        }
        let manifest_hash_value = parse_manifest_hash(&manifest_hash)?;
        let manifest = RuntimeManifest {
            manifest_hash,
            manifest_hash_value,
            game_id,
            room_code,
            map_seed,
            initial_rng_seed,
            command_schema_version,
            sim_version,
            map_width_land_cells,
            map_length_land_cells,
            player_count,
        };
        let rng_state = manifest.initial_rng_seed;
        Ok(LockstepRuntime {
            manifest,
            tick: 0,
            rng_state,
            pending_bundles: Vec::new(),
            total_enqueued_bundle_count: 0,
            total_enqueued_command_count: 0,
            total_applied_bundle_count: 0,
            total_applied_command_count: 0,
            last_applied_bundle_count: 0,
            last_applied_command_count: 0,
        })
    }

    pub fn tick(&self) -> u32 {
        self.tick
    }

    pub fn manifest_hash(&self) -> String {
        self.manifest.manifest_hash.clone()
    }

    pub fn enqueue_command_bundle(
        &mut self,
        target_tick: u32,
        peer_id: u32,
        seq: u32,
        command_count: u32,
    ) -> Result<(), JsValue> {
        if target_tick < self.tick {
            return Err(js_error(format!(
                "cannot enqueue command bundle for past tick {target_tick}; runtime is at tick {}",
                self.tick,
            )));
        }
        if peer_id == 0 {
            return Err(js_error("peer_id must be non-zero"));
        }
        self.pending_bundles.push(RuntimeCommandBundle {
            target_tick,
            peer_id,
            seq,
            command_count,
        });
        self.pending_bundles.sort_by(|a, b| {
            a.target_tick
                .cmp(&b.target_tick)
                .then(a.peer_id.cmp(&b.peer_id))
                .then(a.seq.cmp(&b.seq))
        });
        self.total_enqueued_bundle_count = self.total_enqueued_bundle_count.wrapping_add(1);
        self.total_enqueued_command_count = self
            .total_enqueued_command_count
            .wrapping_add(command_count);
        Ok(())
    }

    pub fn advance_one_tick(&mut self) -> Result<u32, JsValue> {
        if let Some(bundle) = self
            .pending_bundles
            .iter()
            .find(|bundle| bundle.target_tick < self.tick)
        {
            return Err(js_error(format!(
                "late command bundle for tick {} is still pending at runtime tick {}",
                bundle.target_tick, self.tick,
            )));
        }

        let current_tick = self.tick;
        let mut retained = Vec::with_capacity(self.pending_bundles.len());
        let mut applied_bundle_count = 0u32;
        let mut applied_command_count = 0u32;

        for bundle in core::mem::take(&mut self.pending_bundles) {
            if bundle.target_tick == current_tick {
                applied_bundle_count = applied_bundle_count.wrapping_add(1);
                applied_command_count = applied_command_count.wrapping_add(bundle.command_count);
                self.rng_state = mix_runtime_rng(self.rng_state, &bundle);
            } else {
                retained.push(bundle);
            }
        }

        self.pending_bundles = retained;
        self.last_applied_bundle_count = applied_bundle_count;
        self.last_applied_command_count = applied_command_count;
        self.total_applied_bundle_count = self
            .total_applied_bundle_count
            .wrapping_add(applied_bundle_count);
        self.total_applied_command_count = self
            .total_applied_command_count
            .wrapping_add(applied_command_count);
        self.tick = self.tick.wrapping_add(1);
        Ok(self.tick)
    }

    pub fn render_packet_json(&self) -> String {
        format!(
            "{{\"protocol\":\"{}\",\"runtimeProtocol\":\"{}\",\"tick\":{},\"mapWidthLandCells\":{},\"mapLengthLandCells\":{},\"entities\":[]}}",
            RENDER_PACKET_PROTOCOL,
            RUNTIME_PROTOCOL,
            self.tick,
            self.manifest.map_width_land_cells,
            self.manifest.map_length_land_cells,
        )
    }

    pub fn diagnostics_json(&self) -> String {
        format!(
            "{{\"protocol\":{},\"tick\":{},\"manifestHash\":{},\"gameId\":{},\"roomCode\":{},\"simVersion\":{},\"commandSchemaVersion\":{},\"mapSeed\":{},\"rngState\":{},\"mapWidthLandCells\":{},\"mapLengthLandCells\":{},\"playerCount\":{},\"pendingBundleCount\":{},\"enqueuedBundleCount\":{},\"enqueuedCommandCount\":{},\"appliedBundleCount\":{},\"appliedCommandCount\":{},\"lastAppliedBundleCount\":{},\"lastAppliedCommandCount\":{}}}",
            json_quote(RUNTIME_PROTOCOL),
            self.tick,
            json_quote(&self.manifest.manifest_hash),
            json_quote(&self.manifest.game_id),
            json_quote(&self.manifest.room_code),
            json_quote(&self.manifest.sim_version),
            self.manifest.command_schema_version,
            self.manifest.map_seed,
            self.rng_state,
            self.manifest.map_width_land_cells,
            self.manifest.map_length_land_cells,
            self.manifest.player_count,
            self.pending_bundles.len(),
            self.total_enqueued_bundle_count,
            self.total_enqueued_command_count,
            self.total_applied_bundle_count,
            self.total_applied_command_count,
            self.last_applied_bundle_count,
            self.last_applied_command_count,
        )
    }

    pub fn world_hash(&self) -> String {
        let mut hash = FNV1A_64_OFFSET;
        hash_update_str(&mut hash, RUNTIME_PROTOCOL);
        hash_update_u64(&mut hash, self.manifest.manifest_hash_value);
        hash_update_u32(&mut hash, self.tick);
        hash_update_u32(&mut hash, self.rng_state);
        hash_update_u32(&mut hash, self.manifest.map_seed);
        hash_update_u32(&mut hash, self.manifest.initial_rng_seed);
        hash_update_u32(&mut hash, self.manifest.command_schema_version);
        hash_update_u32(&mut hash, self.manifest.map_width_land_cells);
        hash_update_u32(&mut hash, self.manifest.map_length_land_cells);
        hash_update_u32(&mut hash, self.manifest.player_count);
        hash_update_u32(&mut hash, self.total_enqueued_bundle_count);
        hash_update_u32(&mut hash, self.total_enqueued_command_count);
        hash_update_u32(&mut hash, self.total_applied_bundle_count);
        hash_update_u32(&mut hash, self.total_applied_command_count);
        hash_update_u32(&mut hash, self.pending_bundles.len() as u32);
        for bundle in &self.pending_bundles {
            hash_update_u32(&mut hash, bundle.target_tick);
            hash_update_u32(&mut hash, bundle.peer_id);
            hash_update_u32(&mut hash, bundle.seq);
            hash_update_u32(&mut hash, bundle.command_count);
        }
        format_hash(hash)
    }
}

fn mix_runtime_rng(state: u32, bundle: &RuntimeCommandBundle) -> u32 {
    let mut x = state
        ^ bundle.target_tick.wrapping_mul(0x9e37_79b9)
        ^ bundle.peer_id.wrapping_mul(0x85eb_ca6b)
        ^ bundle.seq.wrapping_mul(0xc2b2_ae35)
        ^ bundle.command_count.wrapping_mul(0x27d4_eb2f);
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^ (x >> 16)
}

fn parse_manifest_hash(value: &str) -> Result<u64, JsValue> {
    let Some(hex) = value.strip_prefix("fnv1a64:") else {
        return Err(js_error(
            "battle manifest hash must use fnv1a64:<hex> format",
        ));
    };
    if hex.len() != 16 {
        return Err(js_error("battle manifest hash must contain 16 hex digits"));
    }
    u64::from_str_radix(hex, 16)
        .map_err(|_| js_error("battle manifest hash contains invalid hex digits"))
}

fn json_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c <= '\u{1f}' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn hash_update_bytes(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(FNV1A_64_PRIME);
    }
}

fn hash_update_str(hash: &mut u64, value: &str) {
    hash_update_u32(hash, value.len() as u32);
    hash_update_bytes(hash, value.as_bytes());
}

fn hash_update_u32(hash: &mut u64, value: u32) {
    hash_update_bytes(hash, &value.to_le_bytes());
}

fn hash_update_u64(hash: &mut u64, value: u64) {
    hash_update_bytes(hash, &value.to_le_bytes());
}

fn format_hash(hash: u64) -> String {
    format!("fnv1a64:{hash:016x}")
}

fn js_error(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}
