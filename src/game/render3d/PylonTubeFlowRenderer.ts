// PylonTubeFlowRenderer — the resource balls that ride INSIDE a pylon's
// tube (the "straw"). Each frame the controller publishes one
// `PylonTubeFlow` per active construction-emitter pylon with the pylon's
// LIVE world-space root and tip. We place a column of evenly-spaced beads
// along that live segment and slide them up (consuming) or down
// (producing). Because the positions are recomputed every frame from the
// live endpoints, the column rides the pylon even as the construction
// tower orbits/spins — the beads are locked to the bore and can never
// escape the straw. This is the tube leg of the conduit; the free leg
// (tip -> build target, world source -> tip, converter tip -> tip arc)
// stays on the world-space SprayRenderer3D.
//
// Implementation mirrors SprayRenderer3D: ONE shared InstancedMesh of
// unit spheres drawn in a single call, with per-instance team/resource
// color + alpha on aColor / aAlpha attributes read by a tiny shader.

import * as THREE from 'three';
import type { PylonTubeFlow } from '@/types/ui';
import { disposeMesh } from './threeUtils';

/** Global cap on simultaneous tube beads across every pylon. */
const MAX_BEADS = 2048;
/** Per-tube bead cap, so a single long pylon can't eat the whole pool. */
const MAX_BEADS_PER_TUBE = 28;
/** Bead spacing along the bore, in bead radii. Spacing sets the densest
 *  the column can look at full intensity; intensity then thins it out. */
const BEAD_SPACING_MULT = 3.0;
/** Fraction of the tube length over which a bead fades in at the entry
 *  end and out at the exit end, so beads materialize/vanish cleanly
 *  rather than popping at the root/tip. */
const END_FADE_FRAC = 0.12;
const BASE_ALPHA = 0.95;

const VERTEX_SHADER = `
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

export class PylonTubeFlowRenderer {
  private root: THREE.Group;
  private geom = new THREE.SphereGeometry(1, 8, 6);
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.InstancedMesh;
  private alphaArr = new Float32Array(MAX_BEADS);
  private colorArr = new Float32Array(MAX_BEADS * 3);
  private alphaAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  private _scratchMat = new THREE.Matrix4();
  // Phase accumulator so the slide speed is frame-rate independent.
  private _time = 0;

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);

    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArr, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArr, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('aAlpha', this.alphaAttr);
    this.geom.setAttribute('aColor', this.colorAttr);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });

    this.mesh = new THREE.InstancedMesh(this.geom, this.mat, MAX_BEADS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Draw after the transparent straw walls (renderOrder defaults) and
    // the water plane so beads read clearly inside the bore.
    this.mesh.renderOrder = 6;
    this.root.add(this.mesh);
  }

  /** Per-frame update. `dtMs` advances the slide phase. */
  update(flows: readonly PylonTubeFlow[], dtMs: number): void {
    this._time += dtMs;
    const timeSec = this._time / 1000;

    let n = 0;
    for (let f = 0; f < flows.length; f++) {
      const flow = flows[f];
      if (flow.intensity <= 0.02) continue;

      const dx = flow.tip.x - flow.root.x;
      const dy = flow.tip.y - flow.root.y;
      const dz = flow.tip.z - flow.root.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-3) continue;

      const spacing = Math.max(1e-3, flow.beadRadius * BEAD_SPACING_MULT);
      const capacity = Math.min(MAX_BEADS_PER_TUBE, Math.floor(len / spacing));
      if (capacity <= 0) continue;
      const count = Math.max(1, Math.round(capacity * Math.min(1, flow.intensity)));
      const fracStep = 1 / count;

      // Slide the whole column. Fraction per second = speed / length.
      const dir = flow.up ? 1 : -1;
      let phase = ((timeSec * flow.speed) / len * dir) % 1;
      if (phase < 0) phase += 1;

      const alpha = BASE_ALPHA * Math.min(1, flow.intensity * 1.4);
      for (let k = 0; k < count; k++) {
        if (n >= MAX_BEADS) break;
        let fr = k * fracStep + phase;
        fr -= Math.floor(fr);
        const px = flow.root.x + dx * fr;
        const py = flow.root.y + dy * fr;
        const pz = flow.root.z + dz * fr;
        // Fade in/out at the two ends of the bore.
        const edge = Math.min(1, fr / END_FADE_FRAC, (1 - fr) / END_FADE_FRAC);
        this._scratchMat.makeScale(flow.beadRadius, flow.beadRadius, flow.beadRadius);
        this._scratchMat.setPosition(px, py, pz);
        this.mesh.setMatrixAt(n, this._scratchMat);
        this.colorArr[n * 3] = flow.colorRGB.r;
        this.colorArr[n * 3 + 1] = flow.colorRGB.g;
        this.colorArr[n * 3 + 2] = flow.colorRGB.b;
        this.alphaArr[n] = alpha * Math.max(0, edge);
        n++;
      }
    }

    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.clearUpdateRanges();
      this.alphaAttr.addUpdateRange(0, n);
      this.alphaAttr.needsUpdate = true;
      this.colorAttr.clearUpdateRanges();
      this.colorAttr.addUpdateRange(0, n * 3);
      this.colorAttr.needsUpdate = true;
    }
  }

  destroy(): void {
    disposeMesh(this.mesh);
    this.root.parent?.remove(this.root);
  }
}
