use super::*;

#[inline]
fn pathfinder_hierarchy_cluster_size(state: &PathfinderState) -> i32 {
    ((PATHFINDING_HIERARCHICAL_CLUSTER_SIZE_CELLS
        + state.consolidation_multiplier as i32
        - 1)
        / state.consolidation_multiplier as i32)
        .max(1)
}

pub(super) struct HierarchicalAStarResult {
    pub(super) route_cost: f32,
    pub(super) expanded_nodes: u32,
}

#[inline]
fn pathfinder_hierarchy_heap_precedes(state: &PathfinderState, left: u32, right: u32) -> bool {
    let left_idx = left as usize;
    let right_idx = right as usize;
    let left_f = state.hierarchy_f_score[left_idx];
    let right_f = state.hierarchy_f_score[right_idx];
    if left_f != right_f {
        return left_f < right_f;
    }
    let left_g = state.hierarchy_g_score[left_idx];
    let right_g = state.hierarchy_g_score[right_idx];
    if left_g != right_g {
        return left_g > right_g;
    }
    left < right
}

fn pathfinder_hierarchy_heap_push(state: &mut PathfinderState, idx: u32) {
    state.hierarchy_heap.push(idx);
    let mut i = state.hierarchy_heap.len() - 1;
    while i > 0 {
        let parent = (i - 1) >> 1;
        if pathfinder_hierarchy_heap_precedes(
            state,
            state.hierarchy_heap[i],
            state.hierarchy_heap[parent],
        ) {
            state.hierarchy_heap.swap(i, parent);
            i = parent;
        } else {
            break;
        }
    }
}

fn pathfinder_hierarchy_heap_pop(state: &mut PathfinderState) -> u32 {
    let top = state.hierarchy_heap[0];
    let last = state.hierarchy_heap.pop().unwrap();
    let len = state.hierarchy_heap.len();
    if len > 0 {
        state.hierarchy_heap[0] = last;
        let mut i = 0usize;
        loop {
            let left = (i << 1) + 1;
            let right = left + 1;
            let mut smallest = i;
            if left < len
                && pathfinder_hierarchy_heap_precedes(
                    state,
                    state.hierarchy_heap[left],
                    state.hierarchy_heap[smallest],
                )
            {
                smallest = left;
            }
            if right < len
                && pathfinder_hierarchy_heap_precedes(
                    state,
                    state.hierarchy_heap[right],
                    state.hierarchy_heap[smallest],
                )
            {
                smallest = right;
            }
            if smallest == i {
                break;
            }
            state.hierarchy_heap.swap(i, smallest);
            i = smallest;
        }
    }
    top
}

/// Resolve a cluster to a deterministic fine-grid representative. A cluster
/// whose geometric center is blocked uses the nearest passable fine cell in
/// that same cluster. This is intentionally query-local because clearance,
/// locomotion medium, slope capability, and building occupancy all affect
/// passability.
fn pathfinder_hierarchy_resolve_node_cell(
    state: &mut PathfinderState,
    node: u32,
    traversal: PathfinderTraversal,
) -> Option<i32> {
    let node_idx = node as usize;
    let cached = state.hierarchy_node_cell[node_idx];
    if cached != i32::MIN {
        return if cached >= 0 { Some(cached) } else { None };
    }

    let cluster_size = pathfinder_hierarchy_cluster_size(state);
    let cluster_x = node as i32 % state.hierarchy_grid_w;
    let cluster_y = node as i32 / state.hierarchy_grid_w;
    let min_gx = cluster_x * cluster_size;
    let min_gy = cluster_y * cluster_size;
    let max_gx = ((cluster_x + 1) * cluster_size).min(state.grid_w);
    let max_gy = ((cluster_y + 1) * cluster_size).min(state.grid_h);
    let center_gx = (min_gx + max_gx - 1) / 2;
    let center_gy = (min_gy + max_gy - 1) / 2;
    let center_cell = center_gy * state.grid_w + center_gx;
    if pathfinder_cached_cell_passable(state, center_cell as usize, traversal, false) {
        state.hierarchy_node_cell[node_idx] = center_cell;
        return Some(center_cell);
    }
    state.last_coarse_full_cluster_scans += 1;
    let mut best_cell = -1;
    let mut best_d2 = i32::MAX;
    for gy in min_gy..max_gy {
        for gx in min_gx..max_gx {
            let fine_idx = gy * state.grid_w + gx;
            if !pathfinder_cached_cell_passable(state, fine_idx as usize, traversal, false) {
                continue;
            }
            let dx = gx - center_gx;
            let dy = gy - center_gy;
            let d2 = dx * dx + dy * dy;
            if d2 < best_d2 || (d2 == best_d2 && fine_idx < best_cell) {
                best_cell = fine_idx;
                best_d2 = d2;
            }
        }
    }
    state.hierarchy_node_cell[node_idx] = best_cell;
    if best_cell >= 0 {
        Some(best_cell)
    } else {
        None
    }
}

#[inline]
fn pathfinder_hierarchy_node_position(
    state: &mut PathfinderState,
    node: u32,
    start_node: u32,
    goal_node: u32,
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
    traversal: PathfinderTraversal,
) -> Option<(f64, f64)> {
    if node == start_node {
        return Some((start_x, start_y));
    }
    if node == goal_node {
        return Some((goal_x, goal_y));
    }
    let fine_idx = pathfinder_hierarchy_resolve_node_cell(state, node, traversal)?;
    let gx = fine_idx % state.grid_w;
    let gy = (fine_idx - gx) / state.grid_w;
    Some(pathfinder_cell_center_for_state(state, gx, gy))
}

#[inline]
fn pathfinder_hierarchy_heuristic(
    state: &PathfinderState,
    x: f64,
    y: f64,
    goal_x: f64,
    goal_y: f64,
) -> f32 {
    let dx = x - goal_x;
    let dy = y - goal_y;
    ((dx * dx + dy * dy).sqrt() / state.cell_size) as f32
}

/// Find a deterministic fine-grid portal across the shared boundary of two
/// adjacent hierarchy chunks. Candidates are checked from the boundary center
/// outward so open terrain stays cheap while off-center passes through long
/// walls remain discoverable. Retaining the actual cells is essential: merely
/// knowing that a boundary has an opening and then refining center-to-center
/// can still draw the exact route through the blocked part of that boundary.
fn pathfinder_hierarchy_boundary_transition(
    state: &mut PathfinderState,
    from: u32,
    to: u32,
    traversal: PathfinderTraversal,
) -> Option<(i32, i32)> {
    let cluster_size = pathfinder_hierarchy_cluster_size(state);
    let from_cx = from as i32 % state.hierarchy_grid_w;
    let from_cy = from as i32 / state.hierarchy_grid_w;
    let to_cx = to as i32 % state.hierarchy_grid_w;
    let to_cy = to as i32 / state.hierarchy_grid_w;
    let dx = to_cx - from_cx;
    let dy = to_cy - from_cy;

    let from_min_x = from_cx * cluster_size;
    let from_min_y = from_cy * cluster_size;
    let from_max_x = ((from_cx + 1) * cluster_size).min(state.grid_w);
    let from_max_y = ((from_cy + 1) * cluster_size).min(state.grid_h);
    let to_min_x = to_cx * cluster_size;
    let to_min_y = to_cy * cluster_size;
    let to_max_x = ((to_cx + 1) * cluster_size).min(state.grid_w);
    let to_max_y = ((to_cy + 1) * cluster_size).min(state.grid_h);

    match (dx, dy) {
        (1, 0) | (-1, 0) => {
            let (from_gx, to_gx) = if dx > 0 {
                (from_max_x - 1, to_min_x)
            } else {
                (from_min_x, to_max_x - 1)
            };
            let min_gy = from_min_y.max(to_min_y);
            let max_gy = from_max_y.min(to_max_y);
            let center_gy = (min_gy + max_gy - 1) / 2;
            for offset in 0..(max_gy - min_gy) {
                let gy = if offset == 0 {
                    center_gy
                } else if offset & 1 == 1 {
                    center_gy - (offset + 1) / 2
                } else {
                    center_gy + offset / 2
                };
                if gy < min_gy || gy >= max_gy {
                    continue;
                }
                if pathfinder_can_step_neighbor_cached(state, from_gx, gy, to_gx, gy, traversal) {
                    return Some((gy * state.grid_w + from_gx, gy * state.grid_w + to_gx));
                }
            }
            None
        }
        (0, 1) | (0, -1) => {
            let (from_gy, to_gy) = if dy > 0 {
                (from_max_y - 1, to_min_y)
            } else {
                (from_min_y, to_max_y - 1)
            };
            let min_gx = from_min_x.max(to_min_x);
            let max_gx = from_max_x.min(to_max_x);
            let center_gx = (min_gx + max_gx - 1) / 2;
            for offset in 0..(max_gx - min_gx) {
                let gx = if offset == 0 {
                    center_gx
                } else if offset & 1 == 1 {
                    center_gx - (offset + 1) / 2
                } else {
                    center_gx + offset / 2
                };
                if gx < min_gx || gx >= max_gx {
                    continue;
                }
                if pathfinder_can_step_neighbor_cached(state, gx, from_gy, gx, to_gy, traversal) {
                    return Some((from_gy * state.grid_w + gx, to_gy * state.grid_w + gx));
                }
            }
            None
        }
        (1, 1) | (1, -1) | (-1, 1) | (-1, -1) => {
            let from_gx = if dx > 0 { from_max_x - 1 } else { from_min_x };
            let to_gx = if dx > 0 { to_min_x } else { to_max_x - 1 };
            let from_gy = if dy > 0 { from_max_y - 1 } else { from_min_y };
            let to_gy = if dy > 0 { to_min_y } else { to_max_y - 1 };
            if pathfinder_can_step_neighbor_cached(state, from_gx, from_gy, to_gx, to_gy, traversal)
            {
                Some((
                    from_gy * state.grid_w + from_gx,
                    to_gy * state.grid_w + to_gx,
                ))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn pathfinder_hierarchy_edge_cost(
    state: &mut PathfinderState,
    from: u32,
    to: u32,
    direction: usize,
    start_node: u32,
    goal_node: u32,
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
    traversal: PathfinderTraversal,
    _cost_profile: PathfinderCostProfile,
) -> Option<f32> {
    let slot = from as usize * 8 + direction;
    let cached = state.hierarchy_edge_cost[slot];
    if !cached.is_nan() {
        return if cached.is_finite() {
            Some(cached)
        } else {
            None
        };
    }
    let Some((portal_from, portal_to)) =
        pathfinder_hierarchy_boundary_transition(state, from, to, traversal)
    else {
        state.hierarchy_edge_cost[slot] = f32::INFINITY;
        return None;
    };
    state.hierarchy_edge_from_cell[slot] = portal_from;
    state.hierarchy_edge_to_cell[slot] = portal_to;
    let from_position = pathfinder_hierarchy_node_position(
        state, from, start_node, goal_node, start_x, start_y, goal_x, goal_y, traversal,
    );
    let to_position = pathfinder_hierarchy_node_position(
        state, to, start_node, goal_node, start_x, start_y, goal_x, goal_y, traversal,
    );
    let cost = match (from_position, to_position) {
        (Some((from_x, from_y)), Some((to_x, to_y))) => {
            Some(pathfinder_hierarchy_heuristic(state, from_x, from_y, to_x, to_y))
        }
        _ => None,
    };
    state.hierarchy_edge_cost[slot] = cost.unwrap_or(f32::INFINITY);
    cost
}

#[inline]
fn pathfinder_hierarchy_direction(state: &PathfinderState, from: u32, to: u32) -> Option<usize> {
    let from_x = from as i32 % state.hierarchy_grid_w;
    let from_y = from as i32 / state.hierarchy_grid_w;
    let to_x = to as i32 % state.hierarchy_grid_w;
    let to_y = to as i32 / state.hierarchy_grid_w;
    let dx = to_x - from_x;
    let dy = to_y - from_y;
    (0..8).find(|&direction| {
        PATHFINDER_NEIGHBOR_DX[direction] == dx && PATHFINDER_NEIGHBOR_DY[direction] == dy
    })
}

/// Refine one candidate abstract path through the concrete boundary portals
/// retained for its edges. Invalid approaches become blocked abstract edges
/// for this query so coarse A* can cheaply seek another route. A successful
/// result is already an exact, legal fine-grid chain suitable for smoothing.
fn pathfinder_hierarchy_refine_candidate(
    state: &mut PathfinderState,
    start_node: u32,
    goal_node: u32,
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> (Option<(f32, Vec<u32>)>, bool) {
    let mut total_cost = 0.0f32;
    let mut fine_path = Vec::with_capacity(state.hierarchy_path.len() * 2 + 1);
    let mut current_x = start_x;
    let mut current_y = start_y;
    let mut from = start_node;
    let mut last_slot = None;
    for path_index in 0..state.hierarchy_path.len() {
        let to = state.hierarchy_path[path_index];
        let Some(direction) = pathfinder_hierarchy_direction(state, from, to) else {
            return (None, false);
        };
        let slot = from as usize * 8 + direction;
        let portal_from = state.hierarchy_edge_from_cell[slot];
        let portal_to = state.hierarchy_edge_to_cell[slot];
        if portal_from < 0 || portal_to < 0 {
            state.hierarchy_edge_cost[slot] = f32::INFINITY;
            return (None, true);
        }

        let portal_from_gx = portal_from % state.grid_w;
        let portal_from_gy = portal_from / state.grid_w;
        let portal_to_gx = portal_to % state.grid_w;
        let portal_to_gy = portal_to / state.grid_w;
        let portal_from_position =
            pathfinder_cell_center_for_state(state, portal_from_gx, portal_from_gy);
        let portal_to_position =
            pathfinder_cell_center_for_state(state, portal_to_gx, portal_to_gy);

        state.last_coarse_exact_edge_checks += 1;
        let Some(approach_cost) = pathfinder_line_cost(
            state,
            current_x,
            current_y,
            portal_from_position.0,
            portal_from_position.1,
            traversal,
            cost_profile,
        ) else {
            state.hierarchy_edge_cost[slot] = f32::INFINITY;
            return (None, true);
        };
        state.last_coarse_exact_edge_checks += 1;
        let Some(crossing_cost) = pathfinder_line_cost(
            state,
            portal_from_position.0,
            portal_from_position.1,
            portal_to_position.0,
            portal_to_position.1,
            traversal,
            cost_profile,
        ) else {
            state.hierarchy_edge_cost[slot] = f32::INFINITY;
            return (None, true);
        };
        total_cost += approach_cost + crossing_cost;
        for portal in [portal_from as u32, portal_to as u32] {
            if fine_path.last().copied() != Some(portal) {
                fine_path.push(portal);
            }
        }
        current_x = portal_to_position.0;
        current_y = portal_to_position.1;
        last_slot = Some(slot);
        from = to;
    }
    debug_assert_eq!(from, goal_node);
    state.last_coarse_exact_edge_checks += 1;
    let Some(goal_cost) = pathfinder_line_cost(
        state,
        current_x,
        current_y,
        goal_x,
        goal_y,
        traversal,
        cost_profile,
    ) else {
        if let Some(slot) = last_slot {
            state.hierarchy_edge_cost[slot] = f32::INFINITY;
            return (None, true);
        }
        return (None, false);
    };
    total_cost += goal_cost;
    let goal_cell = state.hierarchy_node_cell[goal_node as usize];
    if goal_cell >= 0 && fine_path.last().copied() != Some(goal_cell as u32) {
        fine_path.push(goal_cell as u32);
    }
    (Some((total_cost, fine_path)), false)
}

/// Search a sparse level-1 graph for long routes. Coarse A* uses geometric
/// lower bounds and exact directed boundary connectivity, then refines a
/// candidate through those boundary portals. Returned routes are fully legal
/// even though unselected abstract edges stay cheap.
pub(super) fn pathfinder_hierarchical_a_star(
    state: &mut PathfinderState,
    start_gx: i32,
    start_gy: i32,
    goal_gx: i32,
    goal_gy: i32,
    start_x: f64,
    start_y: f64,
    goal_x: f64,
    goal_y: f64,
    traversal: PathfinderTraversal,
    cost_profile: PathfinderCostProfile,
) -> Option<HierarchicalAStarResult> {
    if pathfinder_octile(start_gx, start_gy, goal_gx, goal_gy)
        < PATHFINDING_HIERARCHICAL_MIN_DISTANCE_CELLS
    {
        return None;
    }
    let cluster_size = pathfinder_hierarchy_cluster_size(state);
    let hierarchy_grid_w = (state.grid_w + cluster_size - 1) / cluster_size;
    let hierarchy_grid_h = (state.grid_h + cluster_size - 1) / cluster_size;
    let node_count = (hierarchy_grid_w * hierarchy_grid_h) as usize;
    if node_count <= 1 {
        return None;
    }
    state.hierarchy_grid_w = hierarchy_grid_w;
    state.hierarchy_grid_h = hierarchy_grid_h;
    state.hierarchy_node_cell.clear();
    state.hierarchy_node_cell.resize(node_count, i32::MIN);
    state.hierarchy_g_score.clear();
    state.hierarchy_g_score.resize(node_count, f32::INFINITY);
    state.hierarchy_f_score.clear();
    state.hierarchy_f_score.resize(node_count, f32::INFINITY);
    state.hierarchy_parent.clear();
    state.hierarchy_parent.resize(node_count, -1);
    state.hierarchy_closed.clear();
    state.hierarchy_closed.resize(node_count, 0);
    state.hierarchy_edge_cost.clear();
    state.hierarchy_edge_cost.resize(node_count * 8, f32::NAN);
    state.hierarchy_edge_from_cell.clear();
    state.hierarchy_edge_from_cell.resize(node_count * 8, -1);
    state.hierarchy_edge_to_cell.clear();
    state.hierarchy_edge_to_cell.resize(node_count * 8, -1);
    state.hierarchy_heap.clear();
    state.hierarchy_path.clear();

    let start_cluster_x = start_gx / cluster_size;
    let start_cluster_y = start_gy / cluster_size;
    let goal_cluster_x = goal_gx / cluster_size;
    let goal_cluster_y = goal_gy / cluster_size;
    let start_node = (start_cluster_y * hierarchy_grid_w + start_cluster_x) as u32;
    let goal_node = (goal_cluster_y * hierarchy_grid_w + goal_cluster_x) as u32;
    if start_node == goal_node {
        return None;
    }
    state.hierarchy_node_cell[start_node as usize] = start_gy * state.grid_w + start_gx;
    state.hierarchy_node_cell[goal_node as usize] = goal_gy * state.grid_w + goal_gx;
    let mut total_expanded = 0u32;
    let mut best_cost = f32::INFINITY;
    let mut best_fine_path: Vec<u32> = Vec::new();
    for _ in 0..PATHFINDER_HIERARCHY_MAX_REFINEMENTS {
        state.last_coarse_refinement_passes += 1;
        state.hierarchy_g_score.fill(f32::INFINITY);
        state.hierarchy_f_score.fill(f32::INFINITY);
        state.hierarchy_parent.fill(-1);
        state.hierarchy_closed.fill(0);
        state.hierarchy_heap.clear();
        state.hierarchy_path.clear();
        state.hierarchy_g_score[start_node as usize] = 0.0;
        state.hierarchy_f_score[start_node as usize] =
            pathfinder_hierarchy_heuristic(state, start_x, start_y, goal_x, goal_y);
        pathfinder_hierarchy_heap_push(state, start_node);

        let mut expanded = 0u32;
        let mut found = false;
        while !state.hierarchy_heap.is_empty() {
            let current = pathfinder_hierarchy_heap_pop(state);
            let current_idx = current as usize;
            if state.hierarchy_closed[current_idx] != 0 {
                continue;
            }
            state.hierarchy_closed[current_idx] = 1;
            expanded += 1;
            if current == goal_node {
                found = true;
                break;
            }
            let current_x = current as i32 % hierarchy_grid_w;
            let current_y = current as i32 / hierarchy_grid_w;
            for direction in 0..8 {
                let next_x = current_x + PATHFINDER_NEIGHBOR_DX[direction];
                let next_y = current_y + PATHFINDER_NEIGHBOR_DY[direction];
                if next_x < 0
                    || next_y < 0
                    || next_x >= hierarchy_grid_w
                    || next_y >= hierarchy_grid_h
                {
                    continue;
                }
                let next = (next_y * hierarchy_grid_w + next_x) as u32;
                if state.hierarchy_closed[next as usize] != 0 {
                    continue;
                }
                let Some(edge_cost) = pathfinder_hierarchy_edge_cost(
                    state,
                    current,
                    next,
                    direction,
                    start_node,
                    goal_node,
                    start_x,
                    start_y,
                    goal_x,
                    goal_y,
                    traversal,
                    cost_profile,
                ) else {
                    continue;
                };
                let tentative = state.hierarchy_g_score[current_idx] + edge_cost;
                let next_idx = next as usize;
                if tentative >= state.hierarchy_g_score[next_idx] {
                    continue;
                }
                state.hierarchy_parent[next_idx] = current as i32;
                state.hierarchy_g_score[next_idx] = tentative;
                let Some((next_world_x, next_world_y)) = pathfinder_hierarchy_node_position(
                    state, next, start_node, goal_node, start_x, start_y, goal_x, goal_y, traversal,
                ) else {
                    continue;
                };
                state.hierarchy_f_score[next_idx] = tentative
                    + pathfinder_hierarchy_heuristic(
                        state,
                        next_world_x,
                        next_world_y,
                        goal_x,
                        goal_y,
                    );
                pathfinder_hierarchy_heap_push(state, next);
            }
        }
        total_expanded = total_expanded.saturating_add(expanded);
        if !found {
            break;
        }

        let mut walker = goal_node as i32;
        while walker != start_node as i32 && walker >= 0 {
            state.hierarchy_path.push(walker as u32);
            walker = state.hierarchy_parent[walker as usize];
        }
        if walker != start_node as i32 {
            break;
        }
        state.hierarchy_path.reverse();
        let (refined_cost, updated) = pathfinder_hierarchy_refine_candidate(
            state,
            start_node,
            goal_node,
            start_x,
            start_y,
            goal_x,
            goal_y,
            traversal,
            cost_profile,
        );
        if let Some((refined_cost, fine_path)) = refined_cost {
            if refined_cost < best_cost {
                best_cost = refined_cost;
                best_fine_path = fine_path;
            }
            if !updated {
                break;
            }
        }
    }
    state.last_coarse_expanded_nodes = total_expanded;
    if best_fine_path.is_empty() {
        return None;
    }
    state.path_scratch = best_fine_path;
    Some(HierarchicalAStarResult {
        route_cost: best_cost,
        expanded_nodes: total_expanded,
    })
}
