// WASM Physics Engine — 1:1 port of PhysicsEngine.ts
// Struct-of-Arrays layout for zero-copy JS interop via typed array views.
// Phase 3: bulk sync buffer for zero-copy reads from JS
// Phase 4: broadphase grid, turret rotation batch, projectile integration batch

use wasm_bindgen::prelude::*;
use std::f64::consts::PI;

// ---------------------------------------------------------------------------
// Struct-of-Arrays storage for dynamic (circle) and static (rect) bodies
// ---------------------------------------------------------------------------

const INITIAL_CAPACITY: usize = 512;

struct DynamicBodies {
    x: Vec<f64>,
    y: Vec<f64>,
    vx: Vec<f64>,
    vy: Vec<f64>,
    radius: Vec<f64>,
    mass: Vec<f64>,
    inv_mass: Vec<f64>,
    friction_air: Vec<f64>,
    restitution: Vec<f64>,
    accel_x: Vec<f64>,
    accel_y: Vec<f64>,
    /// Per-packed-index: static slot to ignore for collision (u32::MAX = none)
    ignore_static: Vec<u32>,
    alive: Vec<bool>,
    /// Maps external slot index → packed index (or usize::MAX if dead)
    slot_to_packed: Vec<usize>,
    /// Maps packed index → external slot index
    packed_to_slot: Vec<usize>,
    /// Free slot indices for reuse
    free_slots: Vec<usize>,
    count: usize,
}

impl DynamicBodies {
    fn new() -> Self {
        Self {
            x: Vec::with_capacity(INITIAL_CAPACITY),
            y: Vec::with_capacity(INITIAL_CAPACITY),
            vx: Vec::with_capacity(INITIAL_CAPACITY),
            vy: Vec::with_capacity(INITIAL_CAPACITY),
            radius: Vec::with_capacity(INITIAL_CAPACITY),
            mass: Vec::with_capacity(INITIAL_CAPACITY),
            inv_mass: Vec::with_capacity(INITIAL_CAPACITY),
            friction_air: Vec::with_capacity(INITIAL_CAPACITY),
            restitution: Vec::with_capacity(INITIAL_CAPACITY),
            accel_x: Vec::with_capacity(INITIAL_CAPACITY),
            accel_y: Vec::with_capacity(INITIAL_CAPACITY),
            ignore_static: Vec::with_capacity(INITIAL_CAPACITY),
            alive: Vec::with_capacity(INITIAL_CAPACITY),
            slot_to_packed: Vec::with_capacity(INITIAL_CAPACITY),
            packed_to_slot: Vec::with_capacity(INITIAL_CAPACITY),
            free_slots: Vec::new(),
            count: 0,
        }
    }

    fn add(
        &mut self,
        x: f64,
        y: f64,
        radius: f64,
        mass: f64,
        friction_air: f64,
        restitution: f64,
    ) -> u32 {
        let packed = self.count;
        self.count += 1;

        self.x.push(x);
        self.y.push(y);
        self.vx.push(0.0);
        self.vy.push(0.0);
        self.radius.push(radius);
        self.mass.push(mass);
        self.inv_mass.push(if mass > 0.0 { 1.0 / mass } else { 0.0 });
        self.friction_air.push(friction_air);
        self.restitution.push(restitution);
        self.accel_x.push(0.0);
        self.accel_y.push(0.0);
        self.ignore_static.push(u32::MAX);

        let slot = if let Some(s) = self.free_slots.pop() {
            self.alive[s] = true;
            self.slot_to_packed[s] = packed;
            s
        } else {
            let s = self.alive.len();
            self.alive.push(true);
            self.slot_to_packed.push(packed);
            s
        };

        self.packed_to_slot.push(slot);
        slot as u32
    }

    fn remove(&mut self, slot: u32) {
        let slot = slot as usize;
        if slot >= self.alive.len() || !self.alive[slot] {
            return;
        }
        self.alive[slot] = false;
        let packed = self.slot_to_packed[slot];
        let last = self.count - 1;

        if packed < last {
            self.x[packed] = self.x[last];
            self.y[packed] = self.y[last];
            self.vx[packed] = self.vx[last];
            self.vy[packed] = self.vy[last];
            self.radius[packed] = self.radius[last];
            self.mass[packed] = self.mass[last];
            self.inv_mass[packed] = self.inv_mass[last];
            self.friction_air[packed] = self.friction_air[last];
            self.restitution[packed] = self.restitution[last];
            self.accel_x[packed] = self.accel_x[last];
            self.accel_y[packed] = self.accel_y[last];
            self.ignore_static[packed] = self.ignore_static[last];

            let moved_slot = self.packed_to_slot[last];
            self.slot_to_packed[moved_slot] = packed;
            self.packed_to_slot[packed] = moved_slot;
        }

        self.count -= 1;
        self.x.truncate(self.count);
        self.y.truncate(self.count);
        self.vx.truncate(self.count);
        self.vy.truncate(self.count);
        self.radius.truncate(self.count);
        self.mass.truncate(self.count);
        self.inv_mass.truncate(self.count);
        self.friction_air.truncate(self.count);
        self.restitution.truncate(self.count);
        self.accel_x.truncate(self.count);
        self.accel_y.truncate(self.count);
        self.ignore_static.truncate(self.count);
        self.packed_to_slot.truncate(self.count);

        self.slot_to_packed[slot] = usize::MAX;
        self.free_slots.push(slot);
    }
}

struct StaticBodies {
    x: Vec<f64>,
    y: Vec<f64>,
    half_w: Vec<f64>,
    half_h: Vec<f64>,
    restitution: Vec<f64>,
    alive: Vec<bool>,
    slot_to_packed: Vec<usize>,
    packed_to_slot: Vec<usize>,
    free_slots: Vec<usize>,
    count: usize,
}

impl StaticBodies {
    fn new() -> Self {
        Self {
            x: Vec::with_capacity(64),
            y: Vec::with_capacity(64),
            half_w: Vec::with_capacity(64),
            half_h: Vec::with_capacity(64),
            restitution: Vec::with_capacity(64),
            alive: Vec::with_capacity(64),
            slot_to_packed: Vec::with_capacity(64),
            packed_to_slot: Vec::with_capacity(64),
            free_slots: Vec::new(),
            count: 0,
        }
    }

    fn add(&mut self, x: f64, y: f64, half_w: f64, half_h: f64, restitution: f64) -> u32 {
        let packed = self.count;
        self.count += 1;

        self.x.push(x);
        self.y.push(y);
        self.half_w.push(half_w);
        self.half_h.push(half_h);
        self.restitution.push(restitution);

        let slot = if let Some(s) = self.free_slots.pop() {
            self.alive[s] = true;
            self.slot_to_packed[s] = packed;
            s
        } else {
            let s = self.alive.len();
            self.alive.push(true);
            self.slot_to_packed.push(packed);
            s
        };

        self.packed_to_slot.push(slot);
        slot as u32
    }

    fn remove(&mut self, slot: u32) {
        let slot = slot as usize;
        if slot >= self.alive.len() || !self.alive[slot] {
            return;
        }
        self.alive[slot] = false;
        let packed = self.slot_to_packed[slot];
        let last = self.count - 1;

        if packed < last {
            self.x[packed] = self.x[last];
            self.y[packed] = self.y[last];
            self.half_w[packed] = self.half_w[last];
            self.half_h[packed] = self.half_h[last];
            self.restitution[packed] = self.restitution[last];

            let moved_slot = self.packed_to_slot[last];
            self.slot_to_packed[moved_slot] = packed;
            self.packed_to_slot[packed] = moved_slot;
        }

        self.count -= 1;
        self.x.truncate(self.count);
        self.y.truncate(self.count);
        self.half_w.truncate(self.count);
        self.half_h.truncate(self.count);
        self.restitution.truncate(self.count);
        self.packed_to_slot.truncate(self.count);

        self.slot_to_packed[slot] = usize::MAX;
        self.free_slots.push(slot);
    }
}

// ---------------------------------------------------------------------------
// Broadphase grid — linked-list-per-cell for O(n*k) collision detection
// ---------------------------------------------------------------------------

struct BroadphaseGrid {
    cell_size: f64,
    inv_cell_size: f64,
    cols: usize,
    /// Head of linked list per cell (body packed index, or u32::MAX = empty)
    cell_heads: Vec<u32>,
    /// Next pointer per body (packed index → next in same cell)
    body_next: Vec<u32>,
}

impl BroadphaseGrid {
    fn new() -> Self {
        Self {
            cell_size: 100.0,
            inv_cell_size: 1.0 / 100.0,
            cols: 0,
            cell_heads: Vec::new(),
            body_next: Vec::new(),
        }
    }

    fn build(&mut self, dyn_bodies: &DynamicBodies, map_width: f64, map_height: f64) {
        let n = dyn_bodies.count;
        if n == 0 {
            return;
        }

        // Cell size = 2 * max_radius (body spans at most 4 cells)
        let mut max_r: f64 = 0.0;
        for i in 0..n {
            if dyn_bodies.radius[i] > max_r {
                max_r = dyn_bodies.radius[i];
            }
        }
        self.cell_size = (max_r * 2.0).max(50.0);
        self.inv_cell_size = 1.0 / self.cell_size;

        self.cols = (map_width * self.inv_cell_size).ceil() as usize + 1;
        let rows = (map_height * self.inv_cell_size).ceil() as usize + 1;
        let num_cells = self.cols * rows;

        // Reset cell heads
        self.cell_heads.resize(num_cells, u32::MAX);
        self.cell_heads.fill(u32::MAX);
        self.body_next.resize(n, u32::MAX);

        // Insert each body into its cell's linked list
        for i in 0..n {
            let cx = (dyn_bodies.x[i] * self.inv_cell_size) as usize;
            let cy = (dyn_bodies.y[i] * self.inv_cell_size) as usize;
            let cell = cy * self.cols + cx;
            if cell < num_cells {
                self.body_next[i] = self.cell_heads[cell];
                self.cell_heads[cell] = i as u32;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[inline]
fn normalize_angle(mut a: f64) -> f64 {
    a %= 2.0 * PI;
    if a > PI {
        a -= 2.0 * PI;
    } else if a < -PI {
        a += 2.0 * PI;
    }
    a
}

// ---------------------------------------------------------------------------
// PhysicsEngine
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct PhysicsEngine {
    dynamic: DynamicBodies,
    statics: StaticBodies,
    map_width: f64,
    map_height: f64,
    // Phase 3: bulk sync output buffer [x, y, vx, vy] per slot
    sync_buf: Vec<f64>,
    // Phase 4: broadphase grid for collision detection
    grid: BroadphaseGrid,
    // Phase 4: turret batch buffers
    // Input: [rotation, angularVelocity, turnAccel, drag, targetAngle, hasTarget] per turret
    turret_in: Vec<f64>,
    // Output: [rotation, angularVelocity] per turret
    turret_out: Vec<f64>,
    // Phase 4: projectile batch buffers
    // Input: [x, y, vx, vy, targetX, targetY, turnRate, hasHoming] per projectile
    proj_in: Vec<f64>,
    // Output: [x, y, vx, vy, rotation] per projectile
    proj_out: Vec<f64>,
}

#[wasm_bindgen]
impl PhysicsEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(map_width: f64, map_height: f64) -> Self {
        Self {
            dynamic: DynamicBodies::new(),
            statics: StaticBodies::new(),
            map_width,
            map_height,
            sync_buf: Vec::with_capacity(INITIAL_CAPACITY * 4),
            grid: BroadphaseGrid::new(),
            turret_in: Vec::new(),
            turret_out: Vec::new(),
            proj_in: Vec::new(),
            proj_out: Vec::new(),
        }
    }

    // -- Body management --

    pub fn add_dynamic_body(
        &mut self,
        x: f64,
        y: f64,
        radius: f64,
        mass: f64,
        friction_air: f64,
        restitution: f64,
    ) -> u32 {
        self.dynamic.add(x, y, radius, mass, friction_air, restitution)
    }

    pub fn remove_dynamic_body(&mut self, slot: u32) {
        self.dynamic.remove(slot);
    }

    pub fn add_static_body(
        &mut self,
        x: f64,
        y: f64,
        half_w: f64,
        half_h: f64,
        restitution: f64,
    ) -> u32 {
        self.statics.add(x, y, half_w, half_h, restitution)
    }

    pub fn remove_static_body(&mut self, slot: u32) {
        self.statics.remove(slot);
    }

    // -- Ignore static (unit spawning inside factory) --

    pub fn set_ignore_static(&mut self, dynamic_slot: u32, static_slot: u32) {
        let s = dynamic_slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] {
            return;
        }
        let p = self.dynamic.slot_to_packed[s];
        self.dynamic.ignore_static[p] = static_slot;
    }

    // -- Force accumulation --

    pub fn apply_force(&mut self, slot: u32, fx: f64, fy: f64) {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] {
            return;
        }
        let p = self.dynamic.slot_to_packed[s];
        let inv_mass = self.dynamic.inv_mass[p];
        self.dynamic.accel_x[p] += fx * inv_mass;
        self.dynamic.accel_y[p] += fy * inv_mass;
    }

    // -- The hot path --

    pub fn step(&mut self, dt_sec: f64) {
        let n = self.dynamic.count;
        if n == 0 {
            return;
        }

        let dt_frames = dt_sec * 60.0;

        // 1. Air friction (dt-independent exponential damping)
        let default_damping = (1.0_f64 - 0.15).powf(dt_frames);
        for i in 0..n {
            let fa = self.dynamic.friction_air[i];
            let damping = if fa == 0.15 {
                default_damping
            } else {
                (1.0 - fa).powf(dt_frames)
            };
            self.dynamic.vx[i] *= damping;
            self.dynamic.vy[i] *= damping;
        }

        // 2. Integrate: v += a * dt, pos += v * dt
        for i in 0..n {
            let ax = self.dynamic.accel_x[i];
            let ay = self.dynamic.accel_y[i];
            self.dynamic.vx[i] += ax * dt_sec;
            self.dynamic.vy[i] += ay * dt_sec;
            self.dynamic.x[i] += self.dynamic.vx[i] * dt_sec;
            self.dynamic.y[i] += self.dynamic.vy[i] * dt_sec;
        }

        // 2b. Clamp to map boundaries
        let map_w = self.map_width;
        let map_h = self.map_height;
        for i in 0..n {
            let r = self.dynamic.radius[i];
            let x = &mut self.dynamic.x[i];
            let vx = &mut self.dynamic.vx[i];
            if *x < r {
                *x = r;
                if *vx < 0.0 { *vx = 0.0; }
            } else if *x > map_w - r {
                *x = map_w - r;
                if *vx > 0.0 { *vx = 0.0; }
            }

            let y = &mut self.dynamic.y[i];
            let vy = &mut self.dynamic.vy[i];
            if *y < r {
                *y = r;
                if *vy < 0.0 { *vy = 0.0; }
            } else if *y > map_h - r {
                *y = map_h - r;
                if *vy > 0.0 { *vy = 0.0; }
            }
        }

        // Clear accumulated forces
        for i in 0..n {
            self.dynamic.accel_x[i] = 0.0;
            self.dynamic.accel_y[i] = 0.0;
        }

        // 3. Resolve collisions (broadphase grid)
        self.resolve_collisions_broadphase();
    }

    // Phase 4: broadphase collision detection using uniform grid
    fn resolve_collisions_broadphase(&mut self) {
        let n = self.dynamic.count;
        let ns = self.statics.count;
        if n == 0 {
            return;
        }

        // Build spatial grid
        self.grid.build(&self.dynamic, self.map_width, self.map_height);
        let cols = self.grid.cols;
        let num_cells = self.grid.cell_heads.len();
        let rows = if cols > 0 { num_cells / cols } else { 0 };

        // For each cell, check pairs within and with 4 forward neighbors
        // (right, below-left, below, below-right) to avoid double-checking
        for cy in 0..rows {
            for cx in 0..cols {
                let cell = cy * cols + cx;

                // Pairs within this cell
                self.check_circle_pairs_in_cell(cell);

                // Pairs with forward neighbors
                if cx + 1 < cols {
                    self.check_circle_pairs_cross(cell, cy * cols + cx + 1);
                }
                if cy + 1 < rows {
                    if cx > 0 {
                        self.check_circle_pairs_cross(cell, (cy + 1) * cols + cx - 1);
                    }
                    self.check_circle_pairs_cross(cell, (cy + 1) * cols + cx);
                    if cx + 1 < cols {
                        self.check_circle_pairs_cross(cell, (cy + 1) * cols + cx + 1);
                    }
                }
            }
        }

        // Circle-rect (dynamic vs static) — statics are few, brute force is fine
        for i in 0..n {
            let mut ignored = self.dynamic.ignore_static[i];
            for s in 0..ns {
                // Skip collision with the source building (unit spawning inside factory)
                if ignored != u32::MAX {
                    let static_slot = self.statics.packed_to_slot[s];
                    if static_slot == ignored as usize {
                        // Check if unit has fully left the building — clear ignore
                        let ax = self.dynamic.x[i];
                        let ay = self.dynamic.y[i];
                        let ar = self.dynamic.radius[i];
                        let rx = self.statics.x[s];
                        let ry = self.statics.y[s];
                        let hw = self.statics.half_w[s];
                        let hh = self.statics.half_h[s];
                        let c = ar + 2.0;
                        if ax > rx + hw + c || ax < rx - hw - c ||
                           ay > ry + hh + c || ay < ry - hh - c {
                            self.dynamic.ignore_static[i] = u32::MAX;
                            ignored = u32::MAX;
                        } else {
                            continue;
                        }
                    }
                }
                self.resolve_circle_rect(i, s);
            }
        }
    }

    /// Check all dynamic-dynamic pairs within a single cell
    fn check_circle_pairs_in_cell(&mut self, cell: usize) {
        let mut a_idx = self.grid.cell_heads[cell];
        while a_idx != u32::MAX {
            let mut b_idx = self.grid.body_next[a_idx as usize];
            while b_idx != u32::MAX {
                self.resolve_circle_circle(a_idx as usize, b_idx as usize);
                b_idx = self.grid.body_next[b_idx as usize];
            }
            a_idx = self.grid.body_next[a_idx as usize];
        }
    }

    /// Check all dynamic-dynamic pairs between two cells
    fn check_circle_pairs_cross(&mut self, cell_a: usize, cell_b: usize) {
        let mut a_idx = self.grid.cell_heads[cell_a];
        while a_idx != u32::MAX {
            let mut b_idx = self.grid.cell_heads[cell_b];
            while b_idx != u32::MAX {
                self.resolve_circle_circle(a_idx as usize, b_idx as usize);
                b_idx = self.grid.body_next[b_idx as usize];
            }
            a_idx = self.grid.body_next[a_idx as usize];
        }
    }

    /// Resolve a single circle-circle collision pair
    #[inline]
    fn resolve_circle_circle(&mut self, i: usize, j: usize) {
        let dx = self.dynamic.x[j] - self.dynamic.x[i];
        let dy = self.dynamic.y[j] - self.dynamic.y[i];
        let dist_sq = dx * dx + dy * dy;
        let min_dist = self.dynamic.radius[i] + self.dynamic.radius[j];
        if dist_sq >= min_dist * min_dist || dist_sq == 0.0 {
            return;
        }

        let dist = dist_sq.sqrt();
        let overlap = min_dist - dist;
        let nx = dx / dist;
        let ny = dy / dist;

        let inv_a = self.dynamic.inv_mass[i];
        let inv_b = self.dynamic.inv_mass[j];
        let total_inv = inv_a + inv_b;
        if total_inv == 0.0 {
            return;
        }

        // Positional correction
        let corr_a = overlap * (inv_a / total_inv);
        let corr_b = overlap * (inv_b / total_inv);
        self.dynamic.x[i] -= nx * corr_a;
        self.dynamic.y[i] -= ny * corr_a;
        self.dynamic.x[j] += nx * corr_b;
        self.dynamic.y[j] += ny * corr_b;

        // Impulse-based velocity correction
        let rel_vn = (self.dynamic.vx[j] - self.dynamic.vx[i]) * nx
            + (self.dynamic.vy[j] - self.dynamic.vy[i]) * ny;
        if rel_vn >= 0.0 {
            return;
        }

        let rest_a = self.dynamic.restitution[i];
        let rest_b = self.dynamic.restitution[j];
        let restitution = if rest_a < rest_b { rest_a } else { rest_b };
        let impulse = -(1.0 + restitution) * rel_vn / total_inv;
        self.dynamic.vx[i] -= impulse * inv_a * nx;
        self.dynamic.vy[i] -= impulse * inv_a * ny;
        self.dynamic.vx[j] += impulse * inv_b * nx;
        self.dynamic.vy[j] += impulse * inv_b * ny;
    }

    /// Resolve a single circle-rect collision
    #[inline]
    fn resolve_circle_rect(&mut self, i: usize, s: usize) {
        let hw = self.statics.half_w[s];
        let hh = self.statics.half_h[s];
        let rx = self.statics.x[s];
        let ry = self.statics.y[s];

        let ax = self.dynamic.x[i];
        let ay = self.dynamic.y[i];
        let ar = self.dynamic.radius[i];

        let clamped_x = ax.max(rx - hw).min(rx + hw);
        let clamped_y = ay.max(ry - hh).min(ry + hh);

        let dx = ax - clamped_x;
        let dy = ay - clamped_y;
        let dist_sq = dx * dx + dy * dy;

        if dist_sq >= ar * ar || dist_sq == 0.0 {
            if dist_sq == 0.0
                && ax >= rx - hw
                && ax <= rx + hw
                && ay >= ry - hh
                && ay <= ry + hh
            {
                let left = ax - (rx - hw);
                let right = (rx + hw) - ax;
                let top = ay - (ry - hh);
                let bottom = (ry + hh) - ay;
                let min_pen = left.min(right).min(top).min(bottom);
                let rest = self.statics.restitution[s];

                if min_pen == left {
                    self.dynamic.x[i] = rx - hw - ar;
                    if self.dynamic.vx[i] > 0.0 { self.dynamic.vx[i] *= -rest; }
                } else if min_pen == right {
                    self.dynamic.x[i] = rx + hw + ar;
                    if self.dynamic.vx[i] < 0.0 { self.dynamic.vx[i] *= -rest; }
                } else if min_pen == top {
                    self.dynamic.y[i] = ry - hh - ar;
                    if self.dynamic.vy[i] > 0.0 { self.dynamic.vy[i] *= -rest; }
                } else {
                    self.dynamic.y[i] = ry + hh + ar;
                    if self.dynamic.vy[i] < 0.0 { self.dynamic.vy[i] *= -rest; }
                }
            }
            return;
        }

        let dist = dist_sq.sqrt();
        let overlap = ar - dist;
        let nx = dx / dist;
        let ny = dy / dist;

        self.dynamic.x[i] += nx * overlap;
        self.dynamic.y[i] += ny * overlap;

        let v_dot_n = self.dynamic.vx[i] * nx + self.dynamic.vy[i] * ny;
        if v_dot_n < 0.0 {
            let rest = self.statics.restitution[s];
            self.dynamic.vx[i] -= (1.0 + rest) * v_dot_n * nx;
            self.dynamic.vy[i] -= (1.0 + rest) * v_dot_n * ny;
        }
    }

    // -----------------------------------------------------------------------
    // Phase 3: Bulk sync — one WASM call replaces N*4 getter calls
    // Layout: [x, y, vx, vy] per slot index. Dead slots are zeroed.
    // -----------------------------------------------------------------------

    /// Prepare bulk sync buffer and return pointer. JS reads via Float64Array view.
    pub fn bulk_sync(&mut self) -> *const f64 {
        let max_slots = self.dynamic.alive.len();
        self.sync_buf.resize(max_slots * 4, 0.0);
        for slot in 0..max_slots {
            let base = slot * 4;
            if !self.dynamic.alive[slot] {
                self.sync_buf[base] = 0.0;
                self.sync_buf[base + 1] = 0.0;
                self.sync_buf[base + 2] = 0.0;
                self.sync_buf[base + 3] = 0.0;
                continue;
            }
            let p = self.dynamic.slot_to_packed[slot];
            self.sync_buf[base] = self.dynamic.x[p];
            self.sync_buf[base + 1] = self.dynamic.y[p];
            self.sync_buf[base + 2] = self.dynamic.vx[p];
            self.sync_buf[base + 3] = self.dynamic.vy[p];
        }
        self.sync_buf.as_ptr()
    }

    /// Number of slots (alive + dead) for sizing the JS typed array view.
    pub fn max_slot_count(&self) -> u32 {
        self.dynamic.alive.len() as u32
    }

    // -----------------------------------------------------------------------
    // Phase 4: Turret rotation batch processing
    // JS packs input, calls this, reads output. One WASM boundary crossing.
    // Input stride=6: [rotation, angVel, turnAccel, drag, targetAngle, hasTarget]
    // Output stride=2: [rotation, angVel]
    // -----------------------------------------------------------------------

    /// Resize turret input buffer and return pointer for JS to write into.
    pub fn turret_in_alloc(&mut self, count: u32) -> *mut f64 {
        let len = count as usize * 6;
        self.turret_in.resize(len, 0.0);
        self.turret_in.as_mut_ptr()
    }

    /// Run turret rotation update and return pointer to output buffer.
    pub fn turret_update(&mut self, count: u32, dt_sec: f64) -> *const f64 {
        let n = count as usize;
        let dt_frames = dt_sec * 60.0;
        self.turret_out.resize(n * 2, 0.0);

        // Cache drag factors (few unique values)
        // Simple inline cache: last_drag + last_factor
        let mut cached_drag: f64 = -1.0;
        let mut cached_factor: f64 = 0.0;

        for i in 0..n {
            let base_in = i * 6;
            let rotation = self.turret_in[base_in];
            let mut ang_vel = self.turret_in[base_in + 1];
            let turn_accel = self.turret_in[base_in + 2];
            let drag = self.turret_in[base_in + 3];
            let target_angle = self.turret_in[base_in + 4];
            let has_target = self.turret_in[base_in + 5];

            // Compute drag factor (cached for repeated values)
            if drag != cached_drag {
                cached_drag = drag;
                cached_factor = (1.0 - drag).powf(dt_frames);
            }

            let mut new_rot = rotation;

            if has_target > 0.5 {
                let angle_diff = normalize_angle(target_angle - rotation);
                let accel_dir = if angle_diff > 0.0 {
                    1.0
                } else if angle_diff < 0.0 {
                    -1.0
                } else {
                    0.0
                };
                ang_vel += accel_dir * turn_accel * dt_sec;
            }

            ang_vel *= cached_factor;
            new_rot += ang_vel * dt_sec;
            new_rot = normalize_angle(new_rot);

            let base_out = i * 2;
            self.turret_out[base_out] = new_rot;
            self.turret_out[base_out + 1] = ang_vel;
        }
        self.turret_out.as_ptr()
    }

    // -----------------------------------------------------------------------
    // Phase 4: Projectile integration batch
    // Handles position update + homing steering in WASM.
    // Input stride=8: [x, y, vx, vy, targetX, targetY, turnRate, hasHoming]
    // Output stride=5: [x, y, vx, vy, rotation]
    // -----------------------------------------------------------------------

    /// Resize projectile input buffer and return pointer for JS to write into.
    pub fn proj_in_alloc(&mut self, count: u32) -> *mut f64 {
        let len = count as usize * 8;
        self.proj_in.resize(len, 0.0);
        self.proj_in.as_mut_ptr()
    }

    /// Run projectile integration and return pointer to output buffer.
    pub fn proj_update(&mut self, count: u32, dt_sec: f64) -> *const f64 {
        let n = count as usize;
        self.proj_out.resize(n * 5, 0.0);

        for i in 0..n {
            let base_in = i * 8;
            let mut x = self.proj_in[base_in];
            let mut y = self.proj_in[base_in + 1];
            let mut vx = self.proj_in[base_in + 2];
            let mut vy = self.proj_in[base_in + 3];
            let target_x = self.proj_in[base_in + 4];
            let target_y = self.proj_in[base_in + 5];
            let turn_rate = self.proj_in[base_in + 6];
            let has_homing = self.proj_in[base_in + 7];

            // Position integration
            x += vx * dt_sec;
            y += vy * dt_sec;

            let mut rotation = vx.atan2(vy); // default rotation from velocity

            // Homing steering (same as applyHomingSteering in math.ts)
            if has_homing > 0.5 && turn_rate > 0.0 {
                let dx = target_x - x;
                let dy = target_y - y;
                let desired_angle = dy.atan2(dx);
                let speed = (vx * vx + vy * vy).sqrt();

                if speed > 0.0 {
                    let current_angle = vy.atan2(vx);
                    let angle_diff = normalize_angle(desired_angle - current_angle);
                    let max_turn = turn_rate * dt_sec;
                    let turn = if angle_diff.abs() < max_turn {
                        angle_diff
                    } else {
                        max_turn * if angle_diff > 0.0 { 1.0 } else { -1.0 }
                    };
                    let new_angle = current_angle + turn;
                    vx = new_angle.cos() * speed;
                    vy = new_angle.sin() * speed;
                    rotation = new_angle;
                }
            }

            let base_out = i * 5;
            self.proj_out[base_out] = x;
            self.proj_out[base_out + 1] = y;
            self.proj_out[base_out + 2] = vx;
            self.proj_out[base_out + 3] = vy;
            self.proj_out[base_out + 4] = rotation;
        }
        self.proj_out.as_ptr()
    }

    // -- Legacy per-slot getters (kept for compatibility) --

    pub fn dynamic_count(&self) -> u32 {
        self.dynamic.count as u32
    }

    pub fn get_x(&self, slot: u32) -> f64 {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] { return 0.0; }
        self.dynamic.x[self.dynamic.slot_to_packed[s]]
    }

    pub fn get_y(&self, slot: u32) -> f64 {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] { return 0.0; }
        self.dynamic.y[self.dynamic.slot_to_packed[s]]
    }

    pub fn get_vx(&self, slot: u32) -> f64 {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] { return 0.0; }
        self.dynamic.vx[self.dynamic.slot_to_packed[s]]
    }

    pub fn get_vy(&self, slot: u32) -> f64 {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] { return 0.0; }
        self.dynamic.vy[self.dynamic.slot_to_packed[s]]
    }

    pub fn get_mass(&self, slot: u32) -> f64 {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] { return 0.0; }
        self.dynamic.mass[self.dynamic.slot_to_packed[s]]
    }
}
