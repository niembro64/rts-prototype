// WASM Physics Engine — 1:1 port of PhysicsEngine.ts
// Struct-of-Arrays layout for zero-copy JS interop via typed array views.

use wasm_bindgen::prelude::*;

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

        // Grow packed arrays
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

        // Assign a slot index
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
            // Swap-remove: move last packed element into the hole
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

            // Update the moved element's mapping
            let moved_slot = self.packed_to_slot[last];
            self.slot_to_packed[moved_slot] = packed;
            self.packed_to_slot[packed] = moved_slot;
        }

        // Truncate
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
// PhysicsEngine
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct PhysicsEngine {
    dynamic: DynamicBodies,
    statics: StaticBodies,
    map_width: f64,
    map_height: f64,
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
        // Hoist common case: frictionAir = 0.15
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
                if *vx < 0.0 {
                    *vx = 0.0;
                }
            } else if *x > map_w - r {
                *x = map_w - r;
                if *vx > 0.0 {
                    *vx = 0.0;
                }
            }

            let y = &mut self.dynamic.y[i];
            let vy = &mut self.dynamic.vy[i];
            if *y < r {
                *y = r;
                if *vy < 0.0 {
                    *vy = 0.0;
                }
            } else if *y > map_h - r {
                *y = map_h - r;
                if *vy > 0.0 {
                    *vy = 0.0;
                }
            }
        }

        // Clear accumulated forces
        for i in 0..n {
            self.dynamic.accel_x[i] = 0.0;
            self.dynamic.accel_y[i] = 0.0;
        }

        // 3. Resolve collisions
        self.resolve_collisions();
    }

    fn resolve_collisions(&mut self) {
        let n = self.dynamic.count;
        let ns = self.statics.count;

        // Circle-circle (dynamic vs dynamic)
        for i in 0..n {
            for j in (i + 1)..n {
                let dx = self.dynamic.x[j] - self.dynamic.x[i];
                let dy = self.dynamic.y[j] - self.dynamic.y[i];
                let dist_sq = dx * dx + dy * dy;
                let min_dist = self.dynamic.radius[i] + self.dynamic.radius[j];
                if dist_sq >= min_dist * min_dist || dist_sq == 0.0 {
                    continue;
                }

                let dist = dist_sq.sqrt();
                let overlap = min_dist - dist;
                let nx = dx / dist;
                let ny = dy / dist;

                let inv_a = self.dynamic.inv_mass[i];
                let inv_b = self.dynamic.inv_mass[j];
                let total_inv = inv_a + inv_b;
                if total_inv == 0.0 {
                    continue;
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
                    continue;
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

            // Circle-rect (dynamic vs static)
            for s in 0..ns {
                let hw = self.statics.half_w[s];
                let hh = self.statics.half_h[s];
                let rx = self.statics.x[s];
                let ry = self.statics.y[s];

                let ax = self.dynamic.x[i];
                let ay = self.dynamic.y[i];
                let ar = self.dynamic.radius[i];

                // Nearest point on AABB to circle center
                let clamped_x = ax.max(rx - hw).min(rx + hw);
                let clamped_y = ay.max(ry - hh).min(ry + hh);

                let dx = ax - clamped_x;
                let dy = ay - clamped_y;
                let dist_sq = dx * dx + dy * dy;

                if dist_sq >= ar * ar || dist_sq == 0.0 {
                    // Handle center-inside-rect edge case
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
                            if self.dynamic.vx[i] > 0.0 {
                                self.dynamic.vx[i] *= -rest;
                            }
                        } else if min_pen == right {
                            self.dynamic.x[i] = rx + hw + ar;
                            if self.dynamic.vx[i] < 0.0 {
                                self.dynamic.vx[i] *= -rest;
                            }
                        } else if min_pen == top {
                            self.dynamic.y[i] = ry - hh - ar;
                            if self.dynamic.vy[i] > 0.0 {
                                self.dynamic.vy[i] *= -rest;
                            }
                        } else {
                            self.dynamic.y[i] = ry + hh + ar;
                            if self.dynamic.vy[i] < 0.0 {
                                self.dynamic.vy[i] *= -rest;
                            }
                        }
                    }
                    continue;
                }

                let dist = dist_sq.sqrt();
                let overlap = ar - dist;
                let nx = dx / dist;
                let ny = dy / dist;

                // Push circle out
                self.dynamic.x[i] += nx * overlap;
                self.dynamic.y[i] += ny * overlap;

                // Reflect velocity
                let v_dot_n =
                    self.dynamic.vx[i] * nx + self.dynamic.vy[i] * ny;
                if v_dot_n < 0.0 {
                    let rest = self.statics.restitution[s];
                    self.dynamic.vx[i] -= (1.0 + rest) * v_dot_n * nx;
                    self.dynamic.vy[i] -= (1.0 + rest) * v_dot_n * ny;
                }
            }
        }
    }

    // -- Pointer accessors for zero-copy JS typed array views --

    pub fn dynamic_count(&self) -> u32 {
        self.dynamic.count as u32
    }

    pub fn dynamic_x_ptr(&self) -> *const f64 {
        self.dynamic.x.as_ptr()
    }

    pub fn dynamic_y_ptr(&self) -> *const f64 {
        self.dynamic.y.as_ptr()
    }

    pub fn dynamic_vx_ptr(&self) -> *const f64 {
        self.dynamic.vx.as_ptr()
    }

    pub fn dynamic_vy_ptr(&self) -> *const f64 {
        self.dynamic.vy.as_ptr()
    }

    // Read back a single body's position (by slot index)
    pub fn get_x(&self, slot: u32) -> f64 {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] {
            return 0.0;
        }
        self.dynamic.x[self.dynamic.slot_to_packed[s]]
    }

    pub fn get_y(&self, slot: u32) -> f64 {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] {
            return 0.0;
        }
        self.dynamic.y[self.dynamic.slot_to_packed[s]]
    }

    pub fn get_vx(&self, slot: u32) -> f64 {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] {
            return 0.0;
        }
        self.dynamic.vx[self.dynamic.slot_to_packed[s]]
    }

    pub fn get_vy(&self, slot: u32) -> f64 {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] {
            return 0.0;
        }
        self.dynamic.vy[self.dynamic.slot_to_packed[s]]
    }

    pub fn get_mass(&self, slot: u32) -> f64 {
        let s = slot as usize;
        if s >= self.dynamic.alive.len() || !self.dynamic.alive[s] {
            return 0.0;
        }
        self.dynamic.mass[self.dynamic.slot_to_packed[s]]
    }
}
