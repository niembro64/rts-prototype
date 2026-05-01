# WASM Migration Principle

For optimization work, default to asking first:

> Can this be moved to WebAssembly?

We are trying to convert performance-sensitive code to WebAssembly as we go. New or modified hot-path systems should prefer WASM when the work can be expressed as large batched numeric operations over typed arrays, especially for simulation, physics, projectile updates, terrain/water sampling, targeting, pathfinding, and serialization kernels.

TypeScript should remain the orchestration layer for UI, Three.js integration, networking glue, configuration, and gameplay control flow when moving that code would create excessive JS/WASM boundary traffic or object-marshalling cost.

