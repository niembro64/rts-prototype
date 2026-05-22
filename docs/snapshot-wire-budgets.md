# Snapshot Wire Budgets

These are the acceptance budgets for snapshot-size work. They are intentionally
per-client budgets: adding remote clients multiplies host upstream, so the
payload target does not grow just because the battle is larger.

## Required Capture Shape

Use the same matrix when reporting snapshot optimization changes:

- Unit counts: 200, 1,000, 5,000.
- Cadence: 30 DIFFSNAP/sec plus 1 FULLSNAP/sec.
- Client fanout: 1, 2, and 4 remote clients.
- Metrics: DS avg/hi, FS avg/hi, estimated Mbps/client, estimated host Mbps,
  encode/decode/apply avg ms, and encode/decode/apply hi ms.

Estimated bandwidth:

```text
Mbps/client = ((DS avg bytes * diff snaps/sec) + (FS avg bytes * full snaps/sec)) * 8 / 1_000_000
Host Mbps = Mbps/client * remote client count
```

## Pass/Fail Matrix

The 64 KiB DIFFSNAP and 1 MiB FULLSNAP targets are the steady-state internet
budget. A 1,000-unit or 5,000-unit run that misses them is not a special case;
it is evidence that the next wire-format or area-of-interest reduction is still
needed.

| Units | Cadence | DS avg | DS hi | FS avg | FS hi | Mbps/client target | Host Mbps at 1 client | Host Mbps at 2 clients | Host Mbps at 4 clients | Encode avg/hi | Decode avg/hi | Apply avg/hi |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 200 | 30 DS/s + 1 FS/s | <= 64 KiB | <= 128 KiB | <= 1 MiB | <= 1.25 MiB | <= 24.2 | <= 24.2 | <= 48.3 | <= 96.6 | <= 2 / 4 ms | <= 2 / 4 ms | <= 4 / 8 ms |
| 1,000 | 30 DS/s + 1 FS/s | <= 64 KiB | <= 128 KiB | <= 1 MiB | <= 1.25 MiB | <= 24.2 | <= 24.2 | <= 48.3 | <= 96.6 | <= 5 / 10 ms | <= 5 / 10 ms | <= 8 / 16 ms |
| 5,000 | 30 DS/s + 1 FS/s | <= 64 KiB | <= 128 KiB | <= 1 MiB | <= 1.25 MiB | <= 24.2 | <= 24.2 | <= 48.3 | <= 96.6 | <= 15 / 30 ms | <= 15 / 30 ms | <= 20 / 40 ms |

Optimization PRs should state whether each changed row is green, red, or moved
toward green. Encode/decode/apply limits scale with count because CPU cost still
tracks touched entities; byte limits do not because network capacity is the
scarce shared resource.
