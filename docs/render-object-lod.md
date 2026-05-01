# Render Object LOD Architecture

This is the renderer rule for getting to large battles:

- Use one shared object LOD resolver for units, buildings, and future renderable objects.
- The resolver uses a full 3D render LOD grid. Each occupied grid cell is classified once per frame by testing the cell center against the camera-centered 3D spheres.
- Everything inside the same grid cell inherits that cell's LOD tier. Individual unit size, building size, projected screen radius, and gameplay activity are intentionally ignored.
- Configured distances are literal camera sphere radii, not ground-footprint radii.
- The global PLAYER CLIENT LOD tier scales the distance shells. Higher tiers push rich/detail shells farther out; lower tiers pull them closer.
- Cell size is a graphics LOD config variable. Higher tiers can use smaller cells for more precise sphere boundaries; lower tiers can use larger cells to reduce CPU churn.
- Expensive visuals flow from the resolved object LOD: rich unit meshes, building accents, metal-deposit mesh density, turrets, labels, effects, and future impostor/detail paths.
- Shell boundaries should be easy to reason about: the ring spacing is deliberately regular, and state should not silently move the boundary.

Target tiers:

- `hidden`: minimum/farthest visible representation outside the impostor shell.
- `impostor`: future low-cost billboard or marker.
- `mass`: cheap packed instanced body.
- `simple`: nearby enough for some accents but not full detail.
- `rich`: full normal detail inside the current distance shell.
- `hero`: reserved for future explicit cinematic overrides; normal gameplay rendering should not return it.

Debug shell rings draw where the four camera spheres intersect the terrain:

- `rich -> simple`
- `simple -> mass`
- `mass -> impostor`
- `impostor -> hidden/min`

Do not add separate zoom-specific, size-specific, gameplay-state, or feature-local LOD rules unless they delegate back to this resolver.
