use super::*;

#[inline]
pub(crate) fn terrain_clamp_cell(value: i32, count: i32) -> i32 {
    if count <= 1 {
        0
    } else {
        value.max(0).min(count - 1)
    }
}

#[inline]
pub(crate) fn terrain_triangle_cell_span(
    cells_x: i32,
    cells_y: i32,
    cell_size: f64,
    vertex_coords: &[f64],
    triangle_indices: &[i32],
    tri: usize,
) -> Option<(i32, i32, i32, i32)> {
    let tri_offset = tri.checked_mul(3)?;
    let ia = *triangle_indices.get(tri_offset)? as usize;
    let ib = *triangle_indices.get(tri_offset + 1)? as usize;
    let ic = *triangle_indices.get(tri_offset + 2)? as usize;
    let ax = *vertex_coords.get(ia.checked_mul(2)?)?;
    let az = *vertex_coords.get(ia.checked_mul(2)? + 1)?;
    let bx = *vertex_coords.get(ib.checked_mul(2)?)?;
    let bz = *vertex_coords.get(ib.checked_mul(2)? + 1)?;
    let cx = *vertex_coords.get(ic.checked_mul(2)?)?;
    let cz = *vertex_coords.get(ic.checked_mul(2)? + 1)?;
    if !ax.is_finite()
        || !az.is_finite()
        || !bx.is_finite()
        || !bz.is_finite()
        || !cx.is_finite()
        || !cz.is_finite()
    {
        return None;
    }
    let min_cell_x = terrain_clamp_cell((ax.min(bx).min(cx) / cell_size).floor() as i32, cells_x);
    let max_cell_x = terrain_clamp_cell((ax.max(bx).max(cx) / cell_size).floor() as i32, cells_x);
    let min_cell_y = terrain_clamp_cell((az.min(bz).min(cz) / cell_size).floor() as i32, cells_y);
    let max_cell_y = terrain_clamp_cell((az.max(bz).max(cz) / cell_size).floor() as i32, cells_y);
    Some((min_cell_x, max_cell_x, min_cell_y, max_cell_y))
}

/// First pass for the mesh cell->triangle acceleration structure used by
/// terrain sampling. Fills `cell_triangle_offsets_out` with prefix offsets
/// and returns the required number of triangle refs, or -1 when TS should
/// keep the compatibility path.
#[wasm_bindgen]
pub fn terrain_count_cell_triangle_refs(
    cells_x: i32,
    cells_y: i32,
    cell_size: f64,
    vertex_coords: &[f64],
    triangle_indices: &[i32],
    cell_triangle_offsets_out: &mut [i32],
) -> i32 {
    if cells_x <= 0
        || cells_y <= 0
        || !cell_size.is_finite()
        || cell_size <= 0.0
        || triangle_indices.len() % 3 != 0
    {
        return -1;
    }
    let cell_count = match (cells_x as usize).checked_mul(cells_y as usize) {
        Some(count) => count,
        None => return -1,
    };
    if cell_triangle_offsets_out.len() < cell_count + 1 {
        return -1;
    }
    for offset in &mut cell_triangle_offsets_out[..cell_count] {
        *offset = 0;
    }

    let triangle_count = triangle_indices.len() / 3;
    for tri in 0..triangle_count {
        let (min_cell_x, max_cell_x, min_cell_y, max_cell_y) = match terrain_triangle_cell_span(
            cells_x,
            cells_y,
            cell_size,
            vertex_coords,
            triangle_indices,
            tri,
        ) {
            Some(span) => span,
            None => return -1,
        };
        for cy in min_cell_y..=max_cell_y {
            for cell_x in min_cell_x..=max_cell_x {
                let cell_index = (cy * cells_x + cell_x) as usize;
                cell_triangle_offsets_out[cell_index] += 1;
            }
        }
    }

    let mut total_refs: i64 = 0;
    for i in 0..cell_count {
        let count = cell_triangle_offsets_out[i] as i64;
        cell_triangle_offsets_out[i] = total_refs as i32;
        total_refs += count;
        if total_refs > i32::MAX as i64 {
            return -1;
        }
    }
    cell_triangle_offsets_out[cell_count] = total_refs as i32;
    total_refs as i32
}

/// Second pass for the terrain mesh cell index. Uses prefix offsets produced
/// by `terrain_count_cell_triangle_refs` and fills the flat triangle ref list.
#[wasm_bindgen]
pub fn terrain_fill_cell_triangle_indices(
    cells_x: i32,
    cells_y: i32,
    cell_size: f64,
    vertex_coords: &[f64],
    triangle_indices: &[i32],
    cell_triangle_offsets: &[i32],
    cell_triangle_indices_out: &mut [i32],
) -> i32 {
    if cells_x <= 0
        || cells_y <= 0
        || !cell_size.is_finite()
        || cell_size <= 0.0
        || triangle_indices.len() % 3 != 0
    {
        return -1;
    }
    let cell_count = match (cells_x as usize).checked_mul(cells_y as usize) {
        Some(count) => count,
        None => return -1,
    };
    if cell_triangle_offsets.len() < cell_count + 1 {
        return -1;
    }
    let total_refs = cell_triangle_offsets[cell_count];
    if total_refs < 0 || cell_triangle_indices_out.len() < total_refs as usize {
        return -1;
    }
    let mut write_offsets = cell_triangle_offsets[..cell_count].to_vec();

    let triangle_count = triangle_indices.len() / 3;
    for tri in 0..triangle_count {
        let (min_cell_x, max_cell_x, min_cell_y, max_cell_y) = match terrain_triangle_cell_span(
            cells_x,
            cells_y,
            cell_size,
            vertex_coords,
            triangle_indices,
            tri,
        ) {
            Some(span) => span,
            None => return -1,
        };
        for cy in min_cell_y..=max_cell_y {
            for cell_x in min_cell_x..=max_cell_x {
                let cell_index = (cy * cells_x + cell_x) as usize;
                let write = write_offsets[cell_index];
                if write < 0 || write >= total_refs {
                    return -1;
                }
                cell_triangle_indices_out[write as usize] = tri as i32;
                write_offsets[cell_index] = write + 1;
            }
        }
    }

    total_refs
}

#[inline]
pub(crate) fn terrain_push_unique_neighbor(neighbors: &mut Vec<usize>, vertex: usize) {
    if !neighbors.iter().any(|&existing| existing == vertex) {
        neighbors.push(vertex);
    }
}

/// Laplacian smoothing of mesh vertex heights. This mirrors
/// smoothMeshVertexHeights in terrainTileMap.ts, including ordered-Set
/// neighbor insertion so floating-point accumulation order stays stable.
pub(crate) fn terrain_smooth_mesh_vertex_heights(
    vertex_heights: &mut [f64],
    triangle_indices: &[i32],
    max_steps: i32,
    amount: f64,
) -> u32 {
    if triangle_indices.len() % 3 != 0 || !amount.is_finite() {
        return 0;
    }
    let steps = max_steps.max(0) as usize;
    let amount = amount.clamp(0.0, 1.0);
    if steps == 0 || amount <= 0.0 || vertex_heights.is_empty() {
        return 1;
    }

    let vertex_count = vertex_heights.len();
    let mut neighbors = vec![Vec::<usize>::new(); vertex_count];
    for t in (0..triangle_indices.len()).step_by(3) {
        let a = triangle_indices[t];
        let b = triangle_indices[t + 1];
        let c = triangle_indices[t + 2];
        if a < 0 || b < 0 || c < 0 {
            return 0;
        }
        let a = a as usize;
        let b = b as usize;
        let c = c as usize;
        if a >= vertex_count || b >= vertex_count || c >= vertex_count {
            return 0;
        }
        terrain_push_unique_neighbor(&mut neighbors[a], b);
        terrain_push_unique_neighbor(&mut neighbors[a], c);
        terrain_push_unique_neighbor(&mut neighbors[b], a);
        terrain_push_unique_neighbor(&mut neighbors[b], c);
        terrain_push_unique_neighbor(&mut neighbors[c], a);
        terrain_push_unique_neighbor(&mut neighbors[c], b);
    }

    let mut next = vec![0.0; vertex_count];
    for _ in 0..steps {
        for v in 0..vertex_count {
            let ns = &neighbors[v];
            if ns.is_empty() {
                next[v] = vertex_heights[v];
                continue;
            }
            let mut sum = 0.0;
            for &n in ns {
                sum += vertex_heights[n];
            }
            let avg = sum / ns.len() as f64;
            next[v] = vertex_heights[v] + (avg - vertex_heights[v]) * amount;
        }
        vertex_heights.copy_from_slice(&next);
    }
    1
}

#[derive(Clone, Copy)]
pub(crate) struct TerrainTriangleEdgeOwnerRust {
    triangle: usize,
    edge: usize,
    a: usize,
    b: usize,
}

#[derive(Clone, Copy)]
pub(crate) struct TerrainTriangleEdgeSpanRust {
    triangle: usize,
    edge: usize,
    a: usize,
    b: usize,
    line_key: i64,
    line_kind: u8,
    start: f64,
    end: f64,
}

pub(crate) struct TerrainMeshEdgeMetadataRust {
    edge_owners: HashMap<u64, Vec<TerrainTriangleEdgeOwnerRust>>,
    spans_by_line: HashMap<i64, Vec<TerrainTriangleEdgeSpanRust>>,
    edge_spans: HashMap<usize, TerrainTriangleEdgeSpanRust>,
}

#[inline]
pub(crate) fn terrain_triangle_edge_key(triangle: usize, edge: usize) -> usize {
    triangle * 3 + edge
}

#[inline]
pub(crate) fn terrain_mesh_edge_key(a: usize, b: usize, vertex_key_base: u64) -> Option<u64> {
    let lo = a.min(b) as u64;
    let hi = a.max(b) as u64;
    lo.checked_mul(vertex_key_base)?.checked_add(hi)
}

pub(crate) fn terrain_collect_triangle_edge_owners(
    triangle_indices: &[i32],
) -> Option<HashMap<u64, Vec<TerrainTriangleEdgeOwnerRust>>> {
    if triangle_indices.len() % 3 != 0 {
        return None;
    }

    let mut max_vertex_id: usize = 0;
    for &index in triangle_indices {
        if index < 0 {
            return None;
        }
        max_vertex_id = max_vertex_id.max(index as usize);
    }
    let vertex_key_base = (max_vertex_id as u64).checked_add(1)?;
    let mut edge_owners: HashMap<u64, Vec<TerrainTriangleEdgeOwnerRust>> = HashMap::default();

    let triangle_count = triangle_indices.len() / 3;
    for triangle in 0..triangle_count {
        let tri_offset = triangle * 3;
        for edge in 0..3 {
            let a = triangle_indices[tri_offset + edge] as usize;
            let b = triangle_indices[tri_offset + ((edge + 1) % 3)] as usize;
            let key = terrain_mesh_edge_key(a, b, vertex_key_base)?;
            edge_owners
                .entry(key)
                .or_default()
                .push(TerrainTriangleEdgeOwnerRust {
                    triangle,
                    edge,
                    a,
                    b,
                });
        }
    }

    Some(edge_owners)
}

#[inline]
pub(crate) fn terrain_quantized_line_value(value: f64, vertex_key_scale: f64) -> Option<i64> {
    if !value.is_finite() || !vertex_key_scale.is_finite() || vertex_key_scale <= 0.0 {
        return None;
    }
    Some(terrain_js_round(value * vertex_key_scale) as i64)
}

#[inline]
pub(crate) fn terrain_edge_line_key(kind: u8, value: f64, vertex_key_scale: f64) -> Option<i64> {
    let quantized = terrain_quantized_line_value(value, vertex_key_scale)?;
    (kind as i64)
        .checked_mul(TERRAIN_EDGE_LINE_KEY_STRIDE)?
        .checked_add(quantized)?
        .checked_add(TERRAIN_EDGE_LINE_KEY_BIAS)
}

pub(crate) fn terrain_edge_span_for_owner(
    vertex_coords: &[f64],
    owner: TerrainTriangleEdgeOwnerRust,
    vertex_key_scale: f64,
) -> Option<TerrainTriangleEdgeSpanRust> {
    let ax = *vertex_coords.get(owner.a.checked_mul(2)?)?;
    let az = *vertex_coords.get(owner.a.checked_mul(2)? + 1)?;
    let bx = *vertex_coords.get(owner.b.checked_mul(2)?)?;
    let bz = *vertex_coords.get(owner.b.checked_mul(2)? + 1)?;
    if !ax.is_finite() || !az.is_finite() || !bx.is_finite() || !bz.is_finite() {
        return None;
    }

    let horizontal_error = (az - bz).abs();
    let diag_a0 = ax - az * TERRAIN_INV_SQRT3;
    let diag_a1 = bx - bz * TERRAIN_INV_SQRT3;
    let diag_b0 = ax + az * TERRAIN_INV_SQRT3;
    let diag_b1 = bx + bz * TERRAIN_INV_SQRT3;
    let diag_a_error = (diag_a0 - diag_a1).abs();
    let diag_b_error = (diag_b0 - diag_b1).abs();
    let best_error = horizontal_error.min(diag_a_error).min(diag_b_error);
    if best_error > TERRAIN_MESH_EDGE_EPSILON {
        return None;
    }

    let (line_kind, line_value, a_coord, b_coord) = if best_error == horizontal_error {
        (0, (az + bz) * 0.5, ax, bx)
    } else if best_error == diag_a_error {
        (1, (diag_a0 + diag_a1) * 0.5, az, bz)
    } else {
        (2, (diag_b0 + diag_b1) * 0.5, az, bz)
    };

    Some(TerrainTriangleEdgeSpanRust {
        triangle: owner.triangle,
        edge: owner.edge,
        a: owner.a,
        b: owner.b,
        line_key: terrain_edge_line_key(line_kind, line_value, vertex_key_scale)?,
        line_kind,
        start: a_coord.min(b_coord),
        end: a_coord.max(b_coord),
    })
}

pub(crate) fn terrain_collect_triangle_edge_spans_by_line(
    vertex_coords: &[f64],
    edge_owners: &HashMap<u64, Vec<TerrainTriangleEdgeOwnerRust>>,
    vertex_key_scale: f64,
) -> HashMap<i64, Vec<TerrainTriangleEdgeSpanRust>> {
    let mut spans_by_line: HashMap<i64, Vec<TerrainTriangleEdgeSpanRust>> = HashMap::default();
    for owners in edge_owners.values() {
        for &owner in owners {
            let Some(span) = terrain_edge_span_for_owner(vertex_coords, owner, vertex_key_scale)
            else {
                continue;
            };
            spans_by_line.entry(span.line_key).or_default().push(span);
        }
    }
    for spans in spans_by_line.values_mut() {
        spans.sort_by(|a, b| {
            a.start
                .partial_cmp(&b.start)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    a.end
                        .partial_cmp(&b.end)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
    }
    spans_by_line
}

pub(crate) fn terrain_collect_triangle_edge_span_index(
    spans_by_line: &HashMap<i64, Vec<TerrainTriangleEdgeSpanRust>>,
) -> HashMap<usize, TerrainTriangleEdgeSpanRust> {
    let mut edge_spans: HashMap<usize, TerrainTriangleEdgeSpanRust> = HashMap::default();
    for spans in spans_by_line.values() {
        for &span in spans {
            edge_spans.insert(terrain_triangle_edge_key(span.triangle, span.edge), span);
        }
    }
    edge_spans
}

pub(crate) fn terrain_build_mesh_edge_metadata(
    vertex_coords: &[f64],
    triangle_indices: &[i32],
    vertex_key_scale: f64,
) -> Option<TerrainMeshEdgeMetadataRust> {
    if !vertex_key_scale.is_finite() || vertex_key_scale <= 0.0 {
        return None;
    }
    let edge_owners = terrain_collect_triangle_edge_owners(triangle_indices)?;
    let spans_by_line =
        terrain_collect_triangle_edge_spans_by_line(vertex_coords, &edge_owners, vertex_key_scale);
    let edge_spans = terrain_collect_triangle_edge_span_index(&spans_by_line);
    Some(TerrainMeshEdgeMetadataRust {
        edge_owners,
        spans_by_line,
        edge_spans,
    })
}

pub(crate) fn terrain_mesh_edge_is_map_boundary(
    map_width: f64,
    map_height: f64,
    vertex_coords: &[f64],
    owner: TerrainTriangleEdgeOwnerRust,
) -> bool {
    let Some(ax) = vertex_coords.get(owner.a * 2).copied() else {
        return false;
    };
    let Some(az) = vertex_coords.get(owner.a * 2 + 1).copied() else {
        return false;
    };
    let Some(bx) = vertex_coords.get(owner.b * 2).copied() else {
        return false;
    };
    let Some(bz) = vertex_coords.get(owner.b * 2 + 1).copied() else {
        return false;
    };

    (ax.abs() <= TERRAIN_MESH_EDGE_EPSILON && bx.abs() <= TERRAIN_MESH_EDGE_EPSILON)
        || ((ax - map_width).abs() <= TERRAIN_MESH_EDGE_EPSILON
            && (bx - map_width).abs() <= TERRAIN_MESH_EDGE_EPSILON)
        || (az.abs() <= TERRAIN_MESH_EDGE_EPSILON && bz.abs() <= TERRAIN_MESH_EDGE_EPSILON)
        || ((az - map_height).abs() <= TERRAIN_MESH_EDGE_EPSILON
            && (bz - map_height).abs() <= TERRAIN_MESH_EDGE_EPSILON)
}

#[inline]
pub(crate) fn terrain_edge_spans_overlap(
    a: TerrainTriangleEdgeSpanRust,
    b: TerrainTriangleEdgeSpanRust,
) -> bool {
    a.triangle != b.triangle
        && a.line_key == b.line_key
        && a.end.min(b.end) - a.start.max(b.start) > TERRAIN_MESH_EDGE_EPSILON
}

pub(crate) fn terrain_find_overlapping_edge_spans(
    owner: TerrainTriangleEdgeOwnerRust,
    spans_by_line: &HashMap<i64, Vec<TerrainTriangleEdgeSpanRust>>,
    edge_spans: &HashMap<usize, TerrainTriangleEdgeSpanRust>,
) -> Vec<TerrainTriangleEdgeSpanRust> {
    let Some(owner_span) = edge_spans
        .get(&terrain_triangle_edge_key(owner.triangle, owner.edge))
        .copied()
    else {
        return Vec::new();
    };
    let Some(candidates) = spans_by_line.get(&owner_span.line_key) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for &candidate in candidates {
        if candidate.end <= owner_span.start + TERRAIN_MESH_EDGE_EPSILON {
            continue;
        }
        if candidate.start >= owner_span.end - TERRAIN_MESH_EDGE_EPSILON {
            break;
        }
        if terrain_edge_spans_overlap(owner_span, candidate) {
            out.push(candidate);
        }
    }
    out
}

pub(crate) fn terrain_validate_triangle_vertices(
    vertex_coords: &[f64],
    triangle_indices: &[i32],
) -> bool {
    if triangle_indices.len() % 3 != 0 || vertex_coords.len() % 2 != 0 {
        return false;
    }
    let vertex_count = vertex_coords.len() / 2;
    for &index in triangle_indices {
        if index < 0 || index as usize >= vertex_count {
            return false;
        }
    }
    true
}

/// Builds the triangle-edge neighbor metadata for a conforming terrain mesh.
/// Mirrors buildTriangleNeighborMetadata in terrainTileMap.ts. TypeScript keeps
/// object assembly and compatibility fallback; Rust owns the deterministic
/// edge-map and overlap walk when available.
pub(crate) fn terrain_build_triangle_neighbor_metadata(
    map_width: f64,
    map_height: f64,
    vertex_key_scale: f64,
    vertex_coords: &[f64],
    triangle_indices: &[i32],
    triangle_levels: &[i32],
    neighbor_indices_out: &mut [i32],
    neighbor_levels_out: &mut [i32],
) -> u32 {
    if !map_width.is_finite()
        || !map_height.is_finite()
        || map_width < 0.0
        || map_height < 0.0
        || !terrain_validate_triangle_vertices(vertex_coords, triangle_indices)
    {
        return 0;
    }
    let triangle_count = triangle_indices.len() / 3;
    let out_len = triangle_count * 3;
    if neighbor_indices_out.len() < out_len || neighbor_levels_out.len() < out_len {
        return 0;
    }
    for i in 0..out_len {
        neighbor_indices_out[i] = -1;
        neighbor_levels_out[i] = -1;
    }

    let Some(edge_metadata) =
        terrain_build_mesh_edge_metadata(vertex_coords, triangle_indices, vertex_key_scale)
    else {
        return 0;
    };

    for owners in edge_metadata.edge_owners.values() {
        if owners.len() != 2 {
            continue;
        }
        let a = owners[0];
        let b = owners[1];
        let a_offset = terrain_triangle_edge_key(a.triangle, a.edge);
        let b_offset = terrain_triangle_edge_key(b.triangle, b.edge);
        neighbor_indices_out[a_offset] = b.triangle as i32;
        neighbor_levels_out[a_offset] = triangle_levels.get(b.triangle).copied().unwrap_or(-1);
        neighbor_indices_out[b_offset] = a.triangle as i32;
        neighbor_levels_out[b_offset] = triangle_levels.get(a.triangle).copied().unwrap_or(-1);
    }

    for owners in edge_metadata.edge_owners.values() {
        for &owner in owners {
            let owner_offset = terrain_triangle_edge_key(owner.triangle, owner.edge);
            if neighbor_levels_out[owner_offset] >= 0
                || terrain_mesh_edge_is_map_boundary(map_width, map_height, vertex_coords, owner)
            {
                continue;
            }

            let overlaps = terrain_find_overlapping_edge_spans(
                owner,
                &edge_metadata.spans_by_line,
                &edge_metadata.edge_spans,
            );
            let mut best_triangle: i32 = -1;
            let mut best_level: i32 = -1;
            for overlap in overlaps {
                let level = triangle_levels.get(overlap.triangle).copied().unwrap_or(-1);
                if level > best_level {
                    best_level = level;
                    best_triangle = overlap.triangle as i32;
                }
            }
            if best_triangle >= 0 {
                neighbor_indices_out[owner_offset] = best_triangle;
                neighbor_levels_out[owner_offset] = best_level;
            }
        }
    }

    1
}

pub(crate) fn terrain_mark_triangle_leaf_for_split(
    leaf_sides: &[i32],
    triangle_leaf_indices: &[i32],
    split_leaf_flags_out: &mut [u8],
    triangle: usize,
) {
    let leaf_index = triangle_leaf_indices.get(triangle).copied().unwrap_or(-1);
    if leaf_index < 0 {
        return;
    }
    let leaf_index = leaf_index as usize;
    if leaf_index >= leaf_sides.len() || leaf_index >= split_leaf_flags_out.len() {
        return;
    }
    if leaf_sides[leaf_index] <= 1 {
        return;
    }
    split_leaf_flags_out[leaf_index] = 1;
}

pub(crate) fn terrain_mark_coarser_triangle_leaf_for_split(
    leaf_sides: &[i32],
    triangle_leaf_indices: &[i32],
    triangle_levels: &[i32],
    split_leaf_flags_out: &mut [u8],
    a_triangle: usize,
    b_triangle: usize,
) {
    let a_level = triangle_levels.get(a_triangle).copied().unwrap_or(0);
    let b_level = triangle_levels.get(b_triangle).copied().unwrap_or(0);
    if a_level <= b_level {
        terrain_mark_triangle_leaf_for_split(
            leaf_sides,
            triangle_leaf_indices,
            split_leaf_flags_out,
            a_triangle,
        );
    }
    if b_level <= a_level {
        terrain_mark_triangle_leaf_for_split(
            leaf_sides,
            triangle_leaf_indices,
            split_leaf_flags_out,
            b_triangle,
        );
    }
}

/// Marks adaptive terrain leaves that must be split to repair neighbor
/// discrepancies. Mirrors findMeshNeighborDiscrepancyLeafIndices in
/// terrainTileMap.ts; TS still owns leaf objects and split orchestration.
pub(crate) fn terrain_mark_neighbor_discrepancy_leaves(
    map_width: f64,
    map_height: f64,
    vertex_key_scale: f64,
    max_neighbor_level_delta: i32,
    leaf_sides: &[i32],
    vertex_coords: &[f64],
    triangle_indices: &[i32],
    triangle_levels: &[i32],
    triangle_leaf_indices: &[i32],
    split_leaf_flags_out: &mut [u8],
) -> u32 {
    if !map_width.is_finite()
        || !map_height.is_finite()
        || map_width < 0.0
        || map_height < 0.0
        || !terrain_validate_triangle_vertices(vertex_coords, triangle_indices)
        || split_leaf_flags_out.len() < leaf_sides.len()
    {
        return 0;
    }
    for flag in &mut split_leaf_flags_out[..leaf_sides.len()] {
        *flag = 0;
    }

    let Some(edge_metadata) =
        terrain_build_mesh_edge_metadata(vertex_coords, triangle_indices, vertex_key_scale)
    else {
        return 0;
    };
    let max_delta = max_neighbor_level_delta.max(0);

    for owners in edge_metadata.edge_owners.values() {
        if owners.len() == 2 {
            let a = owners[0];
            let b = owners[1];
            let a_level = triangle_levels.get(a.triangle).copied().unwrap_or(0);
            let b_level = triangle_levels.get(b.triangle).copied().unwrap_or(0);
            if (a_level - b_level).abs() > max_delta {
                terrain_mark_coarser_triangle_leaf_for_split(
                    leaf_sides,
                    triangle_leaf_indices,
                    triangle_levels,
                    split_leaf_flags_out,
                    a.triangle,
                    b.triangle,
                );
            }
            continue;
        }

        if owners.len() > 2 {
            for &owner in owners {
                terrain_mark_triangle_leaf_for_split(
                    leaf_sides,
                    triangle_leaf_indices,
                    split_leaf_flags_out,
                    owner.triangle,
                );
            }
            continue;
        }

        let owner = owners[0];
        if terrain_mesh_edge_is_map_boundary(map_width, map_height, vertex_coords, owner) {
            continue;
        }

        let overlaps = terrain_find_overlapping_edge_spans(
            owner,
            &edge_metadata.spans_by_line,
            &edge_metadata.edge_spans,
        );
        if overlaps.is_empty() {
            terrain_mark_triangle_leaf_for_split(
                leaf_sides,
                triangle_leaf_indices,
                split_leaf_flags_out,
                owner.triangle,
            );
            continue;
        }

        for overlap in overlaps {
            terrain_mark_coarser_triangle_leaf_for_split(
                leaf_sides,
                triangle_leaf_indices,
                triangle_levels,
                split_leaf_flags_out,
                owner.triangle,
                overlap.triangle,
            );
        }
    }

    1
}

// ─────────────────────────────────────────────────────────────────
//  C16 — adaptive equilateral terrain mesh build
//
//  Full port of the adaptive mesh topology generation + crack-repair
//  loop from src/game/sim/terrain/terrainTileMap.ts. TypeScript keeps
//  only object assembly (build the config slice, call this kernel, and
//  splat the returned arrays into a TerrainTileMap). Vertex heights and
//  every collapse/normal decision read the same analytic sampler the
//  metal-deposit kernels use (metal_deposit_terrain_height_with_explicit_zones),
//  so the mesh and the deposit pads agree by construction and the host
//  no longer baked terrain topology in JavaScript.
// ─────────────────────────────────────────────────────────────────

pub(crate) const TERRAIN_SQRT3_OVER_2: f64 = 0.866_025_403_784_438_6;

#[derive(Clone, Copy)]
pub(crate) struct TerrainHierTri {
    i: i32,
    j: i32,
    side: i32,
    down: bool,
}

#[derive(Clone, Copy)]
pub(crate) struct TerrainMeshPoint {
    x: f64,
    z: f64,
    h: f64,
}

#[derive(Clone, Copy)]
pub(crate) struct TerrainMeshNormalRust {
    nx: f64,
    ny: f64,
    nz: f64,
}

pub(crate) struct TerrainMeshBuildConfig {
    map_width: f64,
    map_height: f64,
    fine_edge: f64,
    fine_height: f64,
    root_level: i32,
    metrics: MapOvalMetricsRust,
    gen_cfg: MetalDepositTerrainConfigRust,
    flat_zones: Vec<f64>,
    max_surface_error: f64,
    min_normal_dot: f64,
    max_neighbor_level_delta: i32,
    preserve_waterline: bool,
    sample_centroid: bool,
    water_level: f64,
    vertex_key_scale: f64,
    final_repair_max_passes: i32,
    smoothing_steps: i32,
    smoothing_amount: f64,
}

#[derive(Default)]
pub(crate) struct TerrainMeshHeightCache {
    heights: HashMap<i64, f64>,
    normals: HashMap<i64, TerrainMeshNormalRust>,
}

pub(crate) struct TerrainMeshTopologyRust {
    vertex_coords: Vec<f64>,
    vertex_heights: Vec<f64>,
    triangle_indices: Vec<i32>,
    triangle_levels: Vec<i32>,
    triangle_wall_flags: Vec<i32>,
    triangle_leaf_indices: Vec<i32>,
}

pub(crate) struct TerrainBuiltMeshRust {
    vertex_coords: Vec<f64>,
    vertex_heights: Vec<f64>,
    triangle_indices: Vec<i32>,
    triangle_levels: Vec<i32>,
    triangle_wall_flags: Vec<i32>,
    neighbor_indices: Vec<i32>,
    neighbor_levels: Vec<i32>,
    cell_offsets: Vec<i32>,
    cell_indices: Vec<i32>,
}

#[inline]
pub(crate) fn terrain_mesh_clamp_to_map(value: f64, max: f64) -> f64 {
    if value <= 0.0 {
        0.0
    } else if value >= max {
        max
    } else {
        value
    }
}

#[inline]
pub(crate) fn terrain_lattice_cache_key(i: i32, j: i32) -> i64 {
    (i as i64 + 0x100000) * 0x200000 + (j as i64 + 0x100000)
}

#[inline]
pub(crate) fn terrain_next_power_of_two(value: i64) -> i64 {
    let mut n: i64 = 1;
    while n < value {
        n <<= 1;
    }
    n
}

pub(crate) fn terrain_mesh_height_at_world(c: &TerrainMeshBuildConfig, x: f64, z: f64) -> f64 {
    let cx = terrain_mesh_clamp_to_map(x, c.map_width);
    let cz = terrain_mesh_clamp_to_map(z, c.map_height);
    metal_deposit_terrain_height_with_explicit_zones(cx, cz, &c.metrics, &c.gen_cfg, &c.flat_zones)
}

pub(crate) fn terrain_mesh_height_at_lattice(
    c: &TerrainMeshBuildConfig,
    cache: &mut TerrainMeshHeightCache,
    i: i32,
    j: i32,
) -> f64 {
    let key = terrain_lattice_cache_key(i, j);
    if let Some(h) = cache.heights.get(&key) {
        return *h;
    }
    let x = c.fine_edge * (i as f64 + j as f64 * 0.5);
    let z = c.fine_height * j as f64;
    let h = terrain_mesh_height_at_world(c, x, z);
    cache.heights.insert(key, h);
    h
}

pub(crate) fn terrain_normalize_mesh_normal(nx: f64, ny: f64, nz: f64) -> TerrainMeshNormalRust {
    let raw = (nx * nx + ny * ny + nz * nz).sqrt();
    let len = if raw > 0.0 { raw } else { 1.0 };
    TerrainMeshNormalRust {
        nx: nx / len,
        ny: ny / len,
        nz: nz / len,
    }
}

pub(crate) fn terrain_plane_normal(
    a: TerrainMeshPoint,
    b: TerrainMeshPoint,
    c: TerrainMeshPoint,
) -> TerrainMeshNormalRust {
    let ux = b.x - a.x;
    let uy = b.h - a.h;
    let uz = b.z - a.z;
    let vx = c.x - a.x;
    let vy = c.h - a.h;
    let vz = c.z - a.z;
    let mut nx = uy * vz - uz * vy;
    let mut vertical = uz * vx - ux * vz;
    let mut nz = ux * vy - uy * vx;
    if vertical < 0.0 {
        nx = -nx;
        vertical = -vertical;
        nz = -nz;
    }
    terrain_normalize_mesh_normal(nx, nz, vertical)
}

pub(crate) fn terrain_normal_at_lattice(
    c: &TerrainMeshBuildConfig,
    cache: &mut TerrainMeshHeightCache,
    i: i32,
    j: i32,
) -> TerrainMeshNormalRust {
    let key = terrain_lattice_cache_key(i, j);
    if let Some(n) = cache.normals.get(&key) {
        return *n;
    }
    let gx = (terrain_mesh_height_at_lattice(c, cache, i + 1, j)
        - terrain_mesh_height_at_lattice(c, cache, i - 1, j))
        / (2.0 * c.fine_edge);
    let hj = terrain_mesh_height_at_lattice(c, cache, i, j + 1)
        - terrain_mesh_height_at_lattice(c, cache, i, j - 1);
    let gz = (hj - gx * c.fine_edge) / (2.0 * c.fine_height);
    let normal = terrain_normalize_mesh_normal(-gx, -gz, 1.0);
    cache.normals.insert(key, normal);
    normal
}

pub(crate) fn terrain_normal_at_world(
    c: &TerrainMeshBuildConfig,
    x: f64,
    z: f64,
) -> TerrainMeshNormalRust {
    let eps = c.fine_edge.min(c.fine_height).max(1.0);
    let x0 = terrain_mesh_clamp_to_map(x - eps, c.map_width);
    let x1 = terrain_mesh_clamp_to_map(x + eps, c.map_width);
    let z0 = terrain_mesh_clamp_to_map(z - eps, c.map_height);
    let z1 = terrain_mesh_clamp_to_map(z + eps, c.map_height);
    let gx = (terrain_mesh_height_at_world(c, x1, z) - terrain_mesh_height_at_world(c, x0, z))
        / (x1 - x0).max(TERRAIN_MESH_EPSILON);
    let gz = (terrain_mesh_height_at_world(c, x, z1) - terrain_mesh_height_at_world(c, x, z0))
        / (z1 - z0).max(TERRAIN_MESH_EPSILON);
    terrain_normalize_mesh_normal(-gx, -gz, 1.0)
}

#[inline]
pub(crate) fn terrain_normals_exceed_tolerance(
    a: TerrainMeshNormalRust,
    b: TerrainMeshNormalRust,
    min_dot: f64,
) -> bool {
    a.nx * b.nx + a.ny * b.ny + a.nz * b.nz < min_dot
}

#[inline]
pub(crate) fn terrain_triangle_hierarchy_level(c: &TerrainMeshBuildConfig, side: i32) -> i32 {
    let side_level = 31 - (side.max(1) as u32).leading_zeros() as i32;
    (c.root_level - side_level).max(0)
}

pub(crate) fn terrain_triangle_lattice_vertices(tri: TerrainHierTri) -> [(i32, i32); 3] {
    let TerrainHierTri { i, j, side, down } = tri;
    if !down {
        [(i, j), (i + side, j), (i, j + side)]
    } else {
        [(i + side, j), (i + side, j + side), (i, j + side)]
    }
}

pub(crate) fn terrain_lattice_point_at(
    c: &TerrainMeshBuildConfig,
    cache: &mut TerrainMeshHeightCache,
    i: i32,
    j: i32,
) -> TerrainMeshPoint {
    let x = c.fine_edge * (i as f64 + j as f64 * 0.5);
    let z = c.fine_height * j as f64;
    TerrainMeshPoint {
        x,
        z,
        h: terrain_mesh_height_at_lattice(c, cache, i, j),
    }
}

pub(crate) fn terrain_triangle_world_vertices(
    c: &TerrainMeshBuildConfig,
    cache: &mut TerrainMeshHeightCache,
    tri: TerrainHierTri,
) -> [TerrainMeshPoint; 3] {
    let [a, b, cc] = terrain_triangle_lattice_vertices(tri);
    [
        terrain_lattice_point_at(c, cache, a.0, a.1),
        terrain_lattice_point_at(c, cache, b.0, b.1),
        terrain_lattice_point_at(c, cache, cc.0, cc.1),
    ]
}

pub(crate) fn terrain_triangle_bbox_intersects_map(
    c: &TerrainMeshBuildConfig,
    tri: TerrainHierTri,
) -> bool {
    let TerrainHierTri { i, j, side, down } = tri;
    let z0 = c.fine_height * j as f64;
    let z1 = c.fine_height * (j + side) as f64;
    let (ax, bx, cx) = if !down {
        (
            c.fine_edge * (i as f64 + j as f64 * 0.5),
            c.fine_edge * ((i + side) as f64 + j as f64 * 0.5),
            c.fine_edge * (i as f64 + (j + side) as f64 * 0.5),
        )
    } else {
        (
            c.fine_edge * ((i + side) as f64 + j as f64 * 0.5),
            c.fine_edge * ((i + side) as f64 + (j + side) as f64 * 0.5),
            c.fine_edge * (i as f64 + (j + side) as f64 * 0.5),
        )
    };
    let min_x = ax.min(bx).min(cx);
    let max_x = ax.max(bx).max(cx);
    let min_z = z0.min(z1);
    let max_z = z0.max(z1);
    max_x > 0.0 && min_x < c.map_width && max_z > 0.0 && min_z < c.map_height
}

#[inline]
pub(crate) fn terrain_point_inside_map(c: &TerrainMeshBuildConfig, x: f64, z: f64) -> bool {
    x >= -TERRAIN_MESH_EPSILON
        && z >= -TERRAIN_MESH_EPSILON
        && x <= c.map_width + TERRAIN_MESH_EPSILON
        && z <= c.map_height + TERRAIN_MESH_EPSILON
}

#[inline]
pub(crate) fn terrain_plateau_shelf_key(level: i32) -> i32 {
    level * 2
}

#[inline]
pub(crate) fn terrain_plateau_wall_key(lower_level: i32) -> i32 {
    lower_level * 2 + 1
}

pub(crate) fn terrain_plateau_q_and_flat_half_at_world(
    c: &TerrainMeshBuildConfig,
    x: f64,
    z: f64,
) -> Option<(f64, f64)> {
    let step = terrain_plateau_step(&c.gen_cfg);
    if step <= 0.0 || !step.is_finite() {
        return None;
    }
    let shaped = terrain_shaped_height_before_plateaus(x, z, &c.metrics, &c.gen_cfg);
    if !shaped.is_finite() {
        return None;
    }
    let gradient = terrain_estimate_shaped_gradient_before_plateaus(x, z, &c.metrics, &c.gen_cfg);
    let flat_half = terrain_plateau_flat_half_for_gradient(gradient, &c.gen_cfg);
    Some((shaped / step, flat_half))
}

pub(crate) fn terrain_plateau_region_key_at_world(
    c: &TerrainMeshBuildConfig,
    x: f64,
    z: f64,
) -> Option<i32> {
    let (q, flat_half) = terrain_plateau_q_and_flat_half_at_world(c, x, z)?;
    let nearest = terrain_js_round(q);
    let signed_from_nearest = q - nearest;
    if signed_from_nearest.abs() <= flat_half {
        return Some(terrain_plateau_shelf_key(nearest as i32));
    }
    if signed_from_nearest > 0.0 {
        Some(terrain_plateau_wall_key(nearest as i32))
    } else {
        Some(terrain_plateau_wall_key(nearest as i32 - 1))
    }
}

pub(crate) fn terrain_plateau_region_key_at_lattice(
    c: &TerrainMeshBuildConfig,
    i: i32,
    j: i32,
) -> Option<i32> {
    let x = c.fine_edge * (i as f64 + j as f64 * 0.5);
    let z = c.fine_height * j as f64;
    if !terrain_point_inside_map(c, x, z) {
        return None;
    }
    terrain_plateau_region_key_at_world(c, x, z)
}

/// Boundary after a plateau-region key in height order:
/// shelf L -> wall L uses q - L - flatHalf = 0; wall L -> shelf L+1
/// uses q - (L + 1) + flatHalf = 0.
pub(crate) fn terrain_plateau_boundary_value_at_world(
    c: &TerrainMeshBuildConfig,
    x: f64,
    z: f64,
    after_key: i32,
) -> Option<f64> {
    let (q, flat_half) = terrain_plateau_q_and_flat_half_at_world(c, x, z)?;
    if after_key % 2 == 0 {
        let level = after_key / 2;
        Some(q - level as f64 - flat_half)
    } else {
        let lower_level = (after_key - 1) / 2;
        Some(q - (lower_level + 1) as f64 + flat_half)
    }
}

/// One interior/edge sample of the collapse test. Returns false when this
/// sample's surface error, waterline crossing, or normal divergence is too
/// large to allow the candidate triangle to collapse.
#[allow(clippy::too_many_arguments)]
pub(crate) fn terrain_collapse_sample_ok(
    c: &TerrainMeshBuildConfig,
    cache: &mut TerrainMeshHeightCache,
    i: i32,
    j: i32,
    plane: TerrainMeshNormalRust,
    plane_x: f64,
    plane_z: f64,
    plane_h: f64,
    a_h: f64,
    b_h: f64,
    c_h: f64,
    bary_wa_x: f64,
    bary_wa_z: f64,
    bary_wb_x: f64,
    bary_wb_z: f64,
    bary_origin_x: f64,
    bary_origin_z: f64,
    bary_denom: f64,
) -> bool {
    let x = c.fine_edge * (i as f64 + j as f64 * 0.5);
    let z = c.fine_height * j as f64;
    let bary_x = x - bary_origin_x;
    let bary_z = z - bary_origin_z;
    let wa = (bary_wa_x * bary_x + bary_wa_z * bary_z) / bary_denom;
    let wb = (bary_wb_x * bary_x + bary_wb_z * bary_z) / bary_denom;
    let wc = 1.0 - wa - wb;
    let actual = terrain_mesh_height_at_lattice(c, cache, i, j);
    let approx = wa * a_h + wb * b_h + wc * c_h;
    if c.preserve_waterline && (actual < c.water_level) != (approx < c.water_level) {
        return false;
    }
    if (plane.nx * (x - plane_x) + plane.ny * (z - plane_z) + plane.nz * (actual - plane_h)).abs()
        > c.max_surface_error
    {
        return false;
    }
    if actual >= c.water_level
        && terrain_normals_exceed_tolerance(
            terrain_normal_at_lattice(c, cache, i, j),
            plane,
            c.min_normal_dot,
        )
    {
        return false;
    }
    true
}

pub(crate) fn terrain_can_collapse_triangle(
    c: &TerrainMeshBuildConfig,
    cache: &mut TerrainMeshHeightCache,
    tri: TerrainHierTri,
) -> bool {
    let [a, b, cc] = terrain_triangle_world_vertices(c, cache, tri);
    let plane = terrain_plane_normal(a, b, cc);
    let n = tri.side;
    let bary_denom = (b.z - cc.z) * (a.x - cc.x) + (cc.x - b.x) * (a.z - cc.z);
    if bary_denom.abs() <= TERRAIN_MESH_EPSILON {
        return false;
    }
    let bary_wa_x = b.z - cc.z;
    let bary_wa_z = cc.x - b.x;
    let bary_wb_x = cc.z - a.z;
    let bary_wb_z = a.x - cc.x;
    let bary_origin_x = cc.x;
    let bary_origin_z = cc.z;
    let min_x = -TERRAIN_MESH_EPSILON;
    let min_z = -TERRAIN_MESH_EPSILON;
    let max_x = c.map_width + TERRAIN_MESH_EPSILON;
    let max_z = c.map_height + TERRAIN_MESH_EPSILON;
    let mut checked: i64 = 0;
    let mut first_plateau_key: Option<i32> = None;
    let mut observe_plateau_key = |key: Option<i32>| -> bool {
        let Some(key) = key else {
            return false;
        };
        if let Some(first) = first_plateau_key {
            return first != key;
        }
        first_plateau_key = Some(key);
        false
    };
    for offset_i in 0..=n {
        let (lo_j, hi_j) = if !tri.down {
            (0, n - offset_i)
        } else {
            (n - offset_i, n)
        };
        for offset_j in lo_j..=hi_j {
            let i = tri.i + offset_i;
            let j = tri.j + offset_j;
            let x = c.fine_edge * (i as f64 + j as f64 * 0.5);
            let z = c.fine_height * j as f64;
            if x < min_x || z < min_z || x > max_x || z > max_z {
                continue;
            }
            checked += 1;
            if observe_plateau_key(terrain_plateau_region_key_at_lattice(c, i, j)) {
                return false;
            }
            if !terrain_collapse_sample_ok(
                c,
                cache,
                i,
                j,
                plane,
                a.x,
                a.z,
                a.h,
                a.h,
                b.h,
                cc.h,
                bary_wa_x,
                bary_wa_z,
                bary_wb_x,
                bary_wb_z,
                bary_origin_x,
                bary_origin_z,
                bary_denom,
            ) {
                return false;
            }
        }
    }

    if checked == 0 {
        return true;
    }

    let centroid_x = (a.x + b.x + cc.x) / 3.0;
    let centroid_z = (a.z + b.z + cc.z) / 3.0;
    if c.sample_centroid && terrain_point_inside_map(c, centroid_x, centroid_z) {
        if observe_plateau_key(terrain_plateau_region_key_at_world(
            c, centroid_x, centroid_z,
        )) {
            return false;
        }
        let actual = terrain_mesh_height_at_world(c, centroid_x, centroid_z);
        let approx = (a.h + b.h + cc.h) / 3.0;
        if c.preserve_waterline && (actual < c.water_level) != (approx < c.water_level) {
            return false;
        }
        if (plane.nx * (centroid_x - a.x)
            + plane.ny * (centroid_z - a.z)
            + plane.nz * (actual - a.h))
            .abs()
            > c.max_surface_error
        {
            return false;
        }
        if actual >= c.water_level
            && terrain_normals_exceed_tolerance(
                terrain_normal_at_world(c, centroid_x, centroid_z),
                plane,
                c.min_normal_dot,
            )
        {
            return false;
        }
    }

    true
}

pub(crate) fn terrain_append_triangle_children(tri: TerrainHierTri, out: &mut Vec<TerrainHierTri>) {
    let half = tri.side >> 1;
    if half < 1 {
        return;
    }
    let (i, j) = (tri.i, tri.j);
    if !tri.down {
        out.push(TerrainHierTri {
            i,
            j,
            side: half,
            down: false,
        });
        out.push(TerrainHierTri {
            i: i + half,
            j,
            side: half,
            down: false,
        });
        out.push(TerrainHierTri {
            i,
            j: j + half,
            side: half,
            down: false,
        });
        out.push(TerrainHierTri {
            i,
            j,
            side: half,
            down: true,
        });
    } else {
        out.push(TerrainHierTri {
            i: i + half,
            j,
            side: half,
            down: true,
        });
        out.push(TerrainHierTri {
            i,
            j: j + half,
            side: half,
            down: true,
        });
        out.push(TerrainHierTri {
            i: i + half,
            j: j + half,
            side: half,
            down: true,
        });
        out.push(TerrainHierTri {
            i: i + half,
            j: j + half,
            side: half,
            down: false,
        });
    }
}

pub(crate) fn terrain_push_children_for_stack(
    tri: TerrainHierTri,
    stack: &mut Vec<TerrainHierTri>,
) {
    let half = tri.side >> 1;
    if half < 1 {
        return;
    }
    let (i, j) = (tri.i, tri.j);
    if !tri.down {
        stack.push(TerrainHierTri {
            i,
            j,
            side: half,
            down: true,
        });
        stack.push(TerrainHierTri {
            i,
            j: j + half,
            side: half,
            down: false,
        });
        stack.push(TerrainHierTri {
            i: i + half,
            j,
            side: half,
            down: false,
        });
        stack.push(TerrainHierTri {
            i,
            j,
            side: half,
            down: false,
        });
    } else {
        stack.push(TerrainHierTri {
            i: i + half,
            j: j + half,
            side: half,
            down: false,
        });
        stack.push(TerrainHierTri {
            i: i + half,
            j: j + half,
            side: half,
            down: true,
        });
        stack.push(TerrainHierTri {
            i,
            j: j + half,
            side: half,
            down: true,
        });
        stack.push(TerrainHierTri {
            i: i + half,
            j,
            side: half,
            down: true,
        });
    }
}

pub(crate) fn terrain_append_intersecting_children(
    c: &TerrainMeshBuildConfig,
    tri: TerrainHierTri,
    out: &mut Vec<TerrainHierTri>,
) {
    let mut children: Vec<TerrainHierTri> = Vec::new();
    terrain_append_triangle_children(tri, &mut children);
    for child in children {
        if terrain_triangle_bbox_intersects_map(c, child) {
            out.push(child);
        }
    }
}

pub(crate) fn terrain_build_triangle_leaves(
    c: &TerrainMeshBuildConfig,
    cache: &mut TerrainMeshHeightCache,
    tri: TerrainHierTri,
    out: &mut Vec<TerrainHierTri>,
) {
    let mut stack: Vec<TerrainHierTri> = vec![tri];
    while let Some(current) = stack.pop() {
        if !terrain_triangle_bbox_intersects_map(c, current) {
            continue;
        }
        if current.side <= 1 {
            out.push(current);
            continue;
        }
        if terrain_can_collapse_triangle(c, cache, current) {
            out.push(current);
            continue;
        }
        terrain_push_children_for_stack(current, &mut stack);
    }
}

pub(crate) fn terrain_lattice_segment_key_from_coords(ai: i32, aj: i32, bi: i32, bj: i32) -> i64 {
    let orientation: i64;
    let mut start_i = ai;
    let mut start_j = aj;
    if aj == bj {
        orientation = 0;
        if bi < ai {
            start_i = bi;
            start_j = bj;
        }
    } else if ai == bi {
        orientation = 1;
        if bj < aj {
            start_i = bi;
            start_j = bj;
        }
    } else {
        orientation = 2;
        if bi < ai {
            start_i = bi;
            start_j = bj;
        }
    }
    terrain_lattice_cache_key(start_i, start_j) * 3 + orientation
}

pub(crate) fn terrain_for_each_unit_segment_on_lattice_edge(
    ai: i32,
    aj: i32,
    bi: i32,
    bj: i32,
    visit: &mut dyn FnMut(i64),
) {
    let di = bi - ai;
    let dj = bj - aj;
    let steps = di.abs().max(dj.abs());
    if steps <= 0 {
        return;
    }
    let step_i = di / steps;
    let step_j = dj / steps;
    for k in 0..steps {
        let start_i = ai + step_i * k;
        let start_j = aj + step_j * k;
        visit(terrain_lattice_segment_key_from_coords(
            start_i,
            start_j,
            start_i + step_i,
            start_j + step_j,
        ));
    }
}

pub(crate) fn terrain_for_each_triangle_unit_edge_segment_key(
    tri: TerrainHierTri,
    visit: &mut dyn FnMut(i64),
) {
    let TerrainHierTri { i, j, side, down } = tri;
    if !down {
        terrain_for_each_unit_segment_on_lattice_edge(i, j, i + side, j, visit);
        terrain_for_each_unit_segment_on_lattice_edge(i + side, j, i, j + side, visit);
        terrain_for_each_unit_segment_on_lattice_edge(i, j + side, i, j, visit);
    } else {
        terrain_for_each_unit_segment_on_lattice_edge(i + side, j, i + side, j + side, visit);
        terrain_for_each_unit_segment_on_lattice_edge(i + side, j + side, i, j + side, visit);
        terrain_for_each_unit_segment_on_lattice_edge(i, j + side, i + side, j, visit);
    }
}

pub(crate) fn terrain_split_triangle_leaves(
    c: &TerrainMeshBuildConfig,
    leaves: &[TerrainHierTri],
    split_leaves: &HashSet<usize>,
) -> Vec<TerrainHierTri> {
    let mut next: Vec<TerrainHierTri> = Vec::new();
    for (i, &leaf) in leaves.iter().enumerate() {
        if !split_leaves.contains(&i) || leaf.side <= 1 {
            next.push(leaf);
            continue;
        }
        terrain_append_intersecting_children(c, leaf, &mut next);
    }
    next
}

pub(crate) fn terrain_balance_triangle_leaves(
    c: &TerrainMeshBuildConfig,
    leaves: Vec<TerrainHierTri>,
) -> Vec<TerrainHierTri> {
    let max_delta = c.max_neighbor_level_delta.max(0);
    if leaves.len() <= 1 {
        return leaves;
    }
    let mut balanced = leaves;
    let max_passes = terrain_triangle_hierarchy_level(c, 1) + 1;
    for _ in 0..max_passes {
        let mut segment_owners: HashMap<i64, Vec<(usize, i32)>> = HashMap::default();
        for (leaf_index, &leaf) in balanced.iter().enumerate() {
            let level = terrain_triangle_hierarchy_level(c, leaf.side);
            terrain_for_each_triangle_unit_edge_segment_key(leaf, &mut |key| {
                segment_owners
                    .entry(key)
                    .or_default()
                    .push((leaf_index, level));
            });
        }

        let mut split_leaves: HashSet<usize> = HashSet::default();
        for owners in segment_owners.values() {
            if owners.len() < 2 {
                continue;
            }
            let mut highest_level = 0;
            for &(_, level) in owners {
                highest_level = highest_level.max(level);
            }
            for &(leaf_index, level) in owners {
                if balanced[leaf_index].side > 1 && highest_level - level > max_delta {
                    split_leaves.insert(leaf_index);
                }
            }
        }

        if split_leaves.is_empty() {
            return balanced;
        }
        balanced = terrain_split_triangle_leaves(c, &balanced, &split_leaves);
    }
    balanced
}

pub(crate) fn terrain_edge_lattice_points(
    a: (i32, i32),
    b: (i32, i32),
    vertex_set: &HashSet<(i32, i32)>,
    include_start: bool,
    include_end: bool,
    out: &mut Vec<(i32, i32)>,
) {
    let di = b.0 - a.0;
    let dj = b.1 - a.1;
    let steps = di.abs().max(dj.abs());
    if steps <= 0 {
        return;
    }
    let step_i = di / steps;
    let step_j = dj / steps;
    for k in 0..=steps {
        if k == 0 && !include_start {
            continue;
        }
        if k == steps && !include_end {
            continue;
        }
        let i = a.0 + step_i * k;
        let j = a.1 + step_j * k;
        if k == 0 || k == steps || vertex_set.contains(&(i, j)) {
            out.push((i, j));
        }
    }
}

pub(crate) fn terrain_triangle_boundary_lattice_points(
    tri: TerrainHierTri,
    vertex_set: &HashSet<(i32, i32)>,
    out: &mut Vec<(i32, i32)>,
) {
    let [a, b, cc] = terrain_triangle_lattice_vertices(tri);
    terrain_edge_lattice_points(a, b, vertex_set, true, true, out);
    terrain_edge_lattice_points(b, cc, vertex_set, false, true, out);
    terrain_edge_lattice_points(cc, a, vertex_set, false, false, out);
}

pub(crate) fn terrain_remove_duplicate_mesh_points(
    points: &[TerrainMeshPoint],
) -> Vec<TerrainMeshPoint> {
    let mut out: Vec<TerrainMeshPoint> = Vec::new();
    for &p in points {
        if let Some(prev) = out.last() {
            if (prev.x - p.x).abs() <= TERRAIN_MESH_EPSILON
                && (prev.z - p.z).abs() <= TERRAIN_MESH_EPSILON
            {
                continue;
            }
        }
        out.push(p);
    }
    if out.len() > 1 {
        let first = out[0];
        let last = out[out.len() - 1];
        if (first.x - last.x).abs() <= TERRAIN_MESH_EPSILON
            && (first.z - last.z).abs() <= TERRAIN_MESH_EPSILON
        {
            out.pop();
        }
    }
    out
}

pub(crate) enum TerrainClipAxis {
    XMin,
    XMax,
    ZMin,
    ZMax,
}

#[inline]
pub(crate) fn terrain_clip_point_inside(
    p: TerrainMeshPoint,
    axis: &TerrainClipAxis,
    bound: f64,
) -> bool {
    match axis {
        TerrainClipAxis::XMin => p.x >= bound,
        TerrainClipAxis::XMax => p.x <= bound,
        TerrainClipAxis::ZMin => p.z >= bound,
        TerrainClipAxis::ZMax => p.z <= bound,
    }
}

pub(crate) fn terrain_clip_intersect(
    c: &TerrainMeshBuildConfig,
    a: TerrainMeshPoint,
    b: TerrainMeshPoint,
    axis: &TerrainClipAxis,
    bound: f64,
) -> TerrainMeshPoint {
    let t = match axis {
        TerrainClipAxis::XMin | TerrainClipAxis::XMax => {
            let denom = b.x - a.x;
            (bound - a.x) / (if denom == 0.0 { 1.0 } else { denom })
        }
        TerrainClipAxis::ZMin | TerrainClipAxis::ZMax => {
            let denom = b.z - a.z;
            (bound - a.z) / (if denom == 0.0 { 1.0 } else { denom })
        }
    };
    let x = a.x + (b.x - a.x) * t;
    let z = a.z + (b.z - a.z) * t;
    TerrainMeshPoint {
        x,
        z,
        h: terrain_mesh_height_at_world(c, x, z),
    }
}

pub(crate) fn terrain_clip_polygon_against_boundary(
    c: &TerrainMeshBuildConfig,
    points: &[TerrainMeshPoint],
    axis: TerrainClipAxis,
    bound: f64,
) -> Vec<TerrainMeshPoint> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<TerrainMeshPoint> = Vec::new();
    let mut prev = points[points.len() - 1];
    let mut prev_inside = terrain_clip_point_inside(prev, &axis, bound);
    for &curr in points {
        let curr_inside = terrain_clip_point_inside(curr, &axis, bound);
        if curr_inside != prev_inside {
            out.push(terrain_clip_intersect(c, prev, curr, &axis, bound));
        }
        if curr_inside {
            out.push(curr);
        }
        prev = curr;
        prev_inside = curr_inside;
    }
    terrain_remove_duplicate_mesh_points(&out)
}

pub(crate) fn terrain_clip_polygon_to_map(
    c: &TerrainMeshBuildConfig,
    points: &[TerrainMeshPoint],
) -> Vec<TerrainMeshPoint> {
    let mut clipped = terrain_remove_duplicate_mesh_points(points);
    clipped = terrain_clip_polygon_against_boundary(c, &clipped, TerrainClipAxis::XMin, 0.0);
    clipped =
        terrain_clip_polygon_against_boundary(c, &clipped, TerrainClipAxis::XMax, c.map_width);
    clipped = terrain_clip_polygon_against_boundary(c, &clipped, TerrainClipAxis::ZMin, 0.0);
    clipped =
        terrain_clip_polygon_against_boundary(c, &clipped, TerrainClipAxis::ZMax, c.map_height);
    terrain_remove_duplicate_mesh_points(&clipped)
}

pub(crate) fn terrain_polygon_signed_area(points: &[TerrainMeshPoint]) -> f64 {
    let mut area = 0.0;
    let n = points.len();
    for i in 0..n {
        let a = points[i];
        let b = points[(i + 1) % n];
        area += a.x * b.z - b.x * a.z;
    }
    area * 0.5
}

#[inline]
pub(crate) fn terrain_push_unique_mesh_point(out: &mut Vec<TerrainMeshPoint>, p: TerrainMeshPoint) {
    if let Some(prev) = out.last() {
        if (prev.x - p.x).abs() <= TERRAIN_MESH_EPSILON
            && (prev.z - p.z).abs() <= TERRAIN_MESH_EPSILON
        {
            return;
        }
    }
    out.push(p);
}

/// Bisect the region boundary crossing between `a` and `b` for an
/// an arbitrary region system's signed boundary function.
pub(crate) fn terrain_region_boundary_intersection(
    c: &TerrainMeshBuildConfig,
    a: TerrainMeshPoint,
    b: TerrainMeshPoint,
    boundary: &dyn Fn(f64, f64) -> Option<f64>,
) -> TerrainMeshPoint {
    let Some(fa) = boundary(a.x, a.z) else {
        let x = (a.x + b.x) * 0.5;
        let z = (a.z + b.z) * 0.5;
        return TerrainMeshPoint {
            x,
            z,
            h: terrain_mesh_height_at_world(c, x, z),
        };
    };
    let Some(fb) = boundary(b.x, b.z) else {
        let x = (a.x + b.x) * 0.5;
        let z = (a.z + b.z) * 0.5;
        return TerrainMeshPoint {
            x,
            z,
            h: terrain_mesh_height_at_world(c, x, z),
        };
    };
    if fa.abs() <= TERRAIN_PLATEAU_CONSTRAINT_EPSILON {
        return a;
    }
    if fb.abs() <= TERRAIN_PLATEAU_CONSTRAINT_EPSILON {
        return b;
    }

    let mut lo = 0.0;
    let mut hi = 1.0;
    let mut flo = fa;
    for _ in 0..36 {
        let mid = (lo + hi) * 0.5;
        let x = a.x + (b.x - a.x) * mid;
        let z = a.z + (b.z - a.z) * mid;
        let Some(fmid) = boundary(x, z) else {
            break;
        };
        if (flo <= 0.0) == (fmid <= 0.0) {
            lo = mid;
            flo = fmid;
        } else {
            hi = mid;
        }
    }

    let t = (lo + hi) * 0.5;
    let x = a.x + (b.x - a.x) * t;
    let z = a.z + (b.z - a.z) * t;
    TerrainMeshPoint {
        x,
        z,
        h: terrain_mesh_height_at_world(c, x, z),
    }
}

/// Clip a polygon against an arbitrary region system's signed boundary
/// function, keeping the lower- or higher-key side.
pub(crate) fn terrain_clip_polygon_by_region_boundary(
    c: &TerrainMeshBuildConfig,
    points: &[TerrainMeshPoint],
    keep_lower: bool,
    boundary: &dyn Fn(f64, f64) -> Option<f64>,
) -> Vec<TerrainMeshPoint> {
    if points.len() < 3 {
        return Vec::new();
    }

    let inside = |value: Option<f64>| -> bool {
        let Some(value) = value else {
            return false;
        };
        if keep_lower {
            value <= TERRAIN_PLATEAU_CONSTRAINT_EPSILON
        } else {
            value >= -TERRAIN_PLATEAU_CONSTRAINT_EPSILON
        }
    };

    let mut out: Vec<TerrainMeshPoint> = Vec::new();
    let mut prev = points[points.len() - 1];
    let mut prev_inside = inside(boundary(prev.x, prev.z));
    for &curr in points {
        let curr_inside = inside(boundary(curr.x, curr.z));
        if curr_inside != prev_inside {
            terrain_push_unique_mesh_point(
                &mut out,
                terrain_region_boundary_intersection(c, prev, curr, boundary),
            );
        }
        if curr_inside {
            terrain_push_unique_mesh_point(&mut out, curr);
        }
        prev = curr;
        prev_inside = curr_inside;
    }
    terrain_remove_duplicate_mesh_points(&out)
}

pub(crate) fn terrain_clip_polygon_by_plateau_boundary(
    c: &TerrainMeshBuildConfig,
    points: &[TerrainMeshPoint],
    after_key: i32,
    keep_lower: bool,
) -> Vec<TerrainMeshPoint> {
    terrain_clip_polygon_by_region_boundary(c, points, keep_lower, &|x, z| {
        terrain_plateau_boundary_value_at_world(c, x, z, after_key)
    })
}

pub(crate) fn terrain_polygon_has_area(points: &[TerrainMeshPoint]) -> bool {
    points.len() >= 3 && terrain_polygon_signed_area(points).abs() > TERRAIN_MESH_EPSILON
}

pub(crate) fn terrain_plateau_key_range_for_polygon(
    c: &TerrainMeshBuildConfig,
    points: &[TerrainMeshPoint],
) -> Option<(i32, i32)> {
    if terrain_plateau_step(&c.gen_cfg) <= 0.0 || points.len() < 3 {
        return None;
    }
    let mut min_key: Option<i32> = None;
    let mut max_key: Option<i32> = None;
    let mut observe = |key: Option<i32>| {
        let Some(key) = key else {
            return;
        };
        min_key = Some(min_key.map_or(key, |min| min.min(key)));
        max_key = Some(max_key.map_or(key, |max| max.max(key)));
    };

    for &p in points {
        observe(terrain_plateau_region_key_at_world(c, p.x, p.z));
    }
    for i in 0..points.len() {
        let a = points[i];
        let b = points[(i + 1) % points.len()];
        observe(terrain_plateau_region_key_at_world(
            c,
            (a.x + b.x) * 0.5,
            (a.z + b.z) * 0.5,
        ));
    }

    let mut cx = 0.0;
    let mut cz = 0.0;
    for &p in points {
        cx += p.x;
        cz += p.z;
    }
    let inv_n = 1.0 / points.len() as f64;
    observe(terrain_plateau_region_key_at_world(
        c,
        cx * inv_n,
        cz * inv_n,
    ));

    Some((min_key?, max_key?))
}

#[inline]
pub(crate) fn terrain_world_vertex_key(x: f64, z: f64, scale: f64) -> (i64, i64) {
    (
        terrain_js_round(x * scale) as i64,
        terrain_js_round(z * scale) as i64,
    )
}

#[inline]
pub(crate) fn terrain_triangle_area_from_vertex_ids(vc: &[f64], a: i32, b: i32, c: i32) -> f64 {
    let (a, b, c) = (a as usize, b as usize, c as usize);
    let ax = vc[a * 2];
    let az = vc[a * 2 + 1];
    let bx = vc[b * 2];
    let bz = vc[b * 2 + 1];
    let cx = vc[c * 2];
    let cz = vc[c * 2 + 1];
    (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
}

pub(crate) fn terrain_polygon_signed_area_from_vertex_ids(vc: &[f64], polygon: &[i32]) -> f64 {
    let mut area = 0.0;
    let n = polygon.len();
    for i in 0..n {
        let a = polygon[i] as usize;
        let b = polygon[(i + 1) % n] as usize;
        area += vc[a * 2] * vc[b * 2 + 1] - vc[b * 2] * vc[a * 2 + 1];
    }
    area * 0.5
}

#[inline]
pub(crate) fn terrain_push_unique_vertex(out: &mut Vec<i32>, vertex_id: i32) {
    if out.last() != Some(&vertex_id) {
        out.push(vertex_id);
    }
}

pub(crate) fn terrain_triangulate_convex_polygon(
    vc: &[f64],
    polygon: &[i32],
    level: i32,
    wall_flag: i32,
    leaf_index: i32,
    out_indices: &mut Vec<i32>,
    out_levels: &mut Vec<i32>,
    out_wall_flags: &mut Vec<i32>,
    out_leaf_indices: &mut Vec<i32>,
) {
    let mut work: Vec<i32> = polygon.to_vec();
    if work.len() < 3 {
        return;
    }
    if terrain_polygon_signed_area_from_vertex_ids(vc, &work) < 0.0 {
        work.reverse();
    }

    let mut guard: i64 = (work.len() * work.len()) as i64;
    while work.len() > 3 && guard > 0 {
        guard -= 1;
        let mut clipped = false;
        let n = work.len();
        for i in 0..n {
            let prev = work[(i + n - 1) % n];
            let curr = work[i];
            let next = work[(i + 1) % n];
            if terrain_triangle_area_from_vertex_ids(vc, prev, curr, next) <= TERRAIN_MESH_EPSILON {
                continue;
            }
            out_indices.push(prev);
            out_indices.push(curr);
            out_indices.push(next);
            out_levels.push(level);
            out_wall_flags.push(wall_flag);
            out_leaf_indices.push(leaf_index);
            work.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            return;
        }
    }

    if work.len() == 3
        && terrain_triangle_area_from_vertex_ids(vc, work[0], work[1], work[2])
            > TERRAIN_MESH_EPSILON
    {
        out_indices.push(work[0]);
        out_indices.push(work[1]);
        out_indices.push(work[2]);
        out_levels.push(level);
        out_wall_flags.push(wall_flag);
        out_leaf_indices.push(leaf_index);
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn terrain_emit_mesh_polygon(
    c: &TerrainMeshBuildConfig,
    points: &[TerrainMeshPoint],
    level: i32,
    leaf_index: i32,
    vertex_ids: &mut HashMap<(i64, i64), i32>,
    vertex_coords: &mut Vec<f64>,
    vertex_heights: &mut Vec<f64>,
    triangle_indices: &mut Vec<i32>,
    triangle_levels: &mut Vec<i32>,
    triangle_wall_flags: &mut Vec<i32>,
    triangle_leaf_indices: &mut Vec<i32>,
    wall_flag: i32,
) {
    let points = terrain_remove_duplicate_mesh_points(points);
    if !terrain_polygon_has_area(&points) {
        return;
    }

    let mut polygon_ids: Vec<i32> = Vec::with_capacity(points.len());
    for &p in &points {
        let x = terrain_mesh_clamp_to_map(p.x, c.map_width);
        let z = terrain_mesh_clamp_to_map(p.z, c.map_height);
        let key = terrain_world_vertex_key(x, z, c.vertex_key_scale);
        let id = if let Some(&existing) = vertex_ids.get(&key) {
            existing
        } else {
            let id = vertex_heights.len() as i32;
            vertex_ids.insert(key, id);
            vertex_coords.push(x);
            vertex_coords.push(z);
            vertex_heights.push(terrain_mesh_height_at_world(c, x, z));
            id
        };
        terrain_push_unique_vertex(&mut polygon_ids, id);
    }
    if polygon_ids.len() > 1 && polygon_ids[0] == polygon_ids[polygon_ids.len() - 1] {
        polygon_ids.pop();
    }

    terrain_triangulate_convex_polygon(
        vertex_coords,
        &polygon_ids,
        level,
        wall_flag,
        leaf_index,
        triangle_indices,
        triangle_levels,
        triangle_wall_flags,
        triangle_leaf_indices,
    );
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn terrain_emit_region_leaf_polygon(
    c: &TerrainMeshBuildConfig,
    points: &[TerrainMeshPoint],
    level: i32,
    leaf_index: i32,
    plateau_flag: i32,
    vertex_ids: &mut HashMap<(i64, i64), i32>,
    vertex_coords: &mut Vec<f64>,
    vertex_heights: &mut Vec<f64>,
    triangle_indices: &mut Vec<i32>,
    triangle_levels: &mut Vec<i32>,
    triangle_wall_flags: &mut Vec<i32>,
    triangle_leaf_indices: &mut Vec<i32>,
) {
    terrain_emit_mesh_polygon(
        c,
        points,
        level,
        leaf_index,
        vertex_ids,
        vertex_coords,
        vertex_heights,
        triangle_indices,
        triangle_levels,
        triangle_wall_flags,
        triangle_leaf_indices,
        plateau_flag,
    );
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn terrain_emit_plateau_constrained_polygon(
    c: &TerrainMeshBuildConfig,
    points: &[TerrainMeshPoint],
    low_key: i32,
    high_key: i32,
    depth: i32,
    level: i32,
    leaf_index: i32,
    vertex_ids: &mut HashMap<(i64, i64), i32>,
    vertex_coords: &mut Vec<f64>,
    vertex_heights: &mut Vec<f64>,
    triangle_indices: &mut Vec<i32>,
    triangle_levels: &mut Vec<i32>,
    triangle_wall_flags: &mut Vec<i32>,
    triangle_leaf_indices: &mut Vec<i32>,
) {
    let points = terrain_remove_duplicate_mesh_points(points);
    if !terrain_polygon_has_area(&points) {
        return;
    }

    if high_key <= low_key || depth >= 64 {
        terrain_emit_region_leaf_polygon(
            c,
            &points,
            level,
            leaf_index,
            if low_key % 2 != 0 { 1 } else { 0 },
            vertex_ids,
            vertex_coords,
            vertex_heights,
            triangle_indices,
            triangle_levels,
            triangle_wall_flags,
            triangle_leaf_indices,
        );
        return;
    }

    let lower = terrain_clip_polygon_by_plateau_boundary(c, &points, low_key, true);
    let upper = terrain_clip_polygon_by_plateau_boundary(c, &points, low_key, false);
    if !terrain_polygon_has_area(&lower) || !terrain_polygon_has_area(&upper) {
        terrain_emit_region_leaf_polygon(
            c,
            &points,
            level,
            leaf_index,
            if low_key % 2 != 0 { 1 } else { 0 },
            vertex_ids,
            vertex_coords,
            vertex_heights,
            triangle_indices,
            triangle_levels,
            triangle_wall_flags,
            triangle_leaf_indices,
        );
        return;
    }

    terrain_emit_plateau_constrained_polygon(
        c,
        &lower,
        low_key,
        low_key,
        depth + 1,
        level,
        leaf_index,
        vertex_ids,
        vertex_coords,
        vertex_heights,
        triangle_indices,
        triangle_levels,
        triangle_wall_flags,
        triangle_leaf_indices,
    );
    terrain_emit_plateau_constrained_polygon(
        c,
        &upper,
        low_key + 1,
        high_key,
        depth + 1,
        level,
        leaf_index,
        vertex_ids,
        vertex_coords,
        vertex_heights,
        triangle_indices,
        triangle_levels,
        triangle_wall_flags,
        triangle_leaf_indices,
    );
}

#[inline]
pub(crate) fn terrain_edge_coordinate_for_line(line_kind: u8, vc: &[f64], vertex_id: i32) -> f64 {
    let id = vertex_id as usize;
    if line_kind == 0 {
        vc[id * 2]
    } else {
        vc[id * 2 + 1]
    }
}

pub(crate) fn terrain_add_split_vertex_for_edge(
    split_vertices_by_edge: &mut HashMap<usize, Vec<i32>>,
    vc: &[f64],
    owner: TerrainTriangleEdgeOwnerRust,
    owner_span: TerrainTriangleEdgeSpanRust,
    vertex_id: i32,
) {
    if vertex_id as usize == owner.a || vertex_id as usize == owner.b {
        return;
    }
    let coord = terrain_edge_coordinate_for_line(owner_span.line_kind, vc, vertex_id);
    if coord <= owner_span.start + TERRAIN_MESH_EDGE_EPSILON
        || coord >= owner_span.end - TERRAIN_MESH_EDGE_EPSILON
    {
        return;
    }
    let key = terrain_triangle_edge_key(owner.triangle, owner.edge);
    let entry = split_vertices_by_edge.entry(key).or_default();
    if !entry.contains(&vertex_id) {
        entry.push(vertex_id);
    }
}

pub(crate) fn terrain_collect_mesh_edge_split_vertices(
    c: &TerrainMeshBuildConfig,
    vc: &[f64],
    triangle_indices: &[i32],
) -> HashMap<usize, Vec<i32>> {
    let mut split_vertices_by_edge: HashMap<usize, Vec<i32>> = HashMap::default();
    let Some(meta) = terrain_build_mesh_edge_metadata(vc, triangle_indices, c.vertex_key_scale)
    else {
        return split_vertices_by_edge;
    };

    for owners in meta.edge_owners.values() {
        if owners.len() != 1 {
            continue;
        }
        let owner = owners[0];
        if terrain_mesh_edge_is_map_boundary(c.map_width, c.map_height, vc, owner) {
            continue;
        }
        let Some(owner_span) = meta
            .edge_spans
            .get(&terrain_triangle_edge_key(owner.triangle, owner.edge))
            .copied()
        else {
            continue;
        };

        let overlaps =
            terrain_find_overlapping_edge_spans(owner, &meta.spans_by_line, &meta.edge_spans);
        for overlap in overlaps {
            terrain_add_split_vertex_for_edge(
                &mut split_vertices_by_edge,
                vc,
                owner,
                owner_span,
                overlap.a as i32,
            );
            terrain_add_split_vertex_for_edge(
                &mut split_vertices_by_edge,
                vc,
                owner,
                owner_span,
                overlap.b as i32,
            );
        }
    }

    split_vertices_by_edge
}

pub(crate) fn terrain_sorted_split_vertices_for_triangle_edge(
    vc: &[f64],
    a: i32,
    b: i32,
    split_vertices: Option<&Vec<i32>>,
) -> Vec<i32> {
    let Some(sv) = split_vertices else {
        return Vec::new();
    };
    if sv.is_empty() {
        return Vec::new();
    }
    let (ai, bi) = (a as usize, b as usize);
    let ax = vc[ai * 2];
    let az = vc[ai * 2 + 1];
    let bx = vc[bi * 2];
    let bz = vc[bi * 2 + 1];
    let dx = bx - ax;
    let dz = bz - az;
    let len_sq = dx * dx + dz * dz;
    if len_sq <= TERRAIN_MESH_EPSILON {
        return Vec::new();
    }
    let mut out = sv.clone();
    out.sort_by(|&va, &vb| {
        let tax = vc[va as usize * 2] - ax;
        let taz = vc[va as usize * 2 + 1] - az;
        let tbx = vc[vb as usize * 2] - ax;
        let tbz = vc[vb as usize * 2 + 1] - az;
        let pa = (tax * dx + taz * dz) / len_sq;
        let pb = (tbx * dx + tbz * dz) / len_sq;
        pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

pub(crate) fn terrain_resolve_mesh_triangle_edge_splits(
    c: &TerrainMeshBuildConfig,
    vc: &[f64],
    triangle_indices: Vec<i32>,
    triangle_levels: Vec<i32>,
    triangle_wall_flags: Vec<i32>,
    triangle_leaf_indices: Vec<i32>,
) -> (Vec<i32>, Vec<i32>, Vec<i32>, Vec<i32>) {
    let mut indices = triangle_indices;
    let mut levels = triangle_levels;
    let mut wall_flags = triangle_wall_flags;
    let mut leaf_indices = triangle_leaf_indices;
    let max_iterations = terrain_triangle_hierarchy_level(c, 1) + 2;

    for _ in 0..max_iterations {
        let split_vertices_by_edge = terrain_collect_mesh_edge_split_vertices(c, vc, &indices);
        if split_vertices_by_edge.is_empty() {
            break;
        }

        let mut next_indices: Vec<i32> = Vec::new();
        let mut next_levels: Vec<i32> = Vec::new();
        let mut next_wall_flags: Vec<i32> = Vec::new();
        let mut next_leaf_indices: Vec<i32> = Vec::new();

        let tri_count = indices.len() / 3;
        for tri in 0..tri_count {
            let base = tri * 3;
            let a = indices[base];
            let b = indices[base + 1];
            let cc = indices[base + 2];
            let mut polygon: Vec<i32> = Vec::new();
            terrain_push_unique_vertex(&mut polygon, a);
            for v in terrain_sorted_split_vertices_for_triangle_edge(
                vc,
                a,
                b,
                split_vertices_by_edge.get(&base),
            ) {
                terrain_push_unique_vertex(&mut polygon, v);
            }
            terrain_push_unique_vertex(&mut polygon, b);
            for v in terrain_sorted_split_vertices_for_triangle_edge(
                vc,
                b,
                cc,
                split_vertices_by_edge.get(&(base + 1)),
            ) {
                terrain_push_unique_vertex(&mut polygon, v);
            }
            terrain_push_unique_vertex(&mut polygon, cc);
            for v in terrain_sorted_split_vertices_for_triangle_edge(
                vc,
                cc,
                a,
                split_vertices_by_edge.get(&(base + 2)),
            ) {
                terrain_push_unique_vertex(&mut polygon, v);
            }
            if polygon.len() > 1 && polygon[0] == polygon[polygon.len() - 1] {
                polygon.pop();
            }

            terrain_triangulate_convex_polygon(
                vc,
                &polygon,
                levels.get(tri).copied().unwrap_or(0),
                wall_flags.get(tri).copied().unwrap_or(0),
                leaf_indices.get(tri).copied().unwrap_or(-1),
                &mut next_indices,
                &mut next_levels,
                &mut next_wall_flags,
                &mut next_leaf_indices,
            );
        }

        indices = next_indices;
        levels = next_levels;
        wall_flags = next_wall_flags;
        leaf_indices = next_leaf_indices;
    }

    (indices, levels, wall_flags, leaf_indices)
}

pub(crate) fn terrain_build_conforming_topology(
    c: &TerrainMeshBuildConfig,
    cache: &mut TerrainMeshHeightCache,
    leaves: &[TerrainHierTri],
) -> TerrainMeshTopologyRust {
    let mut leaf_vertex_set: HashSet<(i32, i32)> = HashSet::default();
    for &leaf in leaves {
        for v in terrain_triangle_lattice_vertices(leaf) {
            leaf_vertex_set.insert(v);
        }
    }

    let mut vertex_ids: HashMap<(i64, i64), i32> = HashMap::default();
    let mut vertex_coords: Vec<f64> = Vec::new();
    let mut vertex_heights: Vec<f64> = Vec::new();
    let mut triangle_indices: Vec<i32> = Vec::new();
    let mut triangle_levels: Vec<i32> = Vec::new();
    let mut triangle_wall_flags: Vec<i32> = Vec::new();
    let mut triangle_leaf_indices: Vec<i32> = Vec::new();

    let mut boundary: Vec<(i32, i32)> = Vec::new();
    let mut polygon_pts: Vec<TerrainMeshPoint> = Vec::new();

    for (leaf_index, &leaf) in leaves.iter().enumerate() {
        let source_level = terrain_triangle_hierarchy_level(c, leaf.side);
        boundary.clear();
        terrain_triangle_boundary_lattice_points(leaf, &leaf_vertex_set, &mut boundary);
        polygon_pts.clear();
        for &(pi, pj) in &boundary {
            polygon_pts.push(terrain_lattice_point_at(c, cache, pi, pj));
        }
        let mut clipped = terrain_clip_polygon_to_map(c, &polygon_pts);
        if clipped.len() < 3 {
            continue;
        }
        if terrain_polygon_signed_area(&clipped) < 0.0 {
            clipped.reverse();
        }
        if let Some((low_key, high_key)) = terrain_plateau_key_range_for_polygon(c, &clipped) {
            terrain_emit_plateau_constrained_polygon(
                c,
                &clipped,
                low_key,
                high_key,
                0,
                source_level,
                leaf_index as i32,
                &mut vertex_ids,
                &mut vertex_coords,
                &mut vertex_heights,
                &mut triangle_indices,
                &mut triangle_levels,
                &mut triangle_wall_flags,
                &mut triangle_leaf_indices,
            );
        } else {
            terrain_emit_region_leaf_polygon(
                c,
                &clipped,
                source_level,
                leaf_index as i32,
                0,
                &mut vertex_ids,
                &mut vertex_coords,
                &mut vertex_heights,
                &mut triangle_indices,
                &mut triangle_levels,
                &mut triangle_wall_flags,
                &mut triangle_leaf_indices,
            );
        }
    }

    let (resolved_indices, resolved_levels, resolved_wall_flags, resolved_leaf_indices) =
        terrain_resolve_mesh_triangle_edge_splits(
            c,
            &vertex_coords,
            triangle_indices,
            triangle_levels,
            triangle_wall_flags,
            triangle_leaf_indices,
        );

    TerrainMeshTopologyRust {
        vertex_coords,
        vertex_heights,
        triangle_indices: resolved_indices,
        triangle_levels: resolved_levels,
        triangle_wall_flags: resolved_wall_flags,
        triangle_leaf_indices: resolved_leaf_indices,
    }
}

pub(crate) fn terrain_build_cell_triangle_index(
    cells_x: i32,
    cells_y: i32,
    cell_size: f64,
    vertex_coords: &[f64],
    triangle_indices: &[i32],
) -> Option<(Vec<i32>, Vec<i32>)> {
    if cells_x <= 0
        || cells_y <= 0
        || !cell_size.is_finite()
        || cell_size <= 0.0
        || triangle_indices.len() % 3 != 0
    {
        return None;
    }
    let cell_count = (cells_x as usize).checked_mul(cells_y as usize)?;
    let mut offsets = vec![0i32; cell_count + 1];
    let triangle_count = triangle_indices.len() / 3;
    for tri in 0..triangle_count {
        let (min_cx, max_cx, min_cy, max_cy) = terrain_triangle_cell_span(
            cells_x,
            cells_y,
            cell_size,
            vertex_coords,
            triangle_indices,
            tri,
        )?;
        for cy in min_cy..=max_cy {
            for cx in min_cx..=max_cx {
                offsets[(cy * cells_x + cx) as usize] += 1;
            }
        }
    }

    let mut total: i64 = 0;
    for offset in offsets.iter_mut().take(cell_count) {
        let count = *offset as i64;
        *offset = total as i32;
        total += count;
        if total > i32::MAX as i64 {
            return None;
        }
    }
    offsets[cell_count] = total as i32;

    let mut indices = vec![0i32; total as usize];
    let mut write_offsets = offsets[..cell_count].to_vec();
    for tri in 0..triangle_count {
        let (min_cx, max_cx, min_cy, max_cy) = terrain_triangle_cell_span(
            cells_x,
            cells_y,
            cell_size,
            vertex_coords,
            triangle_indices,
            tri,
        )?;
        for cy in min_cy..=max_cy {
            for cx in min_cx..=max_cx {
                let cell_index = (cy * cells_x + cx) as usize;
                let write = write_offsets[cell_index];
                indices[write as usize] = tri as i32;
                write_offsets[cell_index] = write + 1;
            }
        }
    }

    Some((offsets, indices))
}

pub(crate) fn terrain_finalize_conforming_topology(
    c: &TerrainMeshBuildConfig,
    topology: TerrainMeshTopologyRust,
    cells_x: i32,
    cells_y: i32,
    cell_size: f64,
) -> Option<TerrainBuiltMeshRust> {
    let mut vertex_heights = topology.vertex_heights.clone();
    terrain_smooth_mesh_vertex_heights(
        &mut vertex_heights,
        &topology.triangle_indices,
        c.smoothing_steps,
        c.smoothing_amount,
    );

    let triangle_count = topology.triangle_indices.len() / 3;
    let mut neighbor_indices = vec![-1i32; triangle_count * 3];
    let mut neighbor_levels = vec![-1i32; triangle_count * 3];
    if terrain_build_triangle_neighbor_metadata(
        c.map_width,
        c.map_height,
        c.vertex_key_scale,
        &topology.vertex_coords,
        &topology.triangle_indices,
        &topology.triangle_levels,
        &mut neighbor_indices,
        &mut neighbor_levels,
    ) == 0
    {
        return None;
    }

    let (cell_offsets, cell_indices) = terrain_build_cell_triangle_index(
        cells_x,
        cells_y,
        cell_size,
        &topology.vertex_coords,
        &topology.triangle_indices,
    )?;

    Some(TerrainBuiltMeshRust {
        vertex_coords: topology.vertex_coords,
        vertex_heights,
        triangle_indices: topology.triangle_indices,
        triangle_levels: topology.triangle_levels,
        triangle_wall_flags: topology.triangle_wall_flags,
        neighbor_indices,
        neighbor_levels,
        cell_offsets,
        cell_indices,
    })
}

pub(crate) fn terrain_find_discrepancy_splits(
    c: &TerrainMeshBuildConfig,
    leaves: &[TerrainHierTri],
    topology: &TerrainMeshTopologyRust,
) -> Option<HashSet<usize>> {
    let leaf_sides: Vec<i32> = leaves.iter().map(|l| l.side).collect();
    let mut flags = vec![0u8; leaves.len()];
    if terrain_mark_neighbor_discrepancy_leaves(
        c.map_width,
        c.map_height,
        c.vertex_key_scale,
        c.max_neighbor_level_delta,
        &leaf_sides,
        &topology.vertex_coords,
        &topology.triangle_indices,
        &topology.triangle_levels,
        &topology.triangle_leaf_indices,
        &mut flags,
    ) == 0
    {
        return None;
    }
    let mut set: HashSet<usize> = HashSet::default();
    for (i, &flag) in flags.iter().enumerate() {
        if flag != 0 {
            set.insert(i);
        }
    }
    Some(set)
}

pub(crate) fn terrain_build_validated_conforming_mesh(
    c: &TerrainMeshBuildConfig,
    cache: &mut TerrainMeshHeightCache,
    leaves: Vec<TerrainHierTri>,
    cells_x: i32,
    cells_y: i32,
    cell_size: f64,
) -> Option<TerrainBuiltMeshRust> {
    let mut repaired = leaves;
    let max_passes = terrain_triangle_hierarchy_level(c, 1) + 2;
    let bounded = max_passes.min(c.final_repair_max_passes).max(0);

    for _ in 0..bounded {
        let topology = terrain_build_conforming_topology(c, cache, &repaired);
        let splits = terrain_find_discrepancy_splits(c, &repaired, &topology)?;
        if splits.is_empty() {
            return terrain_finalize_conforming_topology(c, topology, cells_x, cells_y, cell_size);
        }
        let next = terrain_balance_triangle_leaves(
            c,
            terrain_split_triangle_leaves(c, &repaired, &splits),
        );
        if next.len() == repaired.len() {
            return terrain_finalize_conforming_topology(c, topology, cells_x, cells_y, cell_size);
        }
        repaired = next;
    }

    let topology = terrain_build_conforming_topology(c, cache, &repaired);
    terrain_finalize_conforming_topology(c, topology, cells_x, cells_y, cell_size)
}

pub(crate) fn terrain_build_adaptive_mesh_internal(
    c: &TerrainMeshBuildConfig,
    cells_x: i32,
    cells_y: i32,
    cell_size: f64,
) -> Option<TerrainBuiltMeshRust> {
    let mut cache = TerrainMeshHeightCache::default();
    let root_side = terrain_next_power_of_two(
        ((c.map_width / c.fine_edge).max(c.map_height / c.fine_height))
            .ceil()
            .max(1.0) as i64,
    ) as i32;
    let rows = (c.map_height / c.fine_height).ceil() as i32;
    let cols = (c.map_width / c.fine_edge).ceil() as i32;

    let mut leaves: Vec<TerrainHierTri> = Vec::new();
    let mut j = -root_side;
    while j <= rows + root_side {
        let mut i = -root_side * 2;
        while i <= cols + root_side * 2 {
            terrain_build_triangle_leaves(
                c,
                &mut cache,
                TerrainHierTri {
                    i,
                    j,
                    side: root_side,
                    down: false,
                },
                &mut leaves,
            );
            terrain_build_triangle_leaves(
                c,
                &mut cache,
                TerrainHierTri {
                    i,
                    j,
                    side: root_side,
                    down: true,
                },
                &mut leaves,
            );
            i += root_side;
        }
        j += root_side;
    }

    let balanced = terrain_balance_triangle_leaves(c, leaves);
    terrain_build_validated_conforming_mesh(c, &mut cache, balanced, cells_x, cells_y, cell_size)
}

/// Builds the full adaptive equilateral terrain mesh in one call and returns
/// a flat f64 buffer the TypeScript shell unpacks into a TerrainTileMap.
///
/// Layout: `[status, vertexCount, triangleCount, cellOffsetsLen, cellRefsCount,
///   vertexCoords(2V), vertexHeights(V), triangleIndices(3T), triangleLevels(T),
///   triangleWallFlags(T), neighborIndices(3T), neighborLevels(3T), cellOffsets(cellsX*cellsY+1),
///   cellIndices(R)]`. On any failure the buffer is `[0.0]`. `terrain_config`
/// is the 23-value generation slice (see metal_deposit_terrain_config_from_slice);
/// `flat_zones` is the 7-stride deposit override list (x, y, radius, height,
/// blendRadius, plateauRadius, groupId); `lod_config` packs the 10
/// triangle/repair tuning values.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn terrain_build_adaptive_mesh(
    map_width: f64,
    map_height: f64,
    cell_size: f64,
    cells_x: i32,
    cells_y: i32,
    max_subdiv: i32,
    extent_fraction: f64,
    terrain_config: &[f64],
    flat_zones: &[f64],
    lod_config: &[f64],
) -> Vec<f64> {
    let fail = vec![0.0f64];
    if !map_width.is_finite()
        || !map_height.is_finite()
        || map_width <= 0.0
        || map_height <= 0.0
        || !cell_size.is_finite()
        || cell_size <= 0.0
        || cells_x <= 0
        || cells_y <= 0
        || max_subdiv < 1
        || !extent_fraction.is_finite()
        || flat_zones.len() % METAL_DEPOSIT_FLAT_ZONE_INPUT_STRIDE != 0
        || lod_config.len() < 10
    {
        return fail;
    }
    let Some(gen_cfg) = metal_deposit_terrain_config_from_slice(terrain_config) else {
        return fail;
    };
    let metrics = terrain_make_oval_metrics(map_width, map_height, extent_fraction);
    let fine_edge = cell_size / (max_subdiv.max(1) as f64);
    let fine_height = fine_edge * TERRAIN_SQRT3_OVER_2;
    let raw_root = (map_width / fine_edge)
        .max(map_height / fine_height)
        .ceil()
        .max(1.0);
    let root_side = terrain_next_power_of_two(raw_root as i64) as i32;
    let root_level = 31 - (root_side.max(1) as u32).leading_zeros() as i32;

    let c = TerrainMeshBuildConfig {
        map_width,
        map_height,
        fine_edge,
        fine_height,
        root_level,
        metrics,
        gen_cfg,
        flat_zones: flat_zones.to_vec(),
        max_surface_error: lod_config[0],
        min_normal_dot: lod_config[1],
        max_neighbor_level_delta: lod_config[2] as i32,
        preserve_waterline: lod_config[3] != 0.0,
        sample_centroid: lod_config[4] != 0.0,
        water_level: lod_config[5],
        vertex_key_scale: lod_config[6],
        final_repair_max_passes: lod_config[7] as i32,
        smoothing_steps: lod_config[8] as i32,
        smoothing_amount: lod_config[9],
    };

    let Some(mesh) = terrain_build_adaptive_mesh_internal(&c, cells_x, cells_y, cell_size) else {
        return fail;
    };

    let v = mesh.vertex_heights.len();
    let t = mesh.triangle_indices.len() / 3;
    let cell_offsets_len = mesh.cell_offsets.len();
    let refs = mesh.cell_indices.len();
    let mut out: Vec<f64> =
        Vec::with_capacity(5 + 2 * v + v + 3 * t + t + t + 3 * t + 3 * t + cell_offsets_len + refs);
    out.push(1.0);
    out.push(v as f64);
    out.push(t as f64);
    out.push(cell_offsets_len as f64);
    out.push(refs as f64);
    for &value in &mesh.vertex_coords {
        out.push(value);
    }
    for &value in &mesh.vertex_heights {
        out.push(value);
    }
    for &value in &mesh.triangle_indices {
        out.push(value as f64);
    }
    for &value in &mesh.triangle_levels {
        out.push(value as f64);
    }
    for &value in &mesh.triangle_wall_flags {
        out.push(value as f64);
    }
    for &value in &mesh.neighbor_indices {
        out.push(value as f64);
    }
    for &value in &mesh.neighbor_levels {
        out.push(value as f64);
    }
    for &value in &mesh.cell_offsets {
        out.push(value as f64);
    }
    for &value in &mesh.cell_indices {
        out.push(value as f64);
    }
    out
}
