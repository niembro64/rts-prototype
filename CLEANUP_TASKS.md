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

## C. Duplication → helpers (TypeScript)

- [x] **C12** `SelectionPanel.vue` writes the same `bar-order-state` button 19 times
      (~190 lines). ATTEMPTED AND REVERTED — the duplication is real, but the fix is a
      CSS refactor, not a template one. Extracting `BarOrderStateButton.vue` moves
      `.btn-label` / `.btn-key` / `.bar-state-light` into a child scope, and a DOM probe
      (host a battle, Tab to select the commander, diff the rendered buttons' classes,
      titles, inner markup and computed styles) proved the regression: the hotkey label
      became permanently visible, because `.btn-key`'s base rules and
      `.options-panel.bar-hotkey-preset .action-btn:not(.bar-grid-cell) > .btn-key
      { display: none }` live in `selectionPanelBuildMenu.css` under the PARENT scope and
      no longer reach the child's inner elements. Importing both stylesheets into the
      child fixes it but duplicates 52 KB of CSS; extracting just the shared rules means
      splitting 18 rules that are entangled with the `.bar-grid-cell` /
      `.thumbnail-action-btn` variants belonging to other buttons in the same panel.
      That is a visual change worth an A/B, so it is left for the user to call.

## D. Duplication → helpers (Rust sim)

Every item here needs `npm run deterministic:replay` to pass with unchanged hashes.

- [ ] **D1** `combat_targeting/fsm.rs` + `targeting/scheduler.rs` thread the same 10-field turret
      config parameter list through ~19 call sites and ~16 signatures (fsm.rs 412, 747, 953, 985,
      1197; scheduler.rs 30, 82, 129, 145, 249, 268, 293, 371, 431, 717, 749, 819, 837, 870, 927,
      2014). Introduce one params struct.
- [ ] **D2** `body_pool.rs:1613-1637`, `1691-1710`, `1762-1781`, `1839-1858` — the same sphere-pair
      resolution preamble four times.
- [ ] **D3** `body_pool.rs:1960-2021` ≡ `2175-2233` (46-line dense-shape selection block).

- [ ] **D5** `pathfinder.rs:1158-1182` ≡ `1812-1836` ≡ `2445-2469` (23-line locomotion param block).

