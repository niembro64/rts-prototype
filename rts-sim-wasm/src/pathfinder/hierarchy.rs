// Per-class hierarchical layer (HPA*) over the fine 20 wu grid.
//
// Why a hierarchy at all: the fine grid is the legality truth and stays that
// way, but an unbounded fine A* explodes on two things an RTS produces all
// the time — long routes, and goals that are NOT reachable (the old planner
// exhausted the whole component before it could say so). The abstract graph
// answers reachability in a few thousand cheap expansions and hands the fine
// search a CORRIDOR (the clusters along the abstract route) so it never
// touches the rest of the map.
//
// Why it cannot lose narrow corridors: entrances are derived from the same
// per-class passability the fine search uses (slope, medium, Euclidean
// clearance for THIS body), and every maximal open run along a cluster border
// gets its own entrance — a one-cell gap the body fits through is a node.
// Intra-cluster costs are exact fine Dijkstra results in the time model. The
// fine search still finds the actual route; the hierarchy only prunes.
//
// Why it is cheap enough to build online: clusters are built lazily, only
// when a query touches them, charged to the same tick budget as fine
// expansions, and persisted per (class, cluster). Building churn stamps only
// the clusters within the distance-transform clamp of the changed cells;
// stale clusters rebuild on their next touch.
//
// Everything here is deterministic: node ids are fixed by geometry, the heap
// tie-breaks on (f, g, id), and no HashMap is ever iterated.

use super::*;

pub(crate) const HPA_MAX_PAIRS_PER_BORDER: usize = 6;
pub(crate) const HPA_ENTRANCE_SPACING: i32 = 8;
pub(crate) const HPA_CLASS_CACHE_CAP: usize = 12;
/// Start/goal insertion stops after this many of the cluster's exits are
/// settled: the nearest exits are what a route uses, and the corridor search
/// refines the exact route anyway. Bounds insertion at a fraction of the
/// cluster instead of a full flood.
pub(crate) const HPA_INSERTION_EXIT_COUNT: usize = 4;
/// Cost of one settled cell inside an intra-cluster Dijkstra, in fine
/// expansion units — cluster builds are charged to the tick budget.
pub(crate) const HPA_BUILD_WORK_PER_SETTLED_CELL: u32 = 1;

#[inline]
pub(crate) fn hpa_cluster_size() -> i32 {
    PATHFINDING_HIERARCHICAL_CLUSTER_SIZE_CELLS.max(4)
}

/// Everything that makes two queries share a graph: the physical class.
#[derive(Clone, Copy, PartialEq)]
pub(crate) struct HpaClassKey {
    pub(crate) traversal: PathfinderTraversal,
    pub(crate) waypoint_traversal: PathfinderTraversal,
    pub(crate) cost_profile: PathfinderCostProfile,
    pub(crate) symmetric_slope: bool,
    pub(crate) unit_radius: f64,
    pub(crate) support_point_offset_z: f64,
}

#[derive(Clone, Copy)]
pub(crate) struct HpaPair {
    pub(crate) cell_a: u32,
    pub(crate) cell_b: u32,
    /// Directed crossing costs; INFINITY when that direction is illegal.
    pub(crate) cost_ab: f32,
    pub(crate) cost_ba: f32,
}

#[derive(Default)]
pub(crate) struct HpaBorder {
    pub(crate) built_stamp: u32,
    pub(crate) pairs: Vec<HpaPair>,
}

#[derive(Default)]
pub(crate) struct HpaCluster {
    pub(crate) built_stamp: u32,
    /// Abstract node ids whose cell lies in this cluster, canonical order.
    pub(crate) nodes: Vec<u32>,
    /// Directed exact costs between those nodes' cells, k×k row-major. Rows
    /// are computed LAZILY — only for nodes the abstract search expands —
    /// because all-pairs builds dominated the planner's cost (96% of work)
    /// while a route only ever leaves a cluster through a few of its nodes.
    pub(crate) intra: Vec<f32>,
    pub(crate) intra_row_built: Vec<bool>,
}

pub(crate) struct HpaClassGraph {
    pub(crate) key: HpaClassKey,
    pub(crate) borders: Vec<HpaBorder>,
    pub(crate) clusters: Vec<HpaCluster>,
    pub(crate) last_used: u32,
}

pub(crate) enum HpaSearchOutcome {
    /// Clusters along the abstract route, start cluster first, goal last.
    Reached { corridor: Vec<u32> },
    /// No abstract route. `reachable_clusters` holds every cluster the start
    /// can reach (by abstract node), for goal snapping.
    Unreachable,
    /// The tick budget ran out while building clusters / searching. Built
    /// clusters persist, so the next slice resumes cheaply.
    Budget,
}

#[inline]
pub(crate) fn hpa_cluster_of_cell(state: &PathfinderState, cell: u32) -> u32 {
    let c = hpa_cluster_size();
    let gx = (cell as i32) % state.grid_w;
    let gy = (cell as i32) / state.grid_w;
    ((gy / c) * state.hpa_cluster_w + gx / c) as u32
}

#[inline]
fn hpa_cluster_bounds(state: &PathfinderState, cluster: u32) -> (i32, i32, i32, i32) {
    let c = hpa_cluster_size();
    let cx = (cluster as i32) % state.hpa_cluster_w;
    let cy = (cluster as i32) / state.hpa_cluster_w;
    let x0 = cx * c;
    let y0 = cy * c;
    (x0, y0, (x0 + c).min(state.grid_w), (y0 + c).min(state.grid_h))
}

/// Node id layout: pair_global = border * MAX_PAIRS + k; node = pair*2+side.
#[inline]
fn hpa_node_pair(node: u32) -> (usize, usize, u32) {
    let pair_global = (node >> 1) as usize;
    (
        pair_global / HPA_MAX_PAIRS_PER_BORDER,
        pair_global % HPA_MAX_PAIRS_PER_BORDER,
        node & 1,
    )
}

#[inline]
fn hpa_node_cell(graph: &HpaClassGraph, node: u32) -> u32 {
    let (border, k, side) = hpa_node_pair(node);
    let pair = graph.borders[border].pairs[k];
    if side == 0 {
        pair.cell_a
    } else {
        pair.cell_b
    }
}

#[inline]
fn hpa_node_cluster(state: &PathfinderState, node: u32) -> u32 {
    let (border, _, side) = hpa_node_pair(node);
    let owner = (border / 2) as u32;
    if side == 0 {
        owner
    } else if border % 2 == 0 {
        owner + 1
    } else {
        owner + state.hpa_cluster_w as u32
    }
}

/// Initialise cluster geometry + dirty stamps for the current grid.
pub(crate) fn hpa_reset_layout(state: &mut PathfinderState) {
    let c = hpa_cluster_size();
    state.hpa_cluster_w = (state.grid_w + c - 1) / c;
    state.hpa_cluster_h = (state.grid_h + c - 1) / c;
    let count = (state.hpa_cluster_w * state.hpa_cluster_h).max(0) as usize;
    state.hpa_cluster_change_stamp.clear();
    state.hpa_cluster_change_stamp.resize(count, 1);
    state.hpa_stamp_counter = 1;
    state.hpa_classes.clear();
    state.hpa_class_use_counter = 0;
    let node_space = count * 2 * HPA_MAX_PAIRS_PER_BORDER * 2 + 2;
    state.hpa_g.clear();
    state.hpa_g.resize(node_space, f32::INFINITY);
    state.hpa_parent.clear();
    state.hpa_parent.resize(node_space, u32::MAX);
    state.hpa_gen.clear();
    state.hpa_gen.resize(node_space, 0);
    state.hpa_closed_gen.clear();
    state.hpa_closed_gen.resize(node_space, 0);
    state.hpa_cur_gen = 0;
    let cluster_cells = (c * c) as usize;
    state.cl_g.clear();
    state.cl_g.resize(cluster_cells, f32::INFINITY);
    state.cl_gen.clear();
    state.cl_gen.resize(cluster_cells, 0);
    state.cl_cur_gen = 0;
}

/// Stamp every cluster that a set of changed cells can influence: passability
/// changes propagate up to the distance-transform clamp, plus one cell so a
/// border owned by the neighbouring cluster is covered.
pub(crate) fn hpa_mark_dirty_cells(state: &mut PathfinderState, cells: &[u32]) {
    if cells.is_empty() || state.hpa_cluster_w <= 0 {
        return;
    }
    let c = hpa_cluster_size();
    let reach = EDT_CLAMP_CELLS + 1;
    state.hpa_stamp_counter = state.hpa_stamp_counter.wrapping_add(1);
    let stamp = state.hpa_stamp_counter;
    for &cell in cells {
        let cell = cell as i32;
        let gx = cell % state.grid_w;
        let gy = cell / state.grid_w;
        let cx0 = ((gx - reach).max(0)) / c;
        let cx1 = ((gx + reach).min(state.grid_w - 1)) / c;
        let cy0 = ((gy - reach).max(0)) / c;
        let cy1 = ((gy + reach).min(state.grid_h - 1)) / c;
        for cy in cy0..=cy1 {
            for cx in cx0..=cx1 {
                state.hpa_cluster_change_stamp[(cy * state.hpa_cluster_w + cx) as usize] = stamp;
            }
        }
    }
}

pub(crate) fn hpa_invalidate_all(state: &mut PathfinderState) {
    state.hpa_stamp_counter = state.hpa_stamp_counter.wrapping_add(1);
    let stamp = state.hpa_stamp_counter;
    for s in state.hpa_cluster_change_stamp.iter_mut() {
        *s = stamp;
    }
}

/// Find or create the graph for a class. Eviction is by least-recent use.
pub(crate) fn hpa_class_index(state: &mut PathfinderState, key: HpaClassKey) -> usize {
    state.hpa_class_use_counter = state.hpa_class_use_counter.wrapping_add(1);
    let use_stamp = state.hpa_class_use_counter;
    for (i, graph) in state.hpa_classes.iter_mut().enumerate() {
        if graph.key == key {
            graph.last_used = use_stamp;
            return i;
        }
    }
    // A new or replaced graph invalidates any cached insertion for its slot.
    state.hpa_insertion_key = None;
    let cluster_count = state.hpa_cluster_change_stamp.len();
    let mut graph = HpaClassGraph {
        key,
        borders: Vec::new(),
        clusters: Vec::new(),
        last_used: use_stamp,
    };
    graph.borders.resize_with(cluster_count * 2, HpaBorder::default);
    graph.clusters.resize_with(cluster_count, HpaCluster::default);
    if state.hpa_classes.len() >= HPA_CLASS_CACHE_CAP {
        let mut victim = 0usize;
        for (i, g) in state.hpa_classes.iter().enumerate() {
            if g.last_used < state.hpa_classes[victim].last_used {
                victim = i;
            }
        }
        state.hpa_classes[victim] = graph;
        return victim;
    }
    state.hpa_classes.push(graph);
    state.hpa_classes.len() - 1
}

#[inline]
fn hpa_border_stamp(state: &PathfinderState, border: usize) -> u32 {
    let owner = border / 2;
    let other = if border % 2 == 0 {
        owner + 1
    } else {
        owner + state.hpa_cluster_w as usize
    };
    let a = state.hpa_cluster_change_stamp[owner];
    let b = state
        .hpa_cluster_change_stamp
        .get(other)
        .copied()
        .unwrap_or(a);
    a.max(b)
}

/// Does this border exist (E border of the last column / S border of the last
/// row do not)?
#[inline]
fn hpa_border_exists(state: &PathfinderState, border: usize) -> bool {
    let owner = (border / 2) as i32;
    let cx = owner % state.hpa_cluster_w;
    let cy = owner / state.hpa_cluster_w;
    if border % 2 == 0 {
        cx + 1 < state.hpa_cluster_w
    } else {
        cy + 1 < state.hpa_cluster_h
    }
}

/// (Re)build the entrance pairs of one border if stale. Returns work charged.
fn hpa_ensure_border(state: &mut PathfinderState, class_idx: usize, border: usize) -> u32 {
    if !hpa_border_exists(state, border) {
        return 0;
    }
    let stamp = hpa_border_stamp(state, border);
    if state.hpa_classes[class_idx].borders[border].built_stamp == stamp {
        return 0;
    }
    let key = state.hpa_classes[class_idx].key;
    let owner = (border / 2) as u32;
    let (x0, y0, x1, y1) = hpa_cluster_bounds(state, owner);
    let east = border % 2 == 0;
    // Enumerate the shared edge: cell_a in the owner (its last column/row),
    // cell_b the adjacent cell in the neighbour.
    let len = if east { y1 - y0 } else { x1 - x0 };
    let mut legal: Vec<(u32, u32, f32, f32)> = Vec::with_capacity(len as usize);
    let mut work = 0u32;
    for i in 0..len {
        let (agx, agy, bgx, bgy) = if east {
            (x1 - 1, y0 + i, x1, y0 + i)
        } else {
            (x0 + i, y1 - 1, x0 + i, y1)
        };
        if bgx >= state.grid_w || bgy >= state.grid_h {
            legal.push((u32::MAX, u32::MAX, f32::INFINITY, f32::INFINITY));
            continue;
        }
        let a = (agy * state.grid_w + agx) as u32;
        let b = (bgy * state.grid_w + bgx) as u32;
        // Both cells must be standable for this class. A step OUT of an
        // impassable cell is legal (that is the escape/recovery rule), so
        // testing directions alone would turn every wall/ground pair along a
        // border into a one-way "entrance" and hide the real gap.
        if !pathfinder_cached_cell_passable(state, a as usize, key.traversal, false)
            || !pathfinder_cached_cell_passable(state, b as usize, key.traversal, false)
        {
            legal.push((u32::MAX, u32::MAX, f32::INFINITY, f32::INFINITY));
            continue;
        }
        let ab = pathfinder_neighbor_cost_uncached(
            state,
            agx,
            agy,
            bgx,
            bgy,
            key.traversal,
            key.cost_profile,
        )
        .unwrap_or(f32::INFINITY);
        let ba = pathfinder_neighbor_cost_uncached(
            state,
            bgx,
            bgy,
            agx,
            agy,
            key.traversal,
            key.cost_profile,
        )
        .unwrap_or(f32::INFINITY);
        work += 1;
        if ab.is_finite() || ba.is_finite() {
            legal.push((a, b, ab, ba));
        } else {
            legal.push((u32::MAX, u32::MAX, f32::INFINITY, f32::INFINITY));
        }
    }
    // One entrance per maximal open run; long runs get one every
    // HPA_ENTRANCE_SPACING cells centred on the run.
    let mut pairs: Vec<HpaPair> = Vec::new();
    let mut i = 0i32;
    while i < len && pairs.len() < HPA_MAX_PAIRS_PER_BORDER {
        if legal[i as usize].0 == u32::MAX {
            i += 1;
            continue;
        }
        let run_start = i;
        while i < len && legal[i as usize].0 != u32::MAX {
            i += 1;
        }
        let run_len = i - run_start;
        let picks = ((run_len + HPA_ENTRANCE_SPACING - 1) / HPA_ENTRANCE_SPACING).max(1);
        for p in 0..picks {
            if pairs.len() >= HPA_MAX_PAIRS_PER_BORDER {
                break;
            }
            // Evenly spread picks inside the run, centred.
            let offset = ((2 * p + 1) * run_len) / (2 * picks);
            let slot = legal[(run_start + offset) as usize];
            pairs.push(HpaPair {
                cell_a: slot.0,
                cell_b: slot.1,
                cost_ab: slot.2,
                cost_ba: slot.3,
            });
        }
    }
    let graph = &mut state.hpa_classes[class_idx];
    graph.borders[border].pairs = pairs;
    graph.borders[border].built_stamp = stamp;
    // A border rebuild changes the node set of both clusters it separates.
    graph.clusters[owner as usize].built_stamp = 0;
    let other = if east {
        owner as usize + 1
    } else {
        owner as usize + state.hpa_cluster_w as usize
    };
    if other < graph.clusters.len() {
        graph.clusters[other].built_stamp = 0;
    }
    work
}

/// Border ids around a cluster: (E own, S own, W = left neighbour's E,
/// N = top neighbour's S), `usize::MAX` where absent.
pub(crate) fn hpa_cluster_borders(state: &PathfinderState, cluster: u32) -> [usize; 4] {
    let cw = state.hpa_cluster_w as usize;
    let c = cluster as usize;
    let cx = c % cw;
    let cy = c / cw;
    let e = if hpa_border_exists(state, c * 2) { c * 2 } else { usize::MAX };
    let s = if hpa_border_exists(state, c * 2 + 1) { c * 2 + 1 } else { usize::MAX };
    let w = if cx > 0 { (c - 1) * 2 } else { usize::MAX };
    let n = if cy > 0 { (c - cw) * 2 + 1 } else { usize::MAX };
    [e, s, w, n]
}

/// Ensure the cluster's node list and intra-cluster cost matrix are current.
/// Returns the work charged (border scans + settled Dijkstra cells).
pub(crate) fn hpa_ensure_cluster(state: &mut PathfinderState, class_idx: usize, cluster: u32) -> u32 {
    let stamp = state.hpa_cluster_change_stamp[cluster as usize];
    let borders = hpa_cluster_borders(state, cluster);
    let mut work = 0u32;
    for &b in &borders {
        if b != usize::MAX {
            work += hpa_ensure_border(state, class_idx, b);
        }
    }
    if state.hpa_classes[class_idx].clusters[cluster as usize].built_stamp == stamp {
        return work;
    }
    // Collect nodes: own E/S pairs contribute side 0, W/N (owned by the
    // neighbours) contribute side 1.
    let mut nodes: Vec<u32> = Vec::new();
    {
        let graph = &state.hpa_classes[class_idx];
        for (slot, &b) in borders.iter().enumerate() {
            if b == usize::MAX {
                continue;
            }
            let side = if slot < 2 { 0 } else { 1 };
            for k in 0..graph.borders[b].pairs.len() {
                let pair_global = (b * HPA_MAX_PAIRS_PER_BORDER + k) as u32;
                nodes.push(pair_global * 2 + side);
            }
        }
    }
    let k = nodes.len();
    let graph = &mut state.hpa_classes[class_idx];
    graph.clusters[cluster as usize].nodes = nodes;
    graph.clusters[cluster as usize].intra = vec![f32::INFINITY; k * k];
    graph.clusters[cluster as usize].intra_row_built = vec![false; k];
    graph.clusters[cluster as usize].built_stamp = stamp;
    work
}

/// Compute one node's row of exact intra-cluster costs on first use.
fn hpa_ensure_intra_row(
    state: &mut PathfinderState,
    class_idx: usize,
    cluster: u32,
    slot: usize,
) -> u32 {
    if state.hpa_classes[class_idx].clusters[cluster as usize].intra_row_built[slot] {
        return 0;
    }
    let (cells, k, key) = {
        let graph = &state.hpa_classes[class_idx];
        let cl = &graph.clusters[cluster as usize];
        let cells: Vec<u32> = cl.nodes.iter().map(|&n| hpa_node_cell(graph, n)).collect();
        (cells, cl.nodes.len(), graph.key)
    };
    let mut costs: Vec<f32> = Vec::new();
    let work = hpa_intra_dijkstra(state, cluster, cells[slot], &cells, false, key, &mut costs);
    let cl = &mut state.hpa_classes[class_idx].clusters[cluster as usize];
    for j in 0..k {
        cl.intra[slot * k + j] = if j == slot { 0.0 } else { costs[j] };
    }
    cl.intra_row_built[slot] = true;
    work
}

#[inline]
fn hpa_cl_touch(state: &mut PathfinderState, local: usize) {
    if state.cl_gen[local] != state.cl_cur_gen {
        state.cl_gen[local] = state.cl_cur_gen;
        state.cl_g[local] = f32::INFINITY;
    }
}

/// Dijkstra restricted to one cluster from `source` to every cell in
/// `targets` (cost written to `out`, INFINITY if unreachable inside the
/// cluster). `reverse` searches over reversed edges so the result is the cost
/// FROM each target TO the source. Returns settled-cell work. Heat is never
/// priced here: intra costs are cached across ticks.
pub(crate) fn hpa_intra_dijkstra(
    state: &mut PathfinderState,
    cluster: u32,
    source: u32,
    targets: &[u32],
    reverse: bool,
    key: HpaClassKey,
    out: &mut Vec<f32>,
) -> u32 {
    hpa_intra_dijkstra_limited(state, cluster, source, targets, reverse, key, out, usize::MAX)
}

/// As above, but may stop once `settle_limit` targets have been settled (the
/// remaining targets keep INFINITY). `usize::MAX` = settle every target.
#[allow(clippy::too_many_arguments)]
pub(crate) fn hpa_intra_dijkstra_limited(
    state: &mut PathfinderState,
    cluster: u32,
    source: u32,
    targets: &[u32],
    reverse: bool,
    key: HpaClassKey,
    out: &mut Vec<f32>,
    settle_limit: usize,
) -> u32 {
    let c = hpa_cluster_size();
    let (x0, y0, x1, y1) = hpa_cluster_bounds(state, cluster);
    out.clear();
    out.resize(targets.len(), f32::INFINITY);
    state.cl_cur_gen = state.cl_cur_gen.wrapping_add(1);
    if state.cl_cur_gen == 0 {
        for g in state.cl_gen.iter_mut() {
            *g = 0;
        }
        state.cl_cur_gen = 1;
    }
    let local_of = |cell: u32| -> usize {
        let gx = (cell as i32) % state.grid_w;
        let gy = (cell as i32) / state.grid_w;
        ((gy - y0) * c + (gx - x0)) as usize
    };
    let heat_was = state.cur_heat_enabled;
    state.cur_heat_enabled = false;
    let src_local = local_of(source);
    hpa_cl_touch(state, src_local);
    state.cl_g[src_local] = 0.0;
    // Small deterministic binary heap of (cost, local).
    state.cl_heap.clear();
    cl_heap_push(&mut state.cl_heap, (0.0, src_local as u32));
    // No targets = full flood of the cluster (reach set); otherwise stop as
    // soon as every target is settled.
    let full_flood = targets.is_empty();
    let mut remaining = 0usize;
    for &t in targets {
        if t != source {
            remaining += 1;
        }
    }
    let mut remaining = remaining.min(settle_limit);
    let mut settled = 0u32;
    while let Some((cost, local)) = cl_heap_pop(&mut state.cl_heap) {
        let local = local as usize;
        if cost > state.cl_g[local] {
            continue;
        }
        settled += 1;
        let lx = (local as i32) % c;
        let ly = (local as i32) / c;
        let gx = x0 + lx;
        let gy = y0 + ly;
        let cell = (gy * state.grid_w + gx) as u32;
        for (ti, &t) in targets.iter().enumerate() {
            if t == cell && out[ti].is_infinite() {
                out[ti] = cost;
                if t != source {
                    remaining -= 1;
                }
            }
        }
        if !full_flood && remaining == 0 {
            break;
        }
        let neighbor_count = if PATHFINDING_ALLOW_DIAGONAL_NEIGHBORS { 8 } else { 4 };
        for k in 0..neighbor_count {
            let nx = gx + PATHFINDER_NEIGHBOR_DX[k];
            let ny = gy + PATHFINDER_NEIGHBOR_DY[k];
            if nx < x0 || ny < y0 || nx >= x1 || ny >= y1 {
                continue;
            }
            let step = if reverse {
                pathfinder_neighbor_cost_uncached(state, nx, ny, gx, gy, key.traversal, key.cost_profile)
            } else {
                pathfinder_neighbor_cost_uncached(state, gx, gy, nx, ny, key.traversal, key.cost_profile)
            };
            let Some(step) = step else { continue };
            let nlocal = ((ny - y0) * c + (nx - x0)) as usize;
            hpa_cl_touch(state, nlocal);
            let tentative = cost + step;
            if tentative < state.cl_g[nlocal] {
                state.cl_g[nlocal] = tentative;
                cl_heap_push(&mut state.cl_heap, (tentative, nlocal as u32));
            }
        }
    }
    state.cur_heat_enabled = heat_was;
    settled * HPA_BUILD_WORK_PER_SETTLED_CELL
}

#[inline]
fn cl_heap_less(a: (f32, u32), b: (f32, u32)) -> bool {
    if a.0 != b.0 {
        a.0 < b.0
    } else {
        a.1 < b.1
    }
}

fn cl_heap_push(heap: &mut Vec<(f32, u32)>, item: (f32, u32)) {
    heap.push(item);
    let mut i = heap.len() - 1;
    while i > 0 {
        let p = (i - 1) >> 1;
        if cl_heap_less(heap[i], heap[p]) {
            heap.swap(i, p);
            i = p;
        } else {
            break;
        }
    }
}

fn cl_heap_pop(heap: &mut Vec<(f32, u32)>) -> Option<(f32, u32)> {
    if heap.is_empty() {
        return None;
    }
    let top = heap[0];
    let last = heap.pop().unwrap();
    let len = heap.len();
    if len > 0 {
        heap[0] = last;
        let mut i = 0usize;
        loop {
            let l = (i << 1) + 1;
            let r = l + 1;
            let mut s = i;
            if l < len && cl_heap_less(heap[l], heap[s]) {
                s = l;
            }
            if r < len && cl_heap_less(heap[r], heap[s]) {
                s = r;
            }
            if s == i {
                break;
            }
            heap.swap(i, s);
            i = s;
        }
    }
    Some(top)
}

// ---- abstract search -------------------------------------------------------

#[inline]
fn hpa_touch(state: &mut PathfinderState, node: usize) {
    if state.hpa_gen[node] != state.hpa_cur_gen {
        state.hpa_gen[node] = state.hpa_cur_gen;
        state.hpa_g[node] = f32::INFINITY;
        state.hpa_parent[node] = u32::MAX;
        state.hpa_closed_gen[node] = 0;
    }
}

#[inline]
fn hpa_heap_less(state: &PathfinderState, a: (f32, u32), b: (f32, u32)) -> bool {
    if a.0 != b.0 {
        return a.0 < b.0;
    }
    let ga = state.hpa_g[a.1 as usize];
    let gb = state.hpa_g[b.1 as usize];
    if ga != gb {
        return ga > gb;
    }
    a.1 < b.1
}

fn hpa_heap_push(state: &mut PathfinderState, item: (f32, u32)) {
    state.hpa_heap.push(item);
    let mut i = state.hpa_heap.len() - 1;
    while i > 0 {
        let p = (i - 1) >> 1;
        if hpa_heap_less(state, state.hpa_heap[i], state.hpa_heap[p]) {
            state.hpa_heap.swap(i, p);
            i = p;
        } else {
            break;
        }
    }
}

fn hpa_heap_pop(state: &mut PathfinderState) -> Option<(f32, u32)> {
    if state.hpa_heap.is_empty() {
        return None;
    }
    let top = state.hpa_heap[0];
    let last = state.hpa_heap.pop().unwrap();
    let len = state.hpa_heap.len();
    if len > 0 {
        state.hpa_heap[0] = last;
        let mut i = 0usize;
        loop {
            let l = (i << 1) + 1;
            let r = l + 1;
            let mut s = i;
            if l < len && hpa_heap_less(state, state.hpa_heap[l], state.hpa_heap[s]) {
                s = l;
            }
            if r < len && hpa_heap_less(state, state.hpa_heap[r], state.hpa_heap[s]) {
                s = r;
            }
            if s == i {
                break;
            }
            state.hpa_heap.swap(i, s);
            i = s;
        }
    }
    Some(top)
}

#[inline]
fn hpa_cell_octile(state: &PathfinderState, a: u32, b: u32) -> f32 {
    let ax = (a as i32) % state.grid_w;
    let ay = (a as i32) / state.grid_w;
    let bx = (b as i32) % state.grid_w;
    let by = (b as i32) / state.grid_w;
    pathfinder_octile(ax, ay, bx, by)
}

/// Abstract A* from `start_cell` to `goal_cell` for one class. Clusters are
/// built on demand; all work is accumulated into `state.hpa_work` and the
/// search yields `Budget` once that exceeds `budget`. On success the corridor
/// (ordered cluster ids) is returned; the fine search then runs inside it.
pub(crate) fn hpa_search(
    state: &mut PathfinderState,
    class_idx: usize,
    start_cell: u32,
    goal_cell: u32,
    budget: u32,
) -> HpaSearchOutcome {
    let start_cluster = hpa_cluster_of_cell(state, start_cell);
    let goal_cluster = hpa_cluster_of_cell(state, goal_cell);
    let key = state.hpa_classes[class_idx].key;
    state.hpa_work += hpa_ensure_cluster(state, class_idx, start_cluster);
    if start_cluster != goal_cluster {
        if hpa_cluster_needs_build(state, class_idx, goal_cluster) && state.hpa_work > budget {
            return HpaSearchOutcome::Budget;
        }
        state.hpa_work += hpa_ensure_cluster(state, class_idx, goal_cluster);
    }
    // Start insertion: exact costs from the start cell to its cluster's nodes
    // (and straight to the goal when they share a cluster). The same query
    // re-entering after a Budget slice reuses the previous insertion.
    let insertion_key = (class_idx as u32, start_cell, goal_cell, state.hpa_stamp_counter);
    let same_cluster = start_cluster == goal_cluster;
    let cached = state.hpa_insertion_key == Some(insertion_key);
    let start_nodes: Vec<u32> = state.hpa_classes[class_idx].clusters[start_cluster as usize]
        .nodes
        .clone();
    let mut start_targets: Vec<u32> = start_nodes
        .iter()
        .map(|&n| hpa_node_cell(&state.hpa_classes[class_idx], n))
        .collect();
    if same_cluster {
        start_targets.push(goal_cell);
    }
    let mut start_costs: Vec<f32> = Vec::new();
    if cached {
        start_costs = state.hpa_insertion_start_costs.clone();
    } else {
        // The goal (same cluster) must always be settled if reachable: it is
        // appended last, so give it its own slot beyond the exit limit.
        let limit = HPA_INSERTION_EXIT_COUNT + usize::from(same_cluster);
        state.hpa_work += hpa_intra_dijkstra_limited(
            state,
            start_cluster,
            start_cell,
            &start_targets,
            false,
            key,
            &mut start_costs,
            limit,
        );
    }
    if same_cluster && start_costs.last().is_some_and(|c| c.is_finite()) {
        let direct = *start_costs.last().unwrap();
        // The in-cluster route may still be worse than one leaving and
        // re-entering; only skip the abstract search when no node is
        // reachable at all (pure pocket) or the direct cost beats every exit.
        let best_exit = start_costs[..start_costs.len() - 1]
            .iter()
            .copied()
            .fold(f32::INFINITY, f32::min);
        if !best_exit.is_finite() || direct <= best_exit {
            let _ = direct;
            return HpaSearchOutcome::Reached {
                corridor: vec![start_cluster],
            };
        }
    }
    // Goal insertion: reverse costs from the goal cluster's nodes to the goal.
    let goal_nodes: Vec<u32> = state.hpa_classes[class_idx].clusters[goal_cluster as usize]
        .nodes
        .clone();
    let goal_targets: Vec<u32> = goal_nodes
        .iter()
        .map(|&n| hpa_node_cell(&state.hpa_classes[class_idx], n))
        .collect();
    let mut goal_costs: Vec<f32> = Vec::new();
    if cached {
        goal_costs = state.hpa_insertion_goal_costs.clone();
    } else {
        state.hpa_work += hpa_intra_dijkstra_limited(
            state,
            goal_cluster,
            goal_cell,
            &goal_targets,
            true,
            key,
            &mut goal_costs,
            HPA_INSERTION_EXIT_COUNT,
        );
        state.hpa_insertion_key = Some(insertion_key);
        state.hpa_insertion_start_costs = start_costs.clone();
        state.hpa_insertion_goal_costs = goal_costs.clone();
    }

    let node_space = state.hpa_g.len();
    let goal_virtual = (node_space - 1) as u32;
    state.hpa_cur_gen = state.hpa_cur_gen.wrapping_add(1);
    if state.hpa_cur_gen == 0 {
        for g in state.hpa_gen.iter_mut() {
            *g = 0;
        }
        state.hpa_cur_gen = 1;
    }
    state.hpa_heap.clear();
    hpa_touch(state, goal_virtual as usize);
    for (i, &node) in start_nodes.iter().enumerate() {
        let cost = start_costs[i];
        if !cost.is_finite() {
            continue;
        }
        hpa_touch(state, node as usize);
        state.hpa_g[node as usize] = cost;
        state.hpa_parent[node as usize] = u32::MAX;
        let h = hpa_cell_octile(state, start_targets[i], goal_cell);
        hpa_heap_push(state, (cost + h, node));
    }
    if same_cluster {
        if let Some(&direct) = start_costs.last() {
            if direct.is_finite() {
                state.hpa_g[goal_virtual as usize] = direct;
                hpa_heap_push(state, (direct, goal_virtual));
            }
        }
    }
    let mut expanded = 0u32;
    let mut reached = false;
    while let Some((_, node)) = hpa_heap_pop(state) {
        let n = node as usize;
        if state.hpa_closed_gen[n] == state.hpa_cur_gen {
            continue;
        }
        state.hpa_closed_gen[n] = state.hpa_cur_gen;
        expanded += 1;
        // Abstract expansions are cheap (a few adds); charge them lightly so
        // a search over already-built clusters always completes in one slice.
        // The budget is only enforced before a cluster BUILD, which is the
        // expensive, persisted step — progress is never lost on Budget.
        if expanded % 16 == 0 {
            state.hpa_work += 1;
        }
        if node == goal_virtual {
            reached = true;
            break;
        }
        let cluster = hpa_node_cluster(state, node);
        if hpa_cluster_needs_build(state, class_idx, cluster) && state.hpa_work > budget {
            state.last_coarse_expanded_nodes = expanded;
            return HpaSearchOutcome::Budget;
        }
        state.hpa_work += hpa_ensure_cluster(state, class_idx, cluster);
        let g_here = state.hpa_g[n];
        // Intra edges (this node's cost row is computed on first expansion).
        // A row build is the expensive step of the whole search; like a
        // cluster build it is gated by the slice budget. Everything built so
        // far persists, so the next slice re-runs the cheap abstract
        // expansion over finished rows and builds the next one — an
        // exhaustive "unreachable" search spreads over as many ticks as it
        // needs instead of freezing one.
        let (slot, k) = {
            let cl = &state.hpa_classes[class_idx].clusters[cluster as usize];
            let slot = cl.nodes.iter().position(|&x| x == node);
            (slot, cl.nodes.len())
        };
        if let Some(slot) = slot {
            if !state.hpa_classes[class_idx].clusters[cluster as usize].intra_row_built[slot]
                && state.hpa_work > budget
            {
                state.last_coarse_expanded_nodes = expanded;
                return HpaSearchOutcome::Budget;
            }
            state.hpa_work += hpa_ensure_intra_row(state, class_idx, cluster, slot);
            for j in 0..k {
                let (other, cost) = {
                    let cl = &state.hpa_classes[class_idx].clusters[cluster as usize];
                    (cl.nodes[j], cl.intra[slot * k + j])
                };
                if j == slot || !cost.is_finite() {
                    continue;
                }
                let tentative = g_here + cost;
                hpa_touch(state, other as usize);
                if tentative < state.hpa_g[other as usize] {
                    state.hpa_g[other as usize] = tentative;
                    state.hpa_parent[other as usize] = node;
                    let other_cell = hpa_node_cell(&state.hpa_classes[class_idx], other);
                    let h = hpa_cell_octile(state, other_cell, goal_cell);
                    hpa_heap_push(state, (tentative + h, other));
                }
            }
            // Goal edge.
            if cluster == goal_cluster {
                let gi = goal_nodes.iter().position(|&x| x == node);
                if let Some(gi) = gi {
                    let cost = goal_costs[gi];
                    if cost.is_finite() {
                        let tentative = g_here + cost;
                        if tentative < state.hpa_g[goal_virtual as usize] {
                            state.hpa_g[goal_virtual as usize] = tentative;
                            state.hpa_parent[goal_virtual as usize] = node;
                            hpa_heap_push(state, (tentative, goal_virtual));
                        }
                    }
                }
            }
        }
        // Inter edge to the twin cell across the border.
        let (border, kk, side) = hpa_node_pair(node);
        let pair = state.hpa_classes[class_idx].borders[border].pairs[kk];
        let (twin, cross) = if side == 0 {
            (node + 1, pair.cost_ab)
        } else {
            (node - 1, pair.cost_ba)
        };
        if cross.is_finite() {
            let tentative = g_here + cross;
            hpa_touch(state, twin as usize);
            if tentative < state.hpa_g[twin as usize] {
                state.hpa_g[twin as usize] = tentative;
                state.hpa_parent[twin as usize] = node;
                let twin_cell = if side == 0 { pair.cell_b } else { pair.cell_a };
                let h = hpa_cell_octile(state, twin_cell, goal_cell);
                hpa_heap_push(state, (tentative + h, twin));
            }
        }
    }
    state.last_coarse_expanded_nodes = expanded;
    if !reached {
        state.hpa_work += hpa_flood_start_cluster(state, start_cluster, start_cell, key);
        return HpaSearchOutcome::Unreachable;
    }
    // Corridor: clusters of the nodes along the path, goal cluster last.
    let mut rev: Vec<u32> = vec![goal_cluster];
    let mut walker = state.hpa_parent[goal_virtual as usize];
    while walker != u32::MAX {
        let cl = hpa_node_cluster(state, walker);
        if *rev.last().unwrap() != cl {
            rev.push(cl);
        }
        walker = state.hpa_parent[walker as usize];
    }
    if *rev.last().unwrap() != start_cluster {
        rev.push(start_cluster);
    }
    rev.reverse();
    HpaSearchOutcome::Reached { corridor: rev }
}

#[inline]
fn hpa_cluster_needs_build(state: &PathfinderState, class_idx: usize, cluster: u32) -> bool {
    let stamp = state.hpa_cluster_change_stamp[cluster as usize];
    state.hpa_classes[class_idx].clusters[cluster as usize].built_stamp != stamp
}

/// Flood the start cluster from the start cell (no targets, full reach) into
/// `hpa_start_reach`, so an unreachable goal can snap to the nearest cell the
/// body can actually get to — including inside a closed pocket.
fn hpa_flood_start_cluster(
    state: &mut PathfinderState,
    cluster: u32,
    start_cell: u32,
    key: HpaClassKey,
) -> u32 {
    let c = hpa_cluster_size();
    let cells = (c * c) as usize;
    let mut costs = Vec::new();
    let work = hpa_intra_dijkstra(state, cluster, start_cell, &[], false, key, &mut costs);
    state.hpa_start_reach.clear();
    state.hpa_start_reach.resize(cells, f32::INFINITY);
    for local in 0..cells {
        if state.cl_gen[local] == state.cl_cur_gen {
            state.hpa_start_reach[local] = state.cl_g[local];
        }
    }
    state.hpa_start_reach_cluster = cluster;
    work
}

/// After an unreachable abstract search: is this cluster reachable from the
/// start (holds a closed node of the last search)? Only valid immediately
/// after `hpa_search` returned `Unreachable`.
pub(crate) fn hpa_cluster_reached_in_last_search(
    state: &PathfinderState,
    class_idx: usize,
    cluster: u32,
) -> bool {
    let cl = &state.hpa_classes[class_idx].clusters[cluster as usize];
    cl.nodes
        .iter()
        .any(|&n| state.hpa_closed_gen[n as usize] == state.hpa_cur_gen)
}

#[inline]
fn hpa_cell_reachable_after_failed_search(
    state: &PathfinderState,
    class_idx: usize,
    cell: u32,
) -> bool {
    let cluster = hpa_cluster_of_cell(state, cell);
    if cluster == state.hpa_start_reach_cluster {
        let c = hpa_cluster_size();
        let (x0, y0, _, _) = hpa_cluster_bounds(state, cluster);
        let gx = (cell as i32) % state.grid_w;
        let gy = (cell as i32) / state.grid_w;
        let local = ((gy - y0) * c + (gx - x0)) as usize;
        return state
            .hpa_start_reach
            .get(local)
            .is_some_and(|g| g.is_finite());
    }
    hpa_cluster_reached_in_last_search(state, class_idx, cluster)
}

/// Nearest waypoint-passable cell to (gx, gy) the start can reach, after an
/// unreachable abstract search: first the snap disc (exact-ish, cheap), then
/// every reached cluster's nearest passable cell (BAR: move as close as
/// possible, however far the wall is).
/// Returns the nearest reachable cell and the work it cost (cells examined),
/// so the caller can charge the scan to the slice budget like every other
/// piece of search work — an unreachable goal on a big map used to walk a
/// large fraction of the grid here for free.
pub(crate) fn hpa_nearest_reachable_cell(
    state: &PathfinderState,
    class_idx: usize,
    gx: i32,
    gy: i32,
    traversal: PathfinderTraversal,
) -> (Option<(i32, i32)>, u32) {
    let mut work: u32 = 0;
    for &(dx, dy) in std::iter::once(&(0i16, 0i16)).chain(state.snap_offsets.iter()) {
        let nx = gx + dx as i32;
        let ny = gy + dy as i32;
        if nx < 0 || ny < 0 || nx >= state.grid_w || ny >= state.grid_h {
            continue;
        }
        work += 1;
        let idx = (ny * state.grid_w + nx) as usize;
        if !pathfinder_is_cell_passable(state, idx, traversal) {
            continue;
        }
        if hpa_cell_reachable_after_failed_search(state, class_idx, idx as u32) {
            return (Some((nx, ny)), work);
        }
    }
    // Reached clusters in ascending order of their nearest-corner distance
    // to the goal; the first cluster whose bound cannot beat the best found
    // ends the scan, so this touches one or two clusters in practice
    // instead of every reached cluster on the map.
    let mut best: Option<(i32, i32, i64)> = None;
    let cluster_count = state.hpa_cluster_change_stamp.len() as u32;
    let mut candidates: Vec<(i64, u32)> = Vec::new();
    for cluster in 0..cluster_count {
        work += 1;
        let reached = cluster == state.hpa_start_reach_cluster
            || hpa_cluster_reached_in_last_search(state, class_idx, cluster);
        if !reached {
            continue;
        }
        let (x0, y0, x1, y1) = hpa_cluster_bounds(state, cluster);
        let cx = gx.clamp(x0, x1 - 1);
        let cy = gy.clamp(y0, y1 - 1);
        let bound = ((cx - gx) as i64).pow(2) + ((cy - gy) as i64).pow(2);
        candidates.push((bound, cluster));
    }
    candidates.sort_unstable();
    for &(bound, cluster) in &candidates {
        if best.is_some_and(|(_, _, d)| bound >= d) {
            break;
        }
        let (x0, y0, x1, y1) = hpa_cluster_bounds(state, cluster);
        for ny in y0..y1 {
            for nx in x0..x1 {
                work += 1;
                let idx = (ny * state.grid_w + nx) as usize;
                let d2 = ((nx - gx) as i64).pow(2) + ((ny - gy) as i64).pow(2);
                if best.is_some_and(|(_, _, d)| d2 >= d) {
                    continue;
                }
                if !pathfinder_is_cell_passable(state, idx, traversal) {
                    continue;
                }
                if !hpa_cell_reachable_after_failed_search(state, class_idx, idx as u32) {
                    continue;
                }
                best = Some((nx, ny, d2));
            }
        }
    }
    (best.map(|(x, y, _)| (x, y)), work)
}
