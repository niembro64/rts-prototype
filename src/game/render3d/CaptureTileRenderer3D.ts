// CaptureTileRenderer3D — territory / flag-tile colouring for the 3D view.
//
// The 2D path draws one filled quad per captured tile on the ground, blending
// each team's primary color weighted by that team's flag height. Mixed
// ownership → mixed color. Alpha scales with the strongest flag on that tile.
//
// The 3D equivalent is a single Mesh + BufferGeometry rebuilt whenever the
// tile set changes. Each tile becomes a coloured quad on the ground plane. We
// use 4-component vertex colors (RGBA) to get per-tile alpha without a custom
// shader.

import * as THREE from 'three';
import type { PlayerId } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import { getGridOverlay, getGridOverlayIntensity } from '@/clientBarConfig';

// Slight hover above the ground to avoid z-fighting with the ground slab.
const TILE_Y = 1;

export class CaptureTileRenderer3D {
  private mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshBasicMaterial;

  private positions: Float32Array = new Float32Array(0);
  private colors: Float32Array = new Float32Array(0);
  private indices: Uint32Array = new Uint32Array(0);
  private capacity = 0;

  private clientViewState: ClientViewState;

  constructor(parentWorld: THREE.Group, clientViewState: ClientViewState) {
    this.clientViewState = clientViewState;
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.MeshBasicMaterial({
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    parentWorld.add(this.mesh);
  }

  /** Ensure our typed arrays can hold `tileCount` quads. */
  private ensureCapacity(tileCount: number): void {
    if (tileCount <= this.capacity) return;
    // Grow to next power of two to reduce churn
    let next = Math.max(32, this.capacity);
    while (next < tileCount) next *= 2;
    this.capacity = next;

    this.positions = new Float32Array(next * 4 * 3); // 4 verts per quad, xyz
    this.colors = new Float32Array(next * 4 * 4);    // 4 verts per quad, rgba
    this.indices = new Uint32Array(next * 6);        // 2 tris per quad

    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));

    // Pre-fill indices (they never change once allocated — each quad uses the
    // same 0-1-2 / 0-2-3 triangle pattern offset by 4 per quad).
    for (let i = 0; i < next; i++) {
      const v = i * 4;
      const idx = i * 6;
      this.indices[idx + 0] = v + 0;
      this.indices[idx + 1] = v + 1;
      this.indices[idx + 2] = v + 2;
      this.indices[idx + 3] = v + 0;
      this.indices[idx + 4] = v + 2;
      this.indices[idx + 5] = v + 3;
    }
    (this.geometry.index as THREE.BufferAttribute).needsUpdate = true;
  }

  update(): void {
    // Respect the user's toggle — same as the 2D path's renderCaptureOverlay
    // being gated by getGridOverlay() !== 'off'.
    if (getGridOverlay() === 'off') {
      this.mesh.visible = false;
      return;
    }

    const tiles = this.clientViewState.getCaptureTiles();
    const cellSize = this.clientViewState.getCaptureCellSize();
    if (cellSize <= 0 || tiles.length === 0) {
      this.mesh.visible = false;
      return;
    }

    this.ensureCapacity(tiles.length);
    const pos = this.positions;
    const col = this.colors;
    const intensity = getGridOverlayIntensity();

    let quadIdx = 0;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];

      // Weighted blend of team primary colors using flag heights as weights,
      // matching 2D renderCaptureOverlay exactly.
      let totalWeight = 0;
      let r = 0, g = 0, b = 0;
      let maxHeight = 0;
      for (const pidStr in tile.heights) {
        const pid = Number(pidStr) as PlayerId;
        const height = tile.heights[pid];
        if (height <= 0) continue;
        const pc = PLAYER_COLORS[pid];
        if (!pc) continue;
        const color = pc.primary;
        totalWeight += height;
        r += ((color >> 16) & 0xff) * height;
        g += ((color >> 8) & 0xff) * height;
        b += (color & 0xff) * height;
        if (height > maxHeight) maxHeight = height;
      }
      if (totalWeight <= 0) continue;

      const rN = (r / totalWeight) / 255;
      const gN = (g / totalWeight) / 255;
      const bN = (b / totalWeight) / 255;
      const alpha = intensity * maxHeight;

      const x0 = tile.cx * cellSize;
      const z0 = tile.cy * cellSize;
      const x1 = x0 + cellSize;
      const z1 = z0 + cellSize;

      const vBase = quadIdx * 4 * 3;
      // Four corners in CCW order (viewed from above): (x0,z0) (x1,z0) (x1,z1) (x0,z1)
      pos[vBase + 0] = x0; pos[vBase + 1] = TILE_Y; pos[vBase + 2] = z0;
      pos[vBase + 3] = x1; pos[vBase + 4] = TILE_Y; pos[vBase + 5] = z0;
      pos[vBase + 6] = x1; pos[vBase + 7] = TILE_Y; pos[vBase + 8] = z1;
      pos[vBase + 9] = x0; pos[vBase + 10] = TILE_Y; pos[vBase + 11] = z1;

      const cBase = quadIdx * 4 * 4;
      for (let v = 0; v < 4; v++) {
        const o = cBase + v * 4;
        col[o + 0] = rN;
        col[o + 1] = gN;
        col[o + 2] = bN;
        col[o + 3] = alpha;
      }
      quadIdx++;
    }

    if (quadIdx === 0) {
      this.mesh.visible = false;
      return;
    }

    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.setDrawRange(0, quadIdx * 6);
    this.mesh.visible = true;
  }

  destroy(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
