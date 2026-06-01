// PylonTubeFlowRenderer — resource balls riding INSIDE a pylon tube.
// The controller publishes live root/tip endpoints each frame, but the
// beads themselves are persistent particles: intensity only controls
// how often new beads are born. A live bead keeps moving until it
// reaches the root or tip, so a rate change cannot pop a half-travelled
// ball out of the bore. Outbound beads that reach the tip return a
// one-shot SprayTarget for the free leg; inbound free-leg particles call
// enqueueTipHandoff() when they reach the tip, which births exactly one
// down-tube bead.
//
// Implementation mirrors SprayRenderer3D: ONE shared InstancedMesh of
// unit spheres drawn in a single call, with per-instance team/resource
// color + alpha on aColor / aAlpha attributes read by a tiny shader.

import * as THREE from 'three';
import type { PylonTubeFlow, PylonTubeFreeLeg, SprayTarget } from '@/types/ui';
import { disposeMesh } from './threeUtils';
import { RESOURCE_CONFIG } from '@/resourceConfig';

// Resource-ball visual tuning lives in resourceConfig.json (Config Is Data).
/** Global cap on simultaneous tube beads across every pylon. */
const MAX_BEADS = RESOURCE_CONFIG.tube.maxBeads;
/** Per-tube bead cap, so a single long pylon can't eat the whole pool. */
const MAX_BEADS_PER_TUBE = RESOURCE_CONFIG.tube.maxBeadsPerTube;
/** Bead spacing along the bore, in bead radii. Used by the legacy
 *  intensity-driven birth fallback to size the densest column. */
const BEAD_SPACING_MULT = RESOURCE_CONFIG.tube.beadSpacingMult;
/** Fraction of the tube length over which a bead fades in at the entry
 *  end and out at the exit end, so beads materialize/vanish cleanly
 *  rather than popping at the root/tip. */
const END_FADE_FRAC = RESOURCE_CONFIG.tube.endFadeFrac;
const BASE_ALPHA = RESOURCE_CONFIG.tube.baseAlpha;
const MAX_BEAD_SPAWNS_PER_FLOW_FRAME = RESOURCE_CONFIG.tube.maxSpawnsPerFlowFrame;
const FLOW_RUNTIME_PRUNE_AFTER_FRAMES = RESOURCE_CONFIG.tube.runtimePruneAfterFrames;

type PylonTubeFlowRuntime = {
  key: string;
  root: { x: number; y: number; z: number };
  tip: { x: number; y: number; z: number };
  up: boolean;
  birthMode: PylonTubeFlow['birthMode'];
  intensity: number;
  ballSpawnRate?: number;
  speed: number;
  beadRadius: number;
  colorRGB: { r: number; g: number; b: number };
  freeLeg?: PylonTubeFreeLeg;
  spawnBudget: number;
  lastSeenFrame: number;
};

type PendingTubeBirths = {
  count: number;
  intensitySum: number;
};

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
  private frameIndex = 0;
  private beadCount = 0;
  private beadFlowKeys = new Array<string>(MAX_BEADS);
  private beadFrac = new Float32Array(MAX_BEADS);
  private beadDir = new Int8Array(MAX_BEADS);
  private beadAlphaScale = new Float32Array(MAX_BEADS);
  private flowRuntimes = new Map<string, PylonTubeFlowRuntime>();
  private pendingTubeBirths = new Map<string, PendingTubeBirths>();
  private handoffSprays: SprayTarget[] = [];
  private handoffSprayPool: SprayTarget[] = [];

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

  /** Called by SprayRenderer3D when an inbound free-leg particle reaches
   *  the pylon tip. The next update turns it into one down-tube bead. */
  enqueueTipHandoff(flowKey: string, intensity: number): void {
    const clamped = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 1;
    const pending = this.pendingTubeBirths.get(flowKey);
    if (pending) {
      pending.count++;
      pending.intensitySum += clamped;
    } else {
      this.pendingTubeBirths.set(flowKey, { count: 1, intensitySum: clamped });
    }
  }

  /** Per-frame update. Returns one-shot free-leg particles emitted by
   *  outbound beads that reached their pylon tip this frame. */
  update(flows: readonly PylonTubeFlow[], dtMs: number): readonly SprayTarget[] {
    this.frameIndex++;
    for (let i = 0; i < this.handoffSprays.length; i++) {
      this.handoffSprayPool.push(this.handoffSprays[i]);
    }
    this.handoffSprays.length = 0;

    const dtSec = Math.max(0, Math.min(dtMs, 100)) / 1000;
    for (let f = 0; f < flows.length; f++) {
      this.updateFlowRuntime(flows[f]);
    }
    this.spawnPendingTubeBirths();
    this.spawnRateGatedBeads(dtSec);
    this.advanceBeads(dtSec);
    let n = 0;
    for (let i = 0; i < this.beadCount; i++) {
      const runtime = this.flowRuntimes.get(this.beadFlowKeys[i]);
      if (!runtime) continue;
      const dx = runtime.tip.x - runtime.root.x;
      const dy = runtime.tip.y - runtime.root.y;
      const dz = runtime.tip.z - runtime.root.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-3) continue;
      if (n >= MAX_BEADS) break;
      const fr = Math.max(0, Math.min(1, this.beadFrac[i]));
      const px = runtime.root.x + dx * fr;
      const py = runtime.root.y + dy * fr;
      const pz = runtime.root.z + dz * fr;
      // The tip is a handoff point, not a birth/sink. Only the root
      // end fades because roots are allowed to create or consume balls.
      const rootFade = Math.min(1, fr / END_FADE_FRAC);
      this._scratchMat.makeScale(runtime.beadRadius, runtime.beadRadius, runtime.beadRadius);
      this._scratchMat.setPosition(px, py, pz);
      this.mesh.setMatrixAt(n, this._scratchMat);
      this.colorArr[n * 3] = runtime.colorRGB.r;
      this.colorArr[n * 3 + 1] = runtime.colorRGB.g;
      this.colorArr[n * 3 + 2] = runtime.colorRGB.b;
      this.alphaArr[n] = BASE_ALPHA * this.beadAlphaScale[i] * Math.max(0, rootFade);
      n++;
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
    this.pruneStaleRuntimes();
    return this.handoffSprays;
  }

  private updateFlowRuntime(flow: PylonTubeFlow): void {
    let runtime = this.flowRuntimes.get(flow.key);
    if (!runtime) {
      runtime = {
        key: flow.key,
        root: { x: 0, y: 0, z: 0 },
        tip: { x: 0, y: 0, z: 0 },
        up: flow.up,
        birthMode: flow.birthMode,
        intensity: 0,
        speed: 0,
        beadRadius: 0,
        colorRGB: { r: 0, g: 0, b: 0 },
        spawnBudget: 0,
        lastSeenFrame: this.frameIndex,
      };
      this.flowRuntimes.set(flow.key, runtime);
    }
    runtime.root.x = flow.root.x; runtime.root.y = flow.root.y; runtime.root.z = flow.root.z;
    runtime.tip.x = flow.tip.x; runtime.tip.y = flow.tip.y; runtime.tip.z = flow.tip.z;
    runtime.up = flow.up;
    runtime.birthMode = flow.birthMode;
    runtime.intensity = Math.max(0, Math.min(1, flow.intensity));
    runtime.ballSpawnRate = flow.ballSpawnRate;
    runtime.speed = flow.speed;
    runtime.beadRadius = flow.beadRadius;
    runtime.colorRGB.r = flow.colorRGB.r;
    runtime.colorRGB.g = flow.colorRGB.g;
    runtime.colorRGB.b = flow.colorRGB.b;
    runtime.freeLeg = this.copyFreeLeg(flow.freeLeg, runtime.freeLeg);
    runtime.lastSeenFrame = this.frameIndex;
  }

  private copyFreeLeg(
    source: PylonTubeFreeLeg | undefined,
    target: PylonTubeFreeLeg | undefined,
  ): PylonTubeFreeLeg | undefined {
    if (!source) return undefined;
    const out = target ?? {
      sourceId: source.sourceId,
      sourcePlayerId: source.sourcePlayerId,
      target: { id: source.target.id, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
      flow: source.flow,
      flowRadius: 0,
      channel: 0,
      speed: 0,
      particleRadius: 0,
      colorRGB: { r: 0, g: 0, b: 0 },
    };
    out.sourceId = source.sourceId;
    out.sourcePlayerId = source.sourcePlayerId;
    out.target.id = source.target.id;
    out.target.pos.x = source.target.pos.x;
    out.target.pos.y = source.target.pos.y;
    out.target.z = source.target.z;
    out.target.radius = source.target.radius;
    out.flow = source.flow;
    out.flowRadius = source.flowRadius;
    out.coneAngle = source.coneAngle;
    out.channel = source.channel;
    out.speed = source.speed;
    out.particleRadius = source.particleRadius;
    out.colorRGB.r = source.colorRGB.r;
    out.colorRGB.g = source.colorRGB.g;
    out.colorRGB.b = source.colorRGB.b;
    if (source.endColorRGB) {
      out.endColorRGB ??= { r: 0, g: 0, b: 0 };
      out.endColorRGB.r = source.endColorRGB.r;
      out.endColorRGB.g = source.endColorRGB.g;
      out.endColorRGB.b = source.endColorRGB.b;
    } else {
      out.endColorRGB = undefined;
    }
    return out;
  }

  private spawnPendingTubeBirths(): void {
    for (const [key, pending] of this.pendingTubeBirths) {
      const runtime = this.flowRuntimes.get(key);
      if (!runtime) continue;
      const alphaScale = pending.count > 0
        ? Math.max(0, Math.min(1, pending.intensitySum / pending.count))
        : 1;
      for (let i = 0; i < pending.count; i++) {
        this.spawnBead(runtime, -1, 1, alphaScale);
      }
    }
    this.pendingTubeBirths.clear();
  }

  private spawnRateGatedBeads(dtSec: number): void {
    if (dtSec <= 0) return;
    for (const runtime of this.flowRuntimes.values()) {
      const hasAbsoluteBallRate = runtime.ballSpawnRate !== undefined;
      const ballSpawnRate = hasAbsoluteBallRate && Number.isFinite(runtime.ballSpawnRate)
        ? Math.max(0, runtime.ballSpawnRate as number)
        : 0;
      if (
        runtime.lastSeenFrame !== this.frameIndex
        || runtime.birthMode !== 'rate'
        || (hasAbsoluteBallRate ? ballSpawnRate <= 0 : runtime.intensity <= 0.02)
      ) {
        continue;
      }
      const len = this.flowLength(runtime);
      if (len < 1e-3 || runtime.speed <= 0) continue;
      // Absolute-rate births: beads/second comes straight from the resource
      // transfer rate. The budget accumulator integrates it, so a rate change
      // only retunes the cadence — it never pops an in-flight bead. Falls back
      // to the legacy intensity*capacity column when no absolute rate is set.
      let birthsPerSec: number;
      if (hasAbsoluteBallRate) {
        birthsPerSec = ballSpawnRate;
      } else {
        const spacing = Math.max(1e-3, runtime.beadRadius * BEAD_SPACING_MULT);
        const capacity = Math.min(MAX_BEADS_PER_TUBE, Math.max(1, Math.floor(len / spacing)));
        birthsPerSec = (capacity * runtime.intensity * runtime.speed) / len;
      }
      runtime.spawnBudget += birthsPerSec * dtSec;
      const spawnCount = Math.min(
        MAX_BEAD_SPAWNS_PER_FLOW_FRAME,
        Math.floor(runtime.spawnBudget),
      );
      runtime.spawnBudget -= spawnCount;
      const dir = runtime.up ? 1 : -1;
      const startFrac = runtime.up ? 0 : 1;
      // Density encodes magnitude, so abs-rate beads render at full opacity;
      // the legacy fallback keeps its intensity-scaled alpha.
      const alphaScale = hasAbsoluteBallRate ? 1 : Math.min(1, runtime.intensity * 1.4);
      for (let i = 0; i < spawnCount; i++) {
        this.spawnBead(runtime, dir, startFrac, alphaScale);
      }
    }
  }

  private spawnBead(
    runtime: PylonTubeFlowRuntime,
    dir: number,
    frac: number,
    alphaScale: number,
  ): void {
    if (this.beadCount >= MAX_BEADS) return;
    const idx = this.beadCount++;
    this.beadFlowKeys[idx] = runtime.key;
    this.beadFrac[idx] = frac;
    this.beadDir[idx] = dir < 0 ? -1 : 1;
    this.beadAlphaScale[idx] = Math.max(0.08, Math.min(1, alphaScale));
  }

  private advanceBeads(dtSec: number): void {
    if (dtSec <= 0) return;
    for (let i = 0; i < this.beadCount; i++) {
      const runtime = this.flowRuntimes.get(this.beadFlowKeys[i]);
      if (!runtime) {
        this.removeBead(i);
        i--;
        continue;
      }
      const len = this.flowLength(runtime);
      if (len < 1e-3 || runtime.speed <= 0) continue;
      const dir = this.beadDir[i];
      this.beadFrac[i] += dir * (runtime.speed / len) * dtSec;
      if (dir > 0 && this.beadFrac[i] >= 1) {
        this.emitFreeLeg(runtime, this.beadAlphaScale[i]);
        this.removeBead(i);
        i--;
      } else if (dir < 0 && this.beadFrac[i] <= 0) {
        this.removeBead(i);
        i--;
      }
    }
  }

  private emitFreeLeg(runtime: PylonTubeFlowRuntime, alphaScale: number): void {
    const freeLeg = runtime.freeLeg;
    if (!freeLeg) return;
    const spray = this.acquireHandoffSpray();
    spray.source.id = freeLeg.sourceId;
    spray.source.playerId = freeLeg.sourcePlayerId;
    spray.source.pos.x = runtime.tip.x;
    spray.source.pos.y = runtime.tip.z;
    spray.source.z = runtime.tip.y;
    spray.target.id = freeLeg.target.id;
    if (freeLeg.flow === 'randomOutbound') {
      // Random/cone outbound: the spread is anchored at the TIP (the cone
      // apex), so the spray's target point is the tip; the real lock-on
      // spot drives only the cone axis below.
      spray.target.pos.x = runtime.tip.x;
      spray.target.pos.y = runtime.tip.z;
      spray.target.z = runtime.tip.y;
      spray.target.radius = freeLeg.flowRadius;
    } else {
      spray.target.pos.x = freeLeg.target.pos.x;
      spray.target.pos.y = freeLeg.target.pos.y;
      spray.target.z = freeLeg.target.z;
      spray.target.radius = freeLeg.target.radius;
    }
    spray.target.dim = undefined;
    spray.type = 'build';
    spray.intensity = Math.max(0, Math.min(1, alphaScale));
    spray.channel = freeLeg.channel;
    spray.flow = freeLeg.flow;
    spray.flowRadius = freeLeg.flowRadius;
    // Cone free leg: aim a ray from the LIVE tip at the stored lock-on
    // spot (the build target world pos) and disperse within `coneAngle`.
    // Recomputed every emit so the cone tracks the orbiting tower tip.
    if (freeLeg.coneAngle !== undefined) {
      const ax = freeLeg.target.pos.x - runtime.tip.x;          // world X
      const ay = (freeLeg.target.z ?? 0) - runtime.tip.y;       // up
      const az = freeLeg.target.pos.y - runtime.tip.z;          // world Z
      const len = Math.hypot(ax, ay, az);
      if (len > 1e-3) {
        const axis = spray.coneAxis ?? { x: 0, y: 0, z: 0 };
        axis.x = ax / len; axis.y = ay / len; axis.z = az / len;
        spray.coneAxis = axis;
        spray.coneAngle = freeLeg.coneAngle;
        spray.flowRadius = len;
      } else {
        spray.coneAngle = undefined;
      }
    } else {
      spray.coneAngle = undefined;
    }
    spray.speed = freeLeg.speed;
    spray.particleRadius = freeLeg.particleRadius;
    spray.colorRGB = freeLeg.colorRGB;
    spray.endColorRGB = freeLeg.endColorRGB;
    spray.endpointFade = 'end';
    spray.pylonTubeHandoffKey = undefined;
  }

  private acquireHandoffSpray(): SprayTarget {
    let target = this.handoffSprayPool.pop();
    if (!target) {
      target = {
        source: { id: 0, pos: { x: 0, y: 0 }, z: 0, playerId: 1 },
        target: { id: 0, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
        type: 'build',
        intensity: 0,
        channel: 0,
        flow: 'direct',
        flowRadius: 0,
      };
    }
    target.colorRGB = undefined;
    target.endColorRGB = undefined;
    target.endpointFade = undefined;
    target.pylonTubeHandoffKey = undefined;
    target.waypoint = undefined;
    target.waypoint2 = undefined;
    target.speed = undefined;
    target.particleRadius = undefined;
    // coneAxis stays as a reusable object across pool reuse; coneAngle is
    // the gate — undefined means "no cone, legacy sphere".
    target.coneAngle = undefined;
    this.handoffSprays.push(target);
    return target;
  }

  private removeBead(index: number): void {
    const last = this.beadCount - 1;
    if (index !== last) {
      this.beadFlowKeys[index] = this.beadFlowKeys[last];
      this.beadFrac[index] = this.beadFrac[last];
      this.beadDir[index] = this.beadDir[last];
      this.beadAlphaScale[index] = this.beadAlphaScale[last];
    }
    this.beadCount = last;
  }

  private flowLength(runtime: PylonTubeFlowRuntime): number {
    return Math.hypot(
      runtime.tip.x - runtime.root.x,
      runtime.tip.y - runtime.root.y,
      runtime.tip.z - runtime.root.z,
    );
  }

  private hasBeadForKey(key: string): boolean {
    for (let i = 0; i < this.beadCount; i++) {
      if (this.beadFlowKeys[i] === key) return true;
    }
    return false;
  }

  private pruneStaleRuntimes(): void {
    if (this.frameIndex % 120 !== 0) return;
    const pruneBefore = this.frameIndex - FLOW_RUNTIME_PRUNE_AFTER_FRAMES;
    for (const [key, runtime] of this.flowRuntimes) {
      if (
        runtime.lastSeenFrame < pruneBefore
        && !this.pendingTubeBirths.has(key)
        && !this.hasBeadForKey(key)
      ) {
        this.flowRuntimes.delete(key);
      }
    }
  }

  destroy(): void {
    disposeMesh(this.mesh);
    this.flowRuntimes.clear();
    this.pendingTubeBirths.clear();
    this.handoffSprays.length = 0;
    this.handoffSprayPool.length = 0;
    this.beadCount = 0;
    this.root.parent?.remove(this.root);
  }
}
