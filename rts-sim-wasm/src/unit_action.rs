use wasm_bindgen::prelude::*;

#[allow(unused_imports)]
use crate::*;

const ACTION_TYPE_MOVE: u8 = 0;
const ACTION_TYPE_PATROL: u8 = 1;
const ACTION_TYPE_FIGHT: u8 = 2;
const ACTION_TYPE_BUILD: u8 = 3;
const ACTION_TYPE_REPAIR: u8 = 4;
const ACTION_TYPE_ATTACK: u8 = 5;
const ACTION_TYPE_GUARD: u8 = 6;
const ACTION_TYPE_RECLAIM: u8 = 7;
const ACTION_TYPE_ATTACK_GROUND: u8 = 8;
const ACTION_TYPE_WAIT: u8 = 9;
const ACTION_TYPE_CAPTURE: u8 = 10;
const ACTION_TYPE_RESURRECT: u8 = 11;
const ACTION_TYPE_LOAD_TRANSPORT: u8 = 12;
const ACTION_TYPE_UNLOAD_TRANSPORT: u8 = 13;
const ACTION_TYPE_NONE: u8 = 255;

const UNIT_ACTION_FLAG_MOVE_STATE_ROAM: u32 = 1 << 0;
const UNIT_ACTION_FLAG_MOVE_STATE_HOLD: u32 = 1 << 1;
const UNIT_ACTION_FLAG_LOAD_IN_RANGE: u32 = 1 << 2;
const UNIT_ACTION_FLAG_TRANSPORT_EMPTY: u32 = 1 << 3;
const UNIT_ACTION_FLAG_TARGET_IN_BUILD_RANGE: u32 = 1 << 4;
const UNIT_ACTION_FLAG_COMBAT_STOP_ANY: u32 = 1 << 5;
const UNIT_ACTION_FLAG_COMBAT_STOP_FIGHT: u32 = 1 << 6;
const UNIT_ACTION_FLAG_GUARD_FRIENDLY: u32 = 1 << 7;
const UNIT_ACTION_FLAG_GUARD_SERVICE: u32 = 1 << 8;
const UNIT_ACTION_FLAG_GUARD_SERVICE_IN_RANGE: u32 = 1 << 9;
const UNIT_ACTION_FLAG_TARGET_PRESENT: u32 = 1 << 10;

const UNIT_ACTION_PLAN_IDLE_LOITER: u8 = 0;
const UNIT_ACTION_PLAN_WAIT_LOITER: u8 = 1;
const UNIT_ACTION_PLAN_LOAD_HOLD: u8 = 2;
const UNIT_ACTION_PLAN_LOAD_MOVE: u8 = 3;
const UNIT_ACTION_PLAN_UNLOAD_ADVANCE: u8 = 4;
const UNIT_ACTION_PLAN_UNLOAD_MOVE: u8 = 5;
const UNIT_ACTION_PLAN_BUILD_HOLD: u8 = 6;
const UNIT_ACTION_PLAN_BUILD_MOVE: u8 = 7;
const UNIT_ACTION_PLAN_ATTACK_HOLD: u8 = 8;
const UNIT_ACTION_PLAN_ATTACK_MOVE: u8 = 9;
const UNIT_ACTION_PLAN_ATTACK_GROUND_HOLD: u8 = 10;
const UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE: u8 = 11;
const UNIT_ACTION_PLAN_GUARD_ADVANCE: u8 = 12;
const UNIT_ACTION_PLAN_GUARD_HOLD: u8 = 13;
const UNIT_ACTION_PLAN_GUARD_SERVICE_HOLD: u8 = 14;
const UNIT_ACTION_PLAN_GUARD_SERVICE_MOVE: u8 = 15;
const UNIT_ACTION_PLAN_GUARD_FOLLOW: u8 = 16;
const UNIT_ACTION_PLAN_FIGHT_PATROL_HOLD: u8 = 17;
const UNIT_ACTION_PLAN_MOVE_COMPLETION: u8 = 18;

const UNIT_ACTION_MOVEMENT_DECISION_THRUST: u8 = 0;
const UNIT_ACTION_MOVEMENT_DECISION_ADVANCE_PATH: u8 = 1;
const UNIT_ACTION_MOVEMENT_DECISION_HOLD: u8 = 2;

#[inline]
fn has(flags: u32, bit: u32) -> bool {
    flags & bit != 0
}

#[inline]
fn is_build_like(action: u8) -> bool {
    action == ACTION_TYPE_BUILD
        || action == ACTION_TYPE_REPAIR
        || action == ACTION_TYPE_RECLAIM
        || action == ACTION_TYPE_CAPTURE
        || action == ACTION_TYPE_RESURRECT
}

#[inline]
fn movement_blocked_by_combat(flags: u32, fight_mode: bool) -> bool {
    if has(flags, UNIT_ACTION_FLAG_MOVE_STATE_ROAM) {
        return false;
    }
    if fight_mode {
        has(flags, UNIT_ACTION_FLAG_COMBAT_STOP_FIGHT)
    } else {
        has(flags, UNIT_ACTION_FLAG_COMBAT_STOP_ANY)
    }
}

#[inline]
fn movement_blocked_by_hold(flags: u32) -> bool {
    has(flags, UNIT_ACTION_FLAG_MOVE_STATE_HOLD)
}

#[wasm_bindgen]
pub fn unit_action_plan_batch(action_type: &[u8], flags: &[u32], out_plan: &mut [u8]) -> u32 {
    let count = action_type.len();
    if flags.len() < count || out_plan.len() < count {
        return 0;
    }

    for i in 0..count {
        let action = action_type[i];
        let f = flags[i];
        out_plan[i] = if action == ACTION_TYPE_NONE {
            UNIT_ACTION_PLAN_IDLE_LOITER
        } else if action == ACTION_TYPE_WAIT {
            UNIT_ACTION_PLAN_WAIT_LOITER
        } else if action == ACTION_TYPE_LOAD_TRANSPORT {
            if has(f, UNIT_ACTION_FLAG_LOAD_IN_RANGE) {
                UNIT_ACTION_PLAN_LOAD_HOLD
            } else {
                UNIT_ACTION_PLAN_LOAD_MOVE
            }
        } else if action == ACTION_TYPE_UNLOAD_TRANSPORT {
            if has(f, UNIT_ACTION_FLAG_TRANSPORT_EMPTY) {
                UNIT_ACTION_PLAN_UNLOAD_ADVANCE
            } else {
                UNIT_ACTION_PLAN_UNLOAD_MOVE
            }
        } else if is_build_like(action) {
            if has(f, UNIT_ACTION_FLAG_TARGET_IN_BUILD_RANGE) {
                UNIT_ACTION_PLAN_BUILD_HOLD
            } else {
                UNIT_ACTION_PLAN_BUILD_MOVE
            }
        } else if action == ACTION_TYPE_ATTACK {
            if !has(f, UNIT_ACTION_FLAG_TARGET_PRESENT) {
                UNIT_ACTION_PLAN_MOVE_COMPLETION
            } else if movement_blocked_by_combat(f, false) || movement_blocked_by_hold(f) {
                UNIT_ACTION_PLAN_ATTACK_HOLD
            } else {
                UNIT_ACTION_PLAN_ATTACK_MOVE
            }
        } else if action == ACTION_TYPE_ATTACK_GROUND {
            if movement_blocked_by_combat(f, false) || movement_blocked_by_hold(f) {
                UNIT_ACTION_PLAN_ATTACK_GROUND_HOLD
            } else {
                UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE
            }
        } else if action == ACTION_TYPE_GUARD {
            if !has(f, UNIT_ACTION_FLAG_TARGET_PRESENT) {
                UNIT_ACTION_PLAN_MOVE_COMPLETION
            } else if !has(f, UNIT_ACTION_FLAG_GUARD_FRIENDLY) {
                UNIT_ACTION_PLAN_GUARD_ADVANCE
            } else if movement_blocked_by_combat(f, false) || movement_blocked_by_hold(f) {
                UNIT_ACTION_PLAN_GUARD_HOLD
            } else if has(f, UNIT_ACTION_FLAG_GUARD_SERVICE) {
                if has(f, UNIT_ACTION_FLAG_GUARD_SERVICE_IN_RANGE) {
                    UNIT_ACTION_PLAN_GUARD_SERVICE_HOLD
                } else {
                    UNIT_ACTION_PLAN_GUARD_SERVICE_MOVE
                }
            } else {
                UNIT_ACTION_PLAN_GUARD_FOLLOW
            }
        } else if action == ACTION_TYPE_FIGHT || action == ACTION_TYPE_PATROL {
            if movement_blocked_by_combat(f, true) {
                UNIT_ACTION_PLAN_FIGHT_PATROL_HOLD
            } else {
                UNIT_ACTION_PLAN_MOVE_COMPLETION
            }
        } else if action == ACTION_TYPE_MOVE {
            UNIT_ACTION_PLAN_MOVE_COMPLETION
        } else {
            UNIT_ACTION_PLAN_MOVE_COMPLETION
        };
    }
    1
}

#[wasm_bindgen]
pub fn unit_action_movement_batch(
    slots: &[u32],
    target_x: &[f64],
    target_y: &[f64],
    threshold: &[f64],
    final_point: &[u8],
    out_dx: &mut [f64],
    out_dy: &mut [f64],
    out_distance: &mut [f64],
    out_decision: &mut [u8],
) -> u32 {
    let count = slots.len();
    if target_x.len() < count
        || target_y.len() < count
        || threshold.len() < count
        || final_point.len() < count
        || out_dx.len() < count
        || out_dy.len() < count
        || out_distance.len() < count
        || out_decision.len() < count
    {
        return 0;
    }

    let slab = entity_state();
    for i in 0..count {
        let slot = slots[i] as usize;
        if slot >= slab.pos_x.len() {
            out_dx[i] = 0.0;
            out_dy[i] = 0.0;
            out_distance[i] = 0.0;
            out_decision[i] = UNIT_ACTION_MOVEMENT_DECISION_HOLD;
            continue;
        }

        let dx = target_x[i] - slab.pos_x[slot];
        let dy = target_y[i] - slab.pos_y[slot];
        let distance = (dx * dx + dy * dy).sqrt();
        out_dx[i] = if dx.is_finite() { dx } else { 0.0 };
        out_dy[i] = if dy.is_finite() { dy } else { 0.0 };
        out_distance[i] = if distance.is_finite() { distance } else { 0.0 };

        let limit = threshold[i];
        if distance.is_finite() && limit.is_finite() && distance > limit {
            out_decision[i] = UNIT_ACTION_MOVEMENT_DECISION_THRUST;
        } else if final_point[i] == 0 {
            out_decision[i] = UNIT_ACTION_MOVEMENT_DECISION_ADVANCE_PATH;
        } else {
            out_decision[i] = UNIT_ACTION_MOVEMENT_DECISION_HOLD;
        }
    }
    1
}
