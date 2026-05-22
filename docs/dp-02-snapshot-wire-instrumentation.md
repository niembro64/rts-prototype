# DP-02 Snapshot Wire Instrumentation

Purpose: measure snapshot wire encode cost during the DP-02 migration from
JavaScript DTO plus `@msgpack/msgpack` to the owned Rust-backed encoder.

## Enable

Run the app with either:

- URL flag: `?dp02=1`
- Env flag: `VITE_BA_DP02_SNAPSHOT_WIRE=1`

The recorder prints a console table every 10 seconds and exposes:

```js
window.__BA_DP02_SNAPSHOT_WIRE__.rows()
window.__BA_DP02_SNAPSHOT_WIRE__.report()
window.__BA_DP02_SNAPSHOT_WIRE__.reset()
```

## FULLSNAP Transport Compression

FULLSNAP compression is experimental and disabled by default. Enable it for
remote WebRTC A/B captures with either:

- URL flag: `?fullSnapshotCompression=1`
- Env flag: `VITE_BA_FULLSNAP_COMPRESSION=1`

The path compresses `state.isDelta === false` payloads only, using the browser
Compression Streams API and the format configured in `src/snapshotConfig.json`.
DIFFSNAPs stay raw MessagePack. If the compressed payload is not smaller than
the raw FULLSNAP, the sender falls back to raw bytes for that snapshot.

Transport-compression stats are exposed separately from the DP-02 source-section
breakdown because compressed bytes no longer map cleanly to individual snapshot
sections:

```js
window.__BA_SNAPSHOT_TRANSPORT_COMPRESSION__.rows()
window.__BA_SNAPSHOT_TRANSPORT_COMPRESSION__.report()
window.__BA_SNAPSHOT_TRANSPORT_COMPRESSION__.reset()
```

The report shows raw FULLSNAP bytes, transport bytes, percent saved, compression
ms, and decompression ms. The client bar's FS SIZE uses the received transport
byte length, so when compression is enabled on a remote client that value is the
compressed FULLSNAP size. Local in-memory host play still reports the raw
MessagePack estimate.

## Rust Parity Compare

Run the app with either:

- URL flag: `?dp02rust=1`
- Env flag: `VITE_BA_DP02_RUST_SNAPSHOT_WIRE=1`

The normal snapshot send path is now Rust-first: it builds the outgoing byte
stream with the Rust-backed envelope encoder, falling back to JavaScript
MessagePack only when WASM is unavailable or the DTO key order is unsupported.
DTO pieces that are not ported yet use explicit raw MessagePack fallback inside
the Rust-owned envelope so live snapshots can still be compared end to end.

In development, the parity flag also builds JavaScript `@msgpack/msgpack` bytes
from the same DTO and compares them with the Rust-backed bytes. Mismatches are
logged and counted, but the outgoing snapshot stays on the Rust-backed sender so
normal live traffic remains on the owned binary path while parity is measured.

The compare path exposes:

```js
window.__BA_DP02_RUST_SNAPSHOT_WIRE__.stats()
window.__BA_DP02_RUST_SNAPSHOT_WIRE__.reset()
```

`rustSends` / `jsSends` show which path supplied outgoing bytes. `rawEntities`
and `rawTopLevelKeys` show the remaining DTO surface that still needs dedicated
Rust encoding before the raw MessagePack fallback can be deleted.

To force the legacy JavaScript sender for baseline captures or debugging, run
with either:

- URL flag: `?dp02js=1`
- Env flag: `VITE_BA_DP02_FORCE_JS_SNAPSHOT_WIRE=1`

## Rows

Rows are grouped by:

- `source`: `local` for in-memory host play, `remote` for WebRTC sends
- `listener`: local snapshot listener key or remote `player-N`
- `rate`: authoritative snapshot rate from `serverMeta.snaps.rate`
- `unitBand`: `<1k`, `1k`, `3k`, `5k`, `5k+`, or `unknown`

Each row reports sample count, encoded snapshots per second, full/delta split,
average/max unit count, average/max bytes, and average/max encode milliseconds.

## DP-02 Capture Targets

For a JavaScript baseline, force the legacy sender with `?dp02js=1` and capture
rows at normal snapshot cadences:

- 5 SPS at about 1k units
- 8 SPS at about 1k units
- 10 SPS at about 1k units
- 5 SPS at about 5k units
- 8 SPS at about 5k units
- 10 SPS at about 5k units

Use `window.__BA_DP02_SNAPSHOT_WIRE__.reset()` after changing cap/rate so each
capture starts with a clean bucket set.

For 5k demo runs, preload the cap before the page creates the background battle:

```js
localStorage.setItem('demo-battle-cap', '5000')
localStorage.setItem('host-server-snapshot-rate', '5')
location.reload()
```

Change the stored snapshot rate to `8` or `10` between captures, then reload.

## Forced-JS Baseline Capture

Run date: 2026-05-17

Command path:

- Vite dev server: `npm run dev -- --port 5175` (served on 5176 because 5175 was occupied)
- Browser URL: `http://127.0.0.1:5176/budget-annihilation/dp02-harness.html?dp02=1&dp02js=1`
- Automation: headless Google Chrome via Playwright
- Harness: custom in-memory HTML page importing Vite modules, then creating `GameServer` + `LocalGameConnection` directly. The harness marks the local listener ready before `server.start()` so captures measure the normal post-startup snapshot stream without renderer cost.
- Scenario shape: five-player demo battle, all background unit types enabled, `terrainCenter=flat`, `terrainDividers=mountain`, `terrainMapShape=circle`, `keyframeRatio=1/64`, forced JS MessagePack sender.

Notes:

- Capture windows ran for 25 seconds after a warmup row proved the listener was receiving delta snapshots at the requested unit band.
- The 1k rows include regular 1/64 keyframes inside the measurement window. The 5k rows did not hit a keyframe during their shorter measured snapshot count.
- Measured SPS is the actual encoded snapshot rate, not the configured cap. At 5k units, the current JS DTO + MessagePack path and simulation work cap the host near 2 encoded snapshots/sec in this harness.
- The first 5k attempt exposed a teardown leak where `PhysicsEngine3D.dispose()` destroyed only the static broadphase handle and left BodyPool slots allocated across server restarts. The leak was fixed before the baseline below was recorded.
- The table was refreshed after the 2026-05-17 parity burn-down that made pooled DTO scratch fields non-enumerable. Before that fix, JS MessagePack also serialized private `_pos` / `_velocity` scratch copies and produced larger 1k payloads.

| Cap | Configured SPS | Seconds | Samples | Measured SPS | Full | Delta | Units Avg | Units Max | Bytes Avg | Bytes Max | Encode ms | Encode ms Max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 5 | 24.9 | 117 | 4.70 | 1 | 116 | 999 | 1,005 | 739,975 | 1,822,671 | 6.40 | 18.9 |
| 1,000 | 8 | 25.0 | 167 | 6.69 | 2 | 165 | 1,000 | 1,003 | 549,660 | 1,565,109 | 4.99 | 18.8 |
| 1,000 | 10 | 24.9 | 196 | 7.87 | 3 | 193 | 999 | 1,005 | 545,977 | 1,685,764 | 5.01 | 20.5 |
| 5,000 | 5 | 25.4 | 40 | 1.58 | 0 | 40 | 5,003 | 5,005 | 2,082,840 | 2,191,917 | 20.05 | 21.5 |
| 5,000 | 8 | 25.4 | 40 | 1.57 | 0 | 40 | 5,000 | 5,005 | 2,069,095 | 2,214,722 | 19.85 | 21.7 |
| 5,000 | 10 | 25.3 | 43 | 1.70 | 0 | 43 | 5,002 | 5,005 | 2,071,818 | 2,217,744 | 20.07 | 21.7 |

## Rust Parity Burn-Down Notes

Run date: 2026-05-17

The first parity probe after the forced-JS baseline showed zero raw entity fallback but byte mismatches on nearly every delta. Decoding the JS and Rust bytes showed the same semantic snapshot data; the byte gap came from two JS-side DTO issues:

- Pooled audio/projectile DTO scratch fields such as `_pos`, `_velocity`, `_beamStart`, `_beamEnd`, and `_beam` were enumerable, so JS MessagePack serialized private pool internals that Rust intentionally omitted.
- Runtime entity DTOs deleted `changedFields` on full snapshots and later re-added it after `unit` / `building`, producing a different MessagePack key order than the Rust encoder and byte-equality fixtures.

Fixes:

- Pooled scratch fields are now defined as non-enumerable.
- Entity DTOs keep `changedFields`, `unit`, and `building` as stable optional properties so `changedFields` preserves its insertion order before the subobject.

Post-fix parity probes:

| Cap | Configured SPS | Seconds | Samples | Rust Sends | JS Sends | Matches | Mismatches | Raw Entities | Raw Top-Level |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | 5 | 12.1 | 55 | 55 | 0 | 55 | 0 | 0 | `terrain`, `buildability` on the full keyframe |
| 5,000 | 5 | 13.0 | 22 | 22 | 0 | 22 | 0 | 0 | `terrain`, `buildability` on the full keyframe |

The full-keyframe static `terrain` and `buildability` top-level fields now stay
on the Rust path. Remaining DP-02 parity work is focused on debug-grid raw
fallback, less common audio/projectile variants, and remote recipients.

## SNAP-WIRE-01 Followups

### Observed-Entity Delta Preset

Run date: 2026-05-22

Capture setup:

- Browser URL: `http://localhost:5175/budget-annihilation/?dp02=1`
- Automation: headless Google Chrome via Playwright with software WebGL.
- Scenario: demo battle, cap 243, observed from player 1, fog disabled, debug
  grid disabled, keyframes disabled, host snapshot cap 32/sec.
- Measurement source: `window.__BA_DP02_SNAPSHOT_WIRE__.rows()`, after startup
  reset. This is the same local snapshot encode path used for the PLAYER
  CLIENT DS SIZE estimate.

| Observed preset | Seconds | Samples | Units Avg | DS avg | DS hi | Encode avg | Encode hi |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2x position/velocity/rotation thresholds | 21.6 | 40 | 239 | 76,578 B | 123,411 B | 0.33 ms | 0.60 ms |
| 4x position/velocity/rotation thresholds | 21.6 | 37 | 239 | 75,659 B | 115,088 B | 0.33 ms | 0.60 ms |

The 4x preset is now the chosen default for observed enemy entities. Owned and
allied entities remain at 1x fidelity. The measured byte win is modest because
projectiles and audio dominated these short combat windows, but it moved DS avg
down about 1.2% and DS hi down about 6.7% without changing command authority or
owned-unit precision. FS SIZE is not expected to move from this preset because
full snapshots do not run the entity delta-threshold gate.

### DIFFSNAP Compression Decision

Generic DIFFSNAP compression remains disabled. The measured high-byte sections
in the captures above were structural sources: entities, projectile beam /
velocity updates, and audio events. At 30 Hz, compressing every delta would add
CPU, allocation, latency, and jitter to the host's hottest network path while
leaving those sources semantically unchanged.

The project should keep spending DIFFSNAP effort on structural compression:
field masks, packed rows, fixed-point integers, beam/detail budgets, and the
snapshot-v2 schema in `docs/snapshot-v2-wire-schema.md`. FULLSNAP transport
compression stays available behind the existing flag because keyframes are rare
and tolerate the extra work better than steady-state deltas.

### Fixed-Point Integer Class

Run date: 2026-05-22

The current MessagePack/Rust bridge now writes these high-volume snapshot
numeric classes as fixed-point integers and dequantizes them at client apply
boundaries:

- Entity position: scale 100.
- Minimap and projectile/beam positions: scale 1.
- Linear velocity: scale 10.
- Rotation, turret yaw/pitch, turret angular rates, and beam obstructionT:
  scale 1000.
- Surface normals and beam reflection normals: scale 1000.
- Suspension offsets: scale 100.

Capture setup:

- Harness URL: `http://localhost:5175/budget-annihilation/src/main.ts`
- Measurement: headless Chrome via Playwright, importing `GameServer` and
  `snapshotWireCodec` from Vite without starting the renderer.
- Scenario: demo battle, cap 243, observed from player 1, fog disabled, debug
  grid disabled, keyframes disabled, host snapshot cap 32/sec.
- Comparison: each emitted snapshot was encoded once as the current
  fixed-point integer DTO and once as a same-snapshot decimal replay that
  divides fixed-point fields back to their previous decimal scales.

| Stream | Seconds | Samples | Units Avg | Current avg | Current hi | Decimal replay avg | Decimal replay hi | Saved avg |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FULLSNAP bootstrap | - | 1 | 245 | 1,076,601 B | 1,076,601 B | 1,081,514 B | 1,081,514 B | 4,913 B (0.5%) |
| DIFFSNAP steady state | 22.9 | 687 | 207 | 52,554 B | 114,475 B | 54,771 B | 119,586 B | 2,217 B (4.0%) |

The delta stream's remaining large average sections were audio events
(`~26.5 KiB`), entities (`~18.6 KiB`), minimap entities (`~4.0 KiB`), and
projectiles (`~2.8 KiB`). Fixed-point integers help the existing
MessagePack-compatible bridge, but the remaining SNAP-WIRE-01 work still needs
structural row packing and section-specific budgets rather than more generic
transport compression.

### Audio Event Packed Rows

Run date: 2026-05-22

The wire path now keeps `NetworkServerSnapshot.audioEvents` as readable event
objects in memory, but encodes the outbound wire value as compact rows:
event/source codes, a per-snapshot string table for audio/source keys, fixed
point event positions, fixed point impact/death context vectors, and packed
optional-field flags. Remote decode expands the rows back into the original
event objects before the client view or audio scheduler reads the snapshot.

Capture setup:

- Browser URL: `http://localhost:5175/budget-annihilation/?dp02=1`
- Automation: headless Google Chrome via Playwright, importing `GameServer`,
  `snapshotWireCodec`, and `snapshotRustWireEncoder` from Vite.
- Scenario: five-player background demo battle, cap 243, observed from player
  1, `terrainCenter=flat`, `terrainDividers=mountain`,
  `terrainMapShape=circle`, host snapshot cap 32/sec.
- Comparison: each emitted snapshot was encoded once through the previous
  Rust-backed object-audio path
  (`encodeNetworkSnapshotWithRustFallback(state)`) and once through the new
  packed-audio path (`encodeNetworkSnapshot(state)`) from the same in-memory
  snapshot. Decode parity checked event counts from the packed payload.

| Stream | Samples | Units Avg | Legacy avg | Legacy hi | Packed avg | Packed hi | Saved avg |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DIFFSNAP steady state | 96 | 240 | 63,633 B | 166,628 B | 50,212 B | 151,675 B | 13,421 B |

Audio-section detail for the same DIFFSNAP rows:

| Section | Legacy avg | Legacy hi | Packed avg | Packed hi | Saved avg |
| --- | ---: | ---: | ---: | ---: | ---: |
| `audioEvents` | 16,136 B | 31,942 B | 2,715 B | 5,186 B | 13,421 B |

The first FULLSNAP bootstrap in this run had no audio events, so it was
unchanged at 1,035,135 B in both encodings. Later FULLSNAPs that did carry
combat audio saved 11,252 B on average. Packed decode reported zero event-count
mismatches across the 103 captured snapshots.

### Minimap And Projectile Packed Rows

Run date: 2026-05-22

The wire path now keeps `minimapEntities` and `projectiles` as readable DTOs in
memory, but encodes them as compact, versioned row objects on the outbound wire.
Minimap rows are flat `[id, x, y, type, playerId, flags]` values. Projectile
rows reuse the existing fixed-point spawn, despawn, velocity-update, beam-header,
and beam-point row layouts that already fed the Rust encoder scratch buffers.
Remote decode expands both packed sections back into the original snapshot DTOs
before client view code reads them.

Capture setup:

- Browser URL: `http://localhost:5175/budget-annihilation/?dp02=1`
- Automation: headless Google Chrome via Playwright, importing `GameServer`,
  `snapshotWireCodec`, and `snapshotRustWireEncoder` from Vite.
- Scenario: five-player background demo battle, cap 243, observed from player
  1, fog disabled, debug grid disabled, keyframes disabled,
  `terrainCenter=flat`, `terrainDividers=mountain`, `terrainMapShape=circle`,
  host snapshot cap 32/sec.
- Comparison: each emitted snapshot was encoded once through the previous
  Rust-backed audio-packed / object-minimap / object-projectile path and once
  through the new packed-minimap / packed-projectile path from the same
  in-memory snapshot. Decode parity checked minimap and projectile section
  counts from the packed payload.

| Stream | Samples | Units Avg | Legacy avg | Legacy hi | Packed avg | Packed hi | Saved avg |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FULLSNAP bootstrap | 1 | 245 | 1,082,261 B | 1,082,261 B | 1,069,273 B | 1,069,273 B | 12,988 B |
| DIFFSNAP steady state | 180 | 240 | 58,922 B | 122,910 B | 49,711 B | 98,067 B | 9,211 B |

Section detail for the same DIFFSNAP rows:

| Section | Legacy avg | Packed avg | Saved avg |
| --- | ---: | ---: | ---: |
| `minimapEntities` | 4,343 B | 1,132 B | 3,211 B |
| `projectiles` | 9,397 B | 3,397 B | 6,000 B |

Packed decode reported zero minimap/projectile count mismatches across the 181
captured snapshots.
