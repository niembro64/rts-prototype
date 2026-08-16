# Cleanup audit — 2026-08-15

This ledger records confirmed findings across cleanup passes. A finding is
listed only when the audit identified a concrete ownership, resource,
allocation, or duplicated-implementation problem; speculative large refactors
are intentionally excluded.

## Third pass findings

| ID | Area | Finding | Status |
| --- | --- | --- | --- |
| LIFE-01 | Renderer lifecycle | `RenderLighting3D` retains the destroyed scene, renderer, and sun lights in module-level strong references. | Complete |
| LIFE-02 | Thumbnail lifecycle | Deferred thumbnail retries repeat after the last cache subscriber unmounts. | Complete |
| LIFE-03 | Entity Lab lifecycle | Concurrent async preview remounts can orphan a preview runtime when selection changes overlap. | Complete |
| GPU-01 | Contact blips | Replaced and destroyed `InstancedMesh` objects do not release their instance buffers. | Complete |
| GPU-02 | Lift-probe overlay | Capacity growth and teardown do not release the three meshes' instance buffers. | Complete |
| GPU-03 | Ground lines | Capacity growth replaces instanced attributes without releasing their prior GPU buffers. | Complete |
| PERF-01 | Lift-probe overlay | The debug overlay filters units and allocates an entity-ID array every enabled frame. | Complete |
| PERF-02 | Barrel spin | `beginFrame` allocates a short-lived frame-state object every render frame. | Complete |
| PERF-03 | Snapshot removal | Both snapshot encoders create the same removed-ID deduplication closure for each publication. | Complete |
| CONS-01 | Runtime flags | Boolean URL-query parsing is implemented separately in diagnostics and snapshot impairment. | Complete |
| CONS-02 | Config validation | CSS hex, boolean, positive-integer, object, and exact-key validators are locally reimplemented. | Complete |
| CONS-03 | Loading UI | Two battle-start paths contain the same overlay-paint wait routine. | Complete |
| CONS-04 | Simulation WASM | Four simulation modules locally implement the same required-WASM accessor. | Complete |
| CONS-05 | Entity labels | The loading screen and Entity Lab separately resolve the same blueprint display name. | Complete |
| CONS-06 | Math helpers | Four runtime modules duplicate the canonical `clamp01`; two duplicate linear-to-sRGB conversion. | Complete |
| CONS-07 | Storage config | Client and server bar configuration duplicate namespaced storage-key construction. | Complete |
| CONS-08 | Snapshot visibility | The object serializer and direct-wire encoder duplicate serializable-entity and visibility predicates. | Complete |
| CONS-09 | Locomotion config | Air and water fluid-physics cloning have identical implementations. | Complete |
| CONS-10 | Runtime clock | Instrumentation, networking, render telemetry, hover throttling, and previews locally implement the same clock fallback. | Complete |
| CONS-11 | Indexed client stores | Two client stores repeat the indexed `Map` implementation already provided by `IndexedEntityIdMap`. | Complete |
| CONS-12 | Common guards and stats | Uint31/Uint32 validation, browser timezone lookup, and single-value running-stat accumulation have duplicate owners. | Complete |
| CONS-13 | Render helpers | Asset-loader promises, identical trim-sheet drawing, and unit/building LOD row counting are duplicated. | Complete |
| CONS-14 | Pool and query setup | Two particle renderers duplicate their root/material/tier-pool construction, and two spatial queries duplicate combined unit/building range packing. | Complete |
| CORR-01 | Damage slab coherence | Segment, area-turret, and death-explosion damage recompute a static turret mount instead of using a same-tick authoritative host-piece override. | Complete |

## Audit boundaries

- Listener, observer, worker, animation-frame, interval, and timeout ownership
  was traced through the application lifecycle. Page-lifetime listeners and
  finite retry delays are intentional; only LIFE-01 through LIFE-03 lacked a
  matching owner teardown.
- Every runtime `InstancedMesh` replacement/destruction path was reviewed.
  Existing paths that call `InstancedMesh.dispose()` directly or through
  `disposeMesh` were left unchanged.
- Exact duplicate test helpers were excluded. The final production duplicate
  scan reports only two thin domain wrappers: the Commander/Rex cylinder-cache
  accessors and shield/unit turret aim-capacity accessors. Each wrapper owns
  distinct class state and already delegates the implementation to a shared
  imported helper.
- Large modules were inspected for independently movable responsibilities, but
  size alone was not treated as a defect. This pass avoids broad structural
  churn without a measurable ownership or duplication benefit.

## Verification

- `cargo test`: 211/211 Rust tests passed.
- `npm run contract:tests`: 104/104 application contract tests passed.
- `npm run build`: WASM release build, generated-asset audits, Vue typecheck,
  and Vite production build passed. After the final consolidation, the Vue
  typecheck and 906-module Vite build passed again.
- Targeted post-consolidation renderer contracts: pylon-flow and spray-renderer
  tests both passed.
- `npm run performance:bottleneck`: completed without slab-divergence
  diagnostics. JavaScript heap deltas were `0.00B` in sim-only,
  sim-plus-snapshot, and full-stack modes; full-stack WASM delta was `0.00B`.
- Exact production-function duplicate scan: no actionable duplicate bodies.
  The two remaining pairs are the intentional state-owning wrappers described
  above.
- `git diff --check`: passed.

## Fourth pass findings — 2026-08-15

| ID | Area | Finding | Status |
| --- | --- | --- | --- |
| LIFE-04 | Surface-chart material lifecycle | The module-level charted-material `Map` strongly retains every scene palette material, while its cloned GPU material is never disposed when the source palette is disposed. Battle restarts therefore accumulate disposed source keys and live chart clones. | Complete |
| PERF-04 | Lockstep presentation | Three typed-array views over stable WASM scratch pointers are reconstructed on every rendered frame. | Complete |
| PERF-05 | Selection overlays | `beginFrame` allocates two arrays and two joined strings every frame solely to detect boolean-state changes. | Complete |
| PERF-06 | Tank locomotion | Every rendered tank allocates the same three-position tread sample array every frame. | Complete |
| PERF-07 | Selection drag | Every pointer-move replaces two small screen-point objects instead of updating retained state. | Complete |
| PERF-08 | Idle-builder repair | Reclaimer and repair maintenance allocates a temporary `Set` and two `Array.from` snapshots on each scan. | Complete |
| PERF-09 | Physics awake-body bridge | Awake-body scratch arrays grow exactly and create fresh `subarray` views every collection, even when the body count is stable. | Complete |
| PERF-10 | Formation-line preview | The path coordinate buffer grows to each exact new point count, repeatedly copying and discarding typed arrays during a long drag. | Complete |
| CONS-15 | Numeric config validation | Finite-number and bounded-range checks remain locally reimplemented across fog, wind, surface-probe, shot-locomotion, sensor, station, entity-ledger, and backdrop validation. | Complete |
| CONS-16 | Unit locomotion validation | Two authored-physics validators duplicate the generic exact-object-key implementation. | Complete |
| CONS-17 | Primitive visual kits | Commander and Rex repeat the same tier-geometry cache accessor and cache-disposal ownership. | Complete |
| CONS-18 | Turret aim buffers | Shield-panel and unit-turret pose owners retain identical capacity-growth wrappers around the shared aim-buffer helper. | Complete |

### Fourth pass audit boundaries

- Literal DOM listener registration/removal was checked per production file;
  the only unmatched listener is the intentional page-lifetime fatal-error
  reload button in `main.ts`.
- Observer, worker, timer, animation-frame, async renderer-start, and
  `InstancedMesh` ownership paths were traced again. Existing teardown is
  paired; LIFE-04 is the only newly confirmed retained resource.
- The initial production TypeScript AST duplicate-body scan reported the two
  primitive-kit and turret-aim wrapper pairs recorded as CONS-17 and CONS-18;
  the post-consolidation scan reports zero duplicate groups.
- Allocation findings are limited to recurring render, pointer, simulation,
  or capacity-growth paths. Cold construction-only allocations are excluded.

### Fourth pass verification

- `cargo test`: 211/211 Rust tests passed.
- `npm run contract:tests`: 104/104 application contract tests passed.
- Focused post-change contracts passed for surface-chart lifetime and travel
  slots, unit locomotion, idle-builder repair, rolling locomotion, box
  selection, bot-host turret aim, and turret-aim pose.
- `npm run build`: WASM release build, generated-asset audits, Vue typecheck,
  and the 908-module Vite production build passed.
- `npm run performance:bottleneck`: completed successfully. JavaScript heap
  deltas were `0.00B` in all three modes, and full-stack WASM delta was
  `0.00B`. The bounded sim warm-up growth was `128.00KiB`; sim-plus-snapshot
  warm-up growth was `2.44MiB`. Full-stack frame p95 was `15.85ms` at the
  extreme render tier.
- Exact production TypeScript function/method/constructor duplicate scan:
  zero duplicate groups.
- Targeted obsolete-allocation/wrapper scan: no remaining instances of the
  replaced frame-state strings, tread sample array, repair snapshots, or
  local aim/geometry capacity wrappers.
- `git diff --check`: passed.

## Fifth pass findings — 2026-08-16

| ID | Area | Finding | Status |
| --- | --- | --- | --- |
| GPU-04 | Vegetation volume overlay | The constructor-owned placeholder `BufferGeometry` is not tracked, so the first rebuild abandons it without disposal. Teardown then disposes the active replacement twice. | Complete |
| PERF-11 | Projectile snapshot buffering | Each direct projectile snapshot allocates four inline forwarding callbacks; the packed fallback path allocates two more callbacks even though the buffer owner and operations are stable. | Complete |
| PERF-12 | Clock formatting | Client presence constructs a new `Intl.DateTimeFormat` every second, while the lobby roster and server metadata builder maintain duplicate formatter implementations. | Complete |
| PERF-13 | Performance measurement boundaries | `LongtaskTracker` requests buffered historical entries, and the bottleneck harness carries warm-up long-task EMA state plus queued warm-up snapshot metadata into its measurement window. Pre-window work can therefore inflate blocked-time rates above the physical 1000 ms/s ceiling and misclassify the measured scenario. | Complete |
| CONS-19 | Typed-array capacity growth | Five multi-buffer owners still duplicate geometric-capacity loops and per-array copy code instead of importing the shared typed-array growth helpers. | Complete |
| CONS-20 | Lobby state wiring | Lobby preview duplicates identical restart watchers, and terrain/liquid lobby settings duplicate the same persistence, runtime-installation, and broadcast workflow. | Complete |
| CONS-21 | Finite-number fallbacks | Render, scene-event, network-field, and wire-encoder modules retain local finite-number fallback/type guards despite the canonical math helper module. | Complete |
| CONS-22 | MIDI conversion | Procedural composition and MIDI playback independently implement the same MIDI-note-to-frequency conversion instead of importing an audio primitive. | Complete |

### Fifth pass audit boundaries

- Production listener, observer, worker, timer, animation-frame, and Three.js
  ownership paths were traced again. Existing listener and asynchronous
  lifecycle pairs are balanced; GPU-04 is the only newly confirmed resource
  ownership defect.
- Allocation findings are restricted to recurring snapshot or one-second
  update paths. Construction-only allocations and bounded page-lifetime
  geometry/material caches are excluded.
- The production TypeScript duplicate-body scan excludes test-only comparison
  helpers and intentionally thin state-owning interface wrappers. CONS-19
  through CONS-22 cover every actionable implementation duplicate found in
  this pass.
- Rust allocation sites were reviewed separately. The recurring buffers retain
  capacity or are build-time/cold-path values, so this pass records no new Rust
  allocation defect.

### Fifth pass verification

- `cargo test`: 211/211 Rust tests passed.
- `npm run contract:tests`: 104/104 application contract tests passed.
- Focused vegetation-geometry lifetime and snapshot-buffer contracts passed.
  The vegetation contract now asserts exactly one disposal for both the
  constructor geometry and the active replacement geometry.
- `npm run build`: WASM release build, generated-asset audits, Vue typecheck,
  and the 908-module Vite production build passed.
- `npm run performance:bottleneck`: completed successfully. JavaScript heap
  deltas were `0.00B` in all three modes; full-stack WASM delta was `0.00B`.
  The bounded sim and sim-plus-snapshot warm-up deltas were `128.00KiB` and
  `2.44MiB`; sim p95 was `13.46ms` and full-stack frame p95 was `12.75ms`.
  After isolating the measurement window, reported long-task p95 fell from
  the impossible pre-fix `1965.08ms/s` to `0.00ms/s`, and queued warm-up
  materialization no longer appears as a measured full-stack sample.
- Exact production TypeScript function/method/constructor duplicate scan:
  zero duplicate groups across 708 files.
- Targeted scans report only the canonical clock formatter, math finite-value
  helpers, and type guard; no superseded per-owner growth loops or copy blocks
  remain in the five consolidated buffer owners.
- `git diff --check`: passed.
