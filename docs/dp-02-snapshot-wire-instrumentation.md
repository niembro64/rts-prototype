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
from the same DTO and compares them with the Rust-backed bytes. If a mismatch is
found, the dev send falls back to the JavaScript bytes for that snapshot.

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
