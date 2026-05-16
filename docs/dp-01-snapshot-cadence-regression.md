# DP-01 Snapshot Cadence Regression

Run date: 2026-05-16

Command path:
- Vite dev server: `npm run dev -- --port 5175`
- Browser URL: `http://127.0.0.1:5175/budget-annihilation/?dp01=1`
- Automation: headless Google Chrome via Playwright, with software WebGL (`--enable-unsafe-swiftshader --use-angle=swiftshader`)

Notes:
- The DP-01 harness was reset at real-battle start so background/lobby preview snapshots did not pollute the saved rows.
- The browser was headless and software-rendered, so render FPS numbers are not representative of player hardware. Snapshot cadence, byte size, encode/decode/apply time, server TPS, and command response are the useful values from this run.
- The WebRTC case used two isolated browser contexts on the same machine: host created room `BZ9K`, client joined as player 2, then the host started the battle.

## Local Host Play

| Rate | Seconds | Snapshots | Measured SPS | Full | Bytes Avg | Bytes Max | Encode ms | Apply ms | Correction Avg | Correction Max | Server TPS | Server TPS Low | Command ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 30.0 | 134 | 4.47 | 1 | 2,891 | 63,968 | 0.09 | 0.03 | 1,964.95 | 5,301.57 | 58.7 | 32.5 | 126.24 |
| 8 | 30.0 | 235 | 7.82 | 0 | 1,828 | 2,190 | 0.06 | 0.02 | n/a | n/a | 63.4 | 56.4 | 119.13 |
| 10 | 29.5 | 262 | 8.87 | 1 | 1,922 | 61,215 | 0.06 | 0.02 | 0.33 | 0.33 | 63.6 | 58.2 | 95.08 |

## WebRTC Host

| Rate | Seconds | Snapshots | Measured SPS | Full | Bytes Avg | Bytes Max | Encode ms | Apply ms | Correction Avg | Correction Max | Server TPS | Server TPS Low | Command ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 29.8 | 140 | 4.69 | 0 | 2,286 | 2,493 | 0.08 | 0.01 | 5.09 | 5.09 | 64.3 | 32.6 | 163.87 |
| 8 | 30.0 | 225 | 7.51 | 0 | 1,697 | 1,817 | 0.07 | 0.02 | n/a | n/a | 68.6 | 44.7 | 139.42 |
| 10 | 30.0 | 257 | 8.56 | 1 | 1,765 | 65,458 | 0.07 | 0.02 | 1.55 | 1.55 | 68.6 | 42.9 | 123.65 |

## WebRTC Client

| Rate | Seconds | Snapshots | Measured SPS | Full | Bytes Avg | Bytes Max | Decode ms | Apply ms | Correction Avg | Correction Max | Server TPS | Server TPS Low |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 29.9 | 138 | 4.61 | 1 | 2,287 | 2,493 | 0.12 | 0.05 | 14,586.53 | 14,586.53 | 64.9 | 33.1 |
| 8 | 29.9 | 213 | 7.13 | 0 | 1,697 | 1,817 | 0.08 | 0.03 | n/a | n/a | 68.6 | 44.7 |
| 10 | 30.1 | 229 | 7.61 | 1 | 1,765 | 65,458 | 0.10 | 0.03 | 4.10 | 4.10 | 68.6 | 42.9 |

## Result

DP-01 is closed for the current implementation. The normal 5/8/10 SPS cadence ran in local host play and same-machine WebRTC play with server tick rate decoupled at the 60 TPS target. Encode/decode/apply costs stayed sub-millisecond in this low-unit-count regression, and command-response probes remained in the low hundreds of milliseconds under headless software WebGL.
