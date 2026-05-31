# Authoritative Simulation Ledger

Last audited: 2026-05-31.

This ledger tracks the current source of truth for authoritative simulation behavior while the project migrates toward Rust/WASM-owned tick work. It is intentionally limited to server/host simulation behavior; client rendering and prediction are separate presentation paths.

Status terms:

- `Rust/WASM-owned`: the authoritative behavior lives in `rts-sim-wasm`; TypeScript only allocates, stamps inputs, calls exported kernels, or reads results.
- `Transitional`: Rust/WASM owns a dense kernel or state slab, but TypeScript still owns orchestration or object write-back around it.
- `TypeScript-orchestrated`: authoritative behavior still runs in TypeScript and is migration work under C1.

When moving a row from `TypeScript-orchestrated` or `Transitional` to `Rust/WASM-owned`, delete the replaced TypeScript behavior in the same change. Do not leave a second callable implementation for safety.

## Rust/WASM-Owned

| System | Current owner | TypeScript role |
| --- | --- | --- |
| Dynamic body integration, gravity, terrain spring contact, air drag, ground friction, and unit/building collision response | `rts-sim-wasm/src/lib.rs` body pool and contact kernels | `src/game/server/PhysicsEngine3D.ts` allocates slots, samples terrain inputs where needed, calls step kernels, and syncs body results back to entities |
| Spatial partitioning and broadphase query kernels for units, buildings, and projectiles | `rts-sim-wasm/src/lib.rs` spatial grid | `src/game/sim/SpatialGrid.ts` maps entity ids to slots and resolves query slot ids back to live entity objects |
| Terrain adaptive mesh build, terrain surface sampling, terrain line of sight, terrain cell index, and buildability bake fast paths | `rts-sim-wasm/src/lib.rs` terrain kernels | `src/game/sim/terrain/*` assembles inputs, installs mesh data, and keeps JS fallback/read helpers for non-authoritative setup paths |
| Snapshot binary entity/detail encoding hot loops | `rts-sim-wasm/src/lib.rs` snapshot encoder | `src/game/network/snapshotRustWireEncoder.ts` packs arguments and owns network transport |
| Blueprint/shot schema surfaces | `src/game/sim/blueprints/blueprintSchema.json` via `scripts/generateBlueprintSchemaTypes.mjs` and `rts-sim-wasm/build.rs` | TypeScript and Rust consume generated surfaces from one schema |
| Factory construction-site placement and spawn-overlap geometry | `rts-sim-wasm/src/lib.rs` `factory_build_spot` and `factory_build_spot_blocked` | `src/game/sim/factoryConstructionSite.ts` supplies authored footprint/radius config and entity/rally inputs; `factoryProduction.ts` packs live obstacle radii and applies the returned clear/blocked result |
| Deterministic wind oscillator and wind producer-rate aggregation | `rts-sim-wasm/src/lib.rs` `wind_sample_state` and `economy_accumulate_player_rates`, with oscillator constants generated from `src/windConfig.json` | `src/game/sim/wind.ts` calls the oscillator, packs active wind producer rates, and applies the resulting per-player production-rate deltas |
| Economy stockpile clamps, batched income/converter application, construction/repair equal-share debit allocation, and construction/repair consumer spend application | `rts-sim-wasm/src/lib.rs` `economy_*` and `construction_apply_consumer_spends` helpers | `src/game/sim/economy.ts` and `energyDistribution.ts` pack rows, copy back player stockpiles, scatter spend results onto entity objects, and record renderer-facing resource movement events |

## Transitional

| System | Rust/WASM authority today | TypeScript still owns |
| --- | --- | --- |
| Unit arrival control thrust | `arrivalControlStepBatch` computes the velocity-aware PD thrust for packed candidates | `Simulation.updateUnits` still owns action semantics, target sweeping, path refresh, and queue advancement |
| Combat targeting finite-state transitions and top-K target selection | Combat targeting slabs and Rust transition kernels in `rts-sim-wasm/src/lib.rs` | `targetingInputStamping.ts`, `turretSystem.ts`, and `projectileSystem.ts` still stamp JS entities, write results back to JS turrets, rotate turrets, and emit shots |
| Shield sphere/panel LOS and reflection support | Shield slabs and Rust-side clearance/query kernels | TypeScript still schedules shield state, audio, and projectile collision consequences |
| Packed projectile motion fast path | WASM projectile pool and packed stepping kernels | TypeScript still owns projectile entity lifecycle, homing target policy, collision handling, death events, and network spawn/despawn events |
| Entity metadata and turret pool slabs | Rust slabs store generated/alive metadata and turret state fields | TypeScript `WorldState` remains the canonical entity object store until the ECS migration replaces it |

## TypeScript-Orchestrated

These rows are the remaining C1 migration surface. Each row should leave this list only when the Rust/WASM implementation is live and the old TypeScript path is deleted.

| System | Current owner | Notes for migration |
| --- | --- | --- |
| Tick sequencing and command dispatch | `src/game/sim/Simulation.ts` and `commandExecution.ts` | Keep browser/network command collection in TypeScript, but move per-tick authoritative execution state into Rust once the ECS state lives there |
| Unit action queues, path-intent promotion, stuck detection, replanning, fight/guard/attack halt policy | `Simulation.updateUnits` plus `Pathfinder.ts` | Arrival math is already batched to WASM; queue semantics and per-unit control flow are still TypeScript |
| Economy, resource movement, producer stockpile accounting | `economy.ts`, `energyDistribution.ts`, `resourceMovement.ts` | Resource movement visuals can stay renderer-side; stockpile truth should migrate with economy state; wind oscillator, producer/converter per-player rate aggregation, base income and solar/wind/extractor stockpile crediting, converter tax transfer math, converter stockpile application/share distribution, shared stockpile credit/debit clamps, construction/repair equal-share debit allocation, and construction/repair consumer spend application are now Rust/WASM-owned |
| Construction lifecycle, factory production, build placement validation, build-piece activation | `construction*.ts`, `factoryProduction.ts`, `buildPlacementValidation.ts` | Preserve one continuous entity id from shell to finished product. Factory construction-site placement and spawn-overlap geometry are Rust/WASM-owned; shell lifecycle and completion orchestration remain TypeScript |
| Commander build/repair/reclaim/D-gun ability orchestration | `commanderAbilities.ts`, `commandExecution.ts` | Dense numeric spray or targeting kernels can move before full command orchestration does |
| Damage routing, death events, death explosions, detachment promotion, kill credit | `damage/DamageSystem.ts`, `combat/damageHelpers.ts`, `Simulation.ts`, `WorldState.ts` | Piece-health semantics are implemented; the authoritative damage/death loop still runs in TypeScript |
| Projectile lifecycle, homing policy, collision consequences, submunition spawn/despawn events | `combat/projectileSystem.ts`, `ProjectileCollisionHandler.ts` | Packed motion exists in WASM, but projectile authority is not fully Rust-owned |
| Fog/visibility filtering and client-specific snapshot selection | `stateSerializerVisibility.ts`, snapshot serializer modules | Snapshot byte writing has a Rust path; visibility policy and recipient filtering remain TypeScript |
