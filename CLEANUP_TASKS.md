# Codebase cleanup — working list

Scratch tracking file. Each line item is deleted as it lands. The whole file is
deleted when the list is empty.

Gates for this work:
- `node ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit` (clean at HEAD d4ce7cbb — must stay clean)
- `npm run deterministic:replay` for anything touching the Rust sim or lockstep TS paths
- Bounded by `project_do_not_dedup_determinism_paths`: DamageSystem, projectileSystem /
  ProjectileCollisionHandler, commandExecution, the movement controllers, the
  `*MatrixBatch3D` instanced-renderer family, and the encoder↔test mirrors are
  deliberately duplicated. Do NOT merge those.

---

## B. Dead code

- [ ] **B3** Un-export / delete genuinely-unused exports and exported types (knip@5 reports 97 +
      121). Must be verified case by case — knip false-positives confirmed already:
      `turretMountContractValidation.ts` (loaded by string via `ssrLoadModule`), `basisu`
      (used by `scripts/generate_backdrops.py`), and `createBackgroundBattle` /
      `destroyBackgroundBattle` (dynamic namespace import). Cascade with vue-tsc; never blind-delete
      a `let` (may be write-only) and never touch `blueprintSchema.generated.ts`.
- [ ] **B4** Collapse the 6 knip "duplicate exports" (same symbol exported under two names):
      `commandHotkeys.ts`, `BeamBurnVolume3D.ts`, `BeamImpact3D.ts`, `EntityDetailLevel3D.ts` (x2),
      `blueprintIds.ts` — keep one name per symbol, update call sites.

## C. Duplication → helpers (TypeScript)

- [ ] **C1** `ServerBootstrap.bootstrapAsync` and `ServerBootstrap.bootstrap` are two ~200-line
      near-identical copies (config resolution 94-127 ≡ 308-341, terrain config 130-162 ≡ 348-380,
      world construction 186-207 ≡ 404-427, roster sets 216-230 ≡ 439-463). The two copies MUST
      stay identical or host/background worlds desync, so a shared helper is the correct fix.
      Extract phase-pure helpers; the async copy keeps only its `await report(...)` calls.
- [ ] **C2** `RtsScene3DFrameTelemetry.ts` declares `RtsScene3DFrameTimingGpuSample` (61-95) as a
      verbatim 35-field copy of `RtsScene3DFrameTiming` (21-55) minus the timing fields.
      Replace with `Omit<RtsScene3DFrameTiming, ...>`.
- [ ] **C3** The `LobbySettings` default factory is written out three times
      (`gameCanvasRealBattleStartup.ts:329-345` and `:650-661`,
      `gameCanvasDeterministicLockstepBackendContractTest.ts:308-322`). Extract one factory.
- [ ] **C4** `Input3DModeClickControllerContractTest.ts` repeats the same ~30-field mode-controller
      stub 7 times (158-185, 525-552, 611-627, 692-712, 768-788, 846-866, 931-951).
      Extract `makeModeStub(overrides)`.
- [ ] **C5** `ServerCommandAuthorizer.ts` repeats the same entity-id filter loop 6 times
      (574, 594, 634, 659, 717, 741). Extract one helper.
- [ ] **C6** `terrainCellTriangleIndex.ts` duplicates a 16-line triangle-walk loop in the same file
      (67-82 ≡ 98-113). Same-file verbatim helper.
- [ ] **C7** `Input3DManager.ts:373-395` ≡ `:548-570` — the same 23-field mode-accessor object
      literal built twice. Extract one builder.
- [ ] **C8** `snapshotEntityWirePack.ts` typed-full vs typed-placeholder decode paths duplicate four
      field-fill blocks (869-891 ≡ 1104-1126, 904-924 ≡ 1132-1152, 969-1016 ≡ 1208-1256).
      Same-file verbatim fill helpers only (wire layout is determinism-critical).
- [ ] **C9** `SpatialGrid.ts:404-425` ≡ `:633-654`.
- [ ] **C10** `workStationSystem.ts:248-279` ≡ `:300-331`.
- [ ] **C11** `commandHotkeys.ts:802-821` ≡ `:998-1017` (the 20-line factoryPreset binding block).
- [ ] **C12** `SelectionPanel.vue` repeats the `bar-order-state` button markup across five clusters
      (1725/2037, 1746/2058/2654, 1764/2076, 1783/2177, 1821/2691). Extract a component or a
      v-for-driven descriptor list.
- [ ] **C13** `ServerSnapshotPublisher.ts:328-338` ≡ `:615-625` and `:457-474` ≡ `:774-791`.
- [ ] **C14** `ClientViewStateBase.ts` repeats the orientation-decode block 4x
      (1282, 1474, 1631, 2103), plus a work-station rot-decode block shared with
      `helpers/NetworkEntityFactory.ts:846`.
- [ ] **C15** `BeamBurnVolume3D.ts:199-211` ≡ `BurnMark3D.ts:211-223` — identical instanced
      attribute setup. (Check against the do-not-dedup instanced-renderer rule first.)

## D. Duplication → helpers (Rust sim)

Every item here needs `npm run deterministic:replay` to pass with unchanged hashes.

- [ ] **D1** `combat_targeting/fsm.rs` + `targeting/scheduler.rs` thread the same 10-field turret
      config parameter list through ~19 call sites and ~16 signatures (fsm.rs 412, 747, 953, 985,
      1197; scheduler.rs 30, 82, 129, 145, 249, 268, 293, 371, 431, 717, 749, 819, 837, 870, 927,
      2014). Introduce one params struct.
- [ ] **D2** `body_pool.rs:1613-1637`, `1691-1710`, `1762-1781`, `1839-1858` — the same sphere-pair
      resolution preamble four times.
- [ ] **D3** `body_pool.rs:1960-2021` ≡ `2175-2233` (46-line dense-shape selection block).
- [ ] **D4** `damage.rs:791-860` ≡ `986-1046` (39-line AABB overlap block).
- [ ] **D5** `pathfinder.rs:1158-1182` ≡ `1812-1836` ≡ `2445-2469` (23-line locomotion param block).

