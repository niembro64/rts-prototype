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
