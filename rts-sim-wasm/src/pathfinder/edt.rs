// Exact Euclidean distance transform for the pathfinder's obstacle layers.
//
// The planner gates every body by "distance from this cell's centre to the
// nearest obstacle cell centre" — a real-valued Euclidean distance, so a
// corridor's width is measured the way the collision disk actually
// experiences it. The previous Chebyshev chamfer under-measured diagonal
// corridors by up to sqrt(2) and forced whole-cell rounding on top.
//
// Distances are stored SQUARED in cell units (exact integers) and clamped to
// `EDT_CLAMP_SQ`; nothing in the planner ever needs to know that an obstacle
// is farther than `EDT_CLAMP_CELLS` away (the largest body radius plus the
// soft-clearance preference band is far below it), and the clamp is what
// makes building churn a LOCAL update instead of a map-wide rebuild.
//
// Full build: Meijster's two-pass separable transform, O(n).
// Incremental update: obstacles that appeared only LOWER distances, within
// `EDT_CLAMP_CELLS` of themselves (exact local dilation); obstacles that
// vanished can RAISE distances only within that radius, so a window with a
// 2× margin is re-solved standalone and the affected zone copied back — every
// obstacle that can matter to a cell in that zone lies inside the window, so
// the standalone solve is exact there.

/// Distances beyond this many cells are indistinguishable to every consumer
/// (max collision radius / cell + soft band, with margin). 20 wu cells: 12
/// cells = 240 wu, versus a 128 wu maximum roster radius.
pub(crate) const EDT_CLAMP_CELLS: i32 = 12;
pub(crate) const EDT_CLAMP_SQ: u16 = (EDT_CLAMP_CELLS * EDT_CLAMP_CELLS) as u16;

/// Scratch buffers reused across solves so building churn never allocates.
#[derive(Default)]
pub(crate) struct EdtScratch {
    g: Vec<i32>,
    window: Vec<u16>,
    s: Vec<usize>,
    t: Vec<i32>,
}

/// Full transform over the whole grid into `out` (indexed by grid cell).
pub(crate) fn edt_build_full(
    obstacle: &dyn Fn(usize) -> bool,
    grid_w: i32,
    grid_h: i32,
    out: &mut [u16],
    scratch: &mut EdtScratch,
) {
    edt_solve_window(obstacle, grid_w, 0, 0, grid_w, grid_h, scratch);
    let n = (grid_w * grid_h) as usize;
    out[..n].copy_from_slice(&scratch.window[..n]);
}

/// Solve the transform over the window [x0, x1) × [y0, y1) as if nothing
/// existed outside it. Result lands in `scratch.window`, row-major over the
/// window, clamped to `EDT_CLAMP_SQ`.
fn edt_solve_window(
    obstacle: &dyn Fn(usize) -> bool,
    grid_w: i32,
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
    scratch: &mut EdtScratch,
) {
    let win_w = (x1 - x0).max(0) as usize;
    let win_h = (y1 - y0).max(0) as usize;
    scratch.window.clear();
    scratch.window.resize(win_w * win_h, EDT_CLAMP_SQ);
    if win_w == 0 || win_h == 0 {
        return;
    }
    let inf = EDT_CLAMP_CELLS + 1;
    let g = &mut scratch.g;
    g.clear();
    g.resize(win_w * win_h, inf);
    // Phase 1: per column, 1-D distance (in cells) to the nearest obstacle in
    // that column, clamped at `inf`.
    for wx in 0..win_w {
        let gx = x0 + wx as i32;
        let mut run = inf;
        for wy in 0..win_h {
            let gy = y0 + wy as i32;
            if obstacle((gy * grid_w + gx) as usize) {
                run = 0;
            } else if run < inf {
                run += 1;
            }
            g[wy * win_w + wx] = run;
        }
        let mut run = inf;
        for wy in (0..win_h).rev() {
            let slot = wy * win_w + wx;
            if g[slot] == 0 {
                run = 0;
            } else if run < inf {
                run += 1;
            }
            if run < g[slot] {
                g[slot] = run;
            }
        }
    }
    // Phase 2: per row, lower envelope of the parabolas
    // f(x, i) = (x - i)^2 + g(i)^2 (Meijster et al.).
    let s = &mut scratch.s;
    let t = &mut scratch.t;
    for wy in 0..win_h {
        let row = wy * win_w;
        let f = |x: i32, i: usize| -> i32 {
            let d = x - i as i32;
            let gi = g[row + i];
            d * d + gi * gi
        };
        let sep = |i: usize, u: usize| -> i32 {
            let gi = g[row + i];
            let gu = g[row + u];
            let ii = i as i32;
            let uu = u as i32;
            (uu * uu - ii * ii + gu * gu - gi * gi).div_euclid(2 * (uu - ii))
        };
        s.clear();
        t.clear();
        s.push(0);
        t.push(0);
        for u in 1..win_w {
            loop {
                let q = s.len() - 1;
                if f(t[q], s[q]) > f(t[q], u) {
                    s.pop();
                    t.pop();
                    if s.is_empty() {
                        break;
                    }
                } else {
                    break;
                }
            }
            if s.is_empty() {
                s.push(u);
                t.push(0);
            } else {
                let q = s.len() - 1;
                let w = 1 + sep(s[q], u);
                if w < win_w as i32 {
                    s.push(u);
                    t.push(w);
                }
            }
        }
        let mut q = s.len() - 1;
        for u in (0..win_w).rev() {
            let d2 = f(u as i32, s[q]);
            scratch.window[row + u] = d2.min(EDT_CLAMP_SQ as i32) as u16;
            if u as i32 == t[q] && q > 0 {
                q -= 1;
            }
        }
    }
}

/// Lower obstacle distances around newly blocked cells: exact local dilation.
pub(crate) fn edt_apply_new_obstacles(grid_w: i32, grid_h: i32, cells: &[u32], out: &mut [u16]) {
    let r = EDT_CLAMP_CELLS;
    for &cell in cells {
        let cell = cell as i32;
        let cx = cell % grid_w;
        let cy = cell / grid_w;
        out[cell as usize] = 0;
        let y_lo = (cy - r).max(0);
        let y_hi = (cy + r).min(grid_h - 1);
        let x_lo = (cx - r).max(0);
        let x_hi = (cx + r).min(grid_w - 1);
        for gy in y_lo..=y_hi {
            let dy = gy - cy;
            let row = gy * grid_w;
            for gx in x_lo..=x_hi {
                let dx = gx - cx;
                let d2 = dx * dx + dy * dy;
                if d2 > EDT_CLAMP_SQ as i32 {
                    continue;
                }
                let idx = (row + gx) as usize;
                if (d2 as u16) < out[idx] {
                    out[idx] = d2 as u16;
                }
            }
        }
    }
}

/// Re-solve around obstacles that vanished. `obstacle` must report the
/// CURRENT obstacle set (the vanished cells are no longer in it). Only cells
/// within `EDT_CLAMP_CELLS` of a vanished cell can change; the window is
/// solved standalone with a 2× margin so those cells see every obstacle that
/// can bound them, and only that zone is written back.
pub(crate) fn edt_apply_removed_obstacles(
    obstacle: &dyn Fn(usize) -> bool,
    grid_w: i32,
    grid_h: i32,
    cells: &[u32],
    out: &mut [u16],
    scratch: &mut EdtScratch,
) {
    if cells.is_empty() {
        return;
    }
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    for &cell in cells {
        let cell = cell as i32;
        let cx = cell % grid_w;
        let cy = cell / grid_w;
        min_x = min_x.min(cx);
        max_x = max_x.max(cx);
        min_y = min_y.min(cy);
        max_y = max_y.max(cy);
    }
    let r = EDT_CLAMP_CELLS;
    let x0 = (min_x - 2 * r).max(0);
    let y0 = (min_y - 2 * r).max(0);
    let x1 = (max_x + 2 * r + 1).min(grid_w);
    let y1 = (max_y + 2 * r + 1).min(grid_h);
    edt_solve_window(obstacle, grid_w, x0, y0, x1, y1, scratch);
    let win_w = (x1 - x0) as usize;
    let zx0 = (min_x - r).max(0);
    let zy0 = (min_y - r).max(0);
    let zx1 = (max_x + r + 1).min(grid_w);
    let zy1 = (max_y + r + 1).min(grid_h);
    for gy in zy0..zy1 {
        for gx in zx0..zx1 {
            let idx = (gy * grid_w + gx) as usize;
            let wslot = ((gy - y0) as usize) * win_w + (gx - x0) as usize;
            out[idx] = scratch.window[wslot];
        }
    }
}

#[cfg(test)]
mod edt_tests {
    use super::*;

    fn brute(obstacle: &[u8], w: i32, h: i32) -> Vec<u16> {
        let mut out = vec![EDT_CLAMP_SQ; (w * h) as usize];
        for y in 0..h {
            for x in 0..w {
                let idx = (y * w + x) as usize;
                if obstacle[idx] != 0 {
                    out[idx] = 0;
                    continue;
                }
                let mut best = EDT_CLAMP_SQ as i32;
                for oy in 0..h {
                    for ox in 0..w {
                        if obstacle[(oy * w + ox) as usize] == 0 {
                            continue;
                        }
                        let d2 = (ox - x) * (ox - x) + (oy - y) * (oy - y);
                        if d2 < best {
                            best = d2;
                        }
                    }
                }
                out[idx] = best as u16;
            }
        }
        out
    }

    fn pattern(w: i32, h: i32, seed: u32) -> Vec<u8> {
        let mut s = seed;
        (0..(w * h))
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                if s % 11 == 0 {
                    1
                } else {
                    0
                }
            })
            .collect()
    }

    #[test]
    fn full_transform_matches_brute_force_with_clamp() {
        let (w, h) = (37, 29);
        let obs = pattern(w, h, 0x9e37_79b9);
        let mut out = vec![0u16; (w * h) as usize];
        let mut scratch = EdtScratch::default();
        edt_build_full(&|i| obs[i] != 0, w, h, &mut out, &mut scratch);
        assert_eq!(out, brute(&obs, w, h));
        // Sparse map: most cells sit at the clamp.
        let (w, h) = (40, 40);
        let mut sparse = vec![0u8; (w * h) as usize];
        sparse[(20 * w + 20) as usize] = 1;
        let mut out = vec![0u16; (w * h) as usize];
        edt_build_full(&|i| sparse[i] != 0, w, h, &mut out, &mut scratch);
        assert_eq!(out, brute(&sparse, w, h));
    }

    #[test]
    fn incremental_add_and_remove_stay_exact() {
        let (w, h) = (48, 40);
        let mut obs = pattern(w, h, 0x1234_5678);
        let mut out = vec![0u16; (w * h) as usize];
        let mut scratch = EdtScratch::default();
        edt_build_full(&|i| obs[i] != 0, w, h, &mut out, &mut scratch);
        let mut added = Vec::new();
        for y in 10..15 {
            for x in 20..25 {
                let idx = (y * w + x) as usize;
                if obs[idx] == 0 {
                    obs[idx] = 1;
                    added.push(idx as u32);
                }
            }
        }
        edt_apply_new_obstacles(w, h, &added, &mut out);
        assert_eq!(out, brute(&obs, w, h), "after add");
        let mut removed = Vec::new();
        for &idx in &added {
            obs[idx as usize] = 0;
            removed.push(idx);
        }
        for idx in [3usize, 77, 400, 1500] {
            if obs[idx] != 0 {
                obs[idx] = 0;
                removed.push(idx as u32);
            }
        }
        let obs_ref = obs.clone();
        edt_apply_removed_obstacles(&|i| obs_ref[i] != 0, w, h, &removed, &mut out, &mut scratch);
        assert_eq!(out, brute(&obs, w, h), "after remove");
    }

    #[test]
    fn diagonal_corridor_is_measured_euclidean() {
        // Walls along x = y + 3 and x = y - 3: the centre diagonal is a
        // 5-cell-wide (Chebyshev 2) corridor whose Euclidean half-width is
        // sqrt(5) cells, not 2.
        let (w, h) = (12, 12);
        let mut obs = vec![0u8; (w * h) as usize];
        for i in 0..12 {
            if i + 3 < 12 {
                obs[(i * w + i + 3) as usize] = 1;
            }
            if i >= 3 {
                obs[(i * w + i - 3) as usize] = 1;
            }
        }
        let mut out = vec![0u16; (w * h) as usize];
        let mut scratch = EdtScratch::default();
        edt_build_full(&|i| obs[i] != 0, w, h, &mut out, &mut scratch);
        assert_eq!(out[(6 * w + 6) as usize], 5);
        assert_eq!(out, brute(&obs, w, h));
    }
}
