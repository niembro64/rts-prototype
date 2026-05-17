# DP-03 Client Prediction Diagnostics

Added on 2026-05-17.

Enable the diagnostics with either:

- `?dp03=1`
- `?clientPredictionDiagnostics=1`
- `VITE_BA_DP03_CLIENT_PREDICTION=1`

The runtime exposes:

```js
window.__BA_DP03_CLIENT_PREDICTION__.stats()
window.__BA_DP03_CLIENT_PREDICTION__.reset()
```

Captured fields:

- `predictionMsAvg` / `predictionMsMax`: wall-clock cost of `ClientViewState.applyPrediction` per rendered frame.
- `targetAgeAvgMs` / `targetAgeMaxMs`: age of active server correction targets sampled during prediction.
- `correctionDistanceAvg` / `correctionDistanceMax`: position error when snapshots correct existing entities.
- `correctionVelocityAvg` / `correctionVelocityMax`: velocity error when unit snapshots correct existing local units.
- `correctionTargetAgeAvgMs` / `correctionTargetAgeMaxMs`: age of the previous target at the moment a correction arrives.

Recommended DP-03 capture flow:

1. Start a real battle with the normal 5-10 SPS snapshot setting.
2. Add `?dp03=1` to the URL before the scene starts.
3. Run one pass at 5 SPS and one at 10 SPS for the same scenario.
4. Capture `window.__BA_DP03_CLIENT_PREDICTION__.stats()` after each pass.
5. Reset between passes with `window.__BA_DP03_CLIENT_PREDICTION__.reset()`.
