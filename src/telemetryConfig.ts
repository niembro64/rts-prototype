// Telemetry tuning. Pure data lives in telemetryConfig.json so both
// TypeScript and (eventually) Rust/WASM can load the same source of
// truth.

import telemetryConfig from './telemetryConfig.json';

/** Shared "good" tick-rate baseline for status bars. */
export const GOOD_TPS = telemetryConfig.goodTps;
