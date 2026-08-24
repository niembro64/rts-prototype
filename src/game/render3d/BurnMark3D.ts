// BurnMark3D — accumulated, terrain-oriented scorch cells.
//
// A beam deposits heat and char into a fixed world grid. Repeated stationary
// hits strengthen the same cell; moving endpoints sample the swept interval
// into adjacent cells. Each occupied cell is one instanced disc. Its hot and
// residue decay happen in the shader from last-hit time, so the CPU updates
// only cells that receive energy (plus an infrequent expiry sweep).

import * as THREE from 'three';
import { bindBurnDecayAttributes } from './instancedBufferUpdate';
import type { Entity } from '../sim/types';
import { COLORS } from '@/colorsConfig';
import { getGraphicsConfig, getBurnMarks } from '@/clientBarConfig';
import type { ViewportFootprint } from '../ViewportFootprint';
import { BURN_COLOR_TAU, BURN_COOL_TAU } from '../../config';
import { disposeMesh } from './threeUtils';
import { createPrimitiveCircleGeometry } from './PrimitiveGeometryQuality3D';
import { applyExposureToRawShader } from './RenderLighting3D';
import {
  clearDirtySlotSpan,
  createDirtySlotSpan,
  markDirtySlot,
  uploadDirtySlotSpan,
} from './instancedBufferUpdate';
import { clamp01 } from '../math';

const MARK_LIFT = 2.5;
const MAX_SCORCH_CELLS = 5000;
const SCORCH_CELL_SIZE = 4;
const GROUND_HIT_Z_TOLERANCE = 4;
const DENSITY_EMA_TAU_MS = 300;
const SCORCH_PRUNE_INTERVAL_MS = 500;
const SCORCH_FADE_FLOOR = 0.008;
const MAX_SWEEP_SAMPLES_PER_PROJECTILE = 32;
const MAX_QUEUED_DAMAGE_SCORCHES = 512;

const COOL_LIN = new THREE.Color(COLORS.world.burnMark.coolResidueColorHex);
const HOT_LIN = new THREE.Color(0xff4a08);

const SCORCH_VERTEX_SHADER = /* glsl */`
  attribute float aLastHitSec;
  attribute float aHeat;
  attribute float aChar;
  attribute float aSeed;
  varying vec2 vLocal;
  varying float vLastHitSec;
  varying float vHeat;
  varying float vChar;
  varying float vSeed;

  void main() {
    vLocal = position.xy;
    vLastHitSec = aLastHitSec;
    vHeat = aHeat;
    vChar = aChar;
    vSeed = aSeed;
    vec4 worldPosition = instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * worldPosition;
  }
`;

const SCORCH_FRAGMENT_SHADER = /* glsl */`
  uniform float uTimeSec;
  uniform float uHotTauSec;
  uniform float uResidueTauSec;
  uniform vec3 uHotColor;
  uniform vec3 uCoolColor;
  varying vec2 vLocal;
  varying float vLastHitSec;
  varying float vHeat;
  varying float vChar;
  varying float vSeed;

  void main() {
    float age = max(0.0, uTimeSec - vLastHitSec);
    float hot = vHeat * exp(-age / max(0.001, uHotTauSec));
    float residue = vChar * exp(-age / max(0.001, uResidueTauSec));
    float r = length(vLocal);
    float angle = atan(vLocal.y, vLocal.x);
    float edge = 0.80
      + 0.09 * sin(angle * 5.0 + vSeed * 23.0)
      + 0.06 * sin(angle * 11.0 - vSeed * 17.0);
    float edgeAlpha = 1.0 - smoothstep(edge - 0.16, edge, r);
    float mottling = 0.78 + 0.22 * sin(
      vLocal.x * 13.0 + vLocal.y * 9.0 + vSeed * 41.0
    );
    float hotCore = hot * (1.0 - smoothstep(0.05, 0.72, r));
    vec3 color = mix(uCoolColor * mottling, uHotColor, clamp(hotCore, 0.0, 1.0));
    float alpha = edgeAlpha * clamp(residue * 0.66 + hotCore * 0.82, 0.0, 0.92);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

type BeamStateKey = number | string;
const BEAM_KEY_TURRET_STRIDE = 1024;

function beamStateKey(sourceEntityId: number, turretIndex: number): BeamStateKey {
  if (
    turretIndex >= 0 &&
    turretIndex < BEAM_KEY_TURRET_STRIDE &&
    Number.isSafeInteger(sourceEntityId)
  ) {
    return sourceEntityId * BEAM_KEY_TURRET_STRIDE + turretIndex;
  }
  return `${sourceEntityId}:${turretIndex}`;
}

export function scorchCellKey(
  x: number,
  y: number,
  cellSize: number = SCORCH_CELL_SIZE,
): number | string {
  const inv = 1 / Math.max(0.001, cellSize);
  const ix = Math.floor(x * inv);
  const iy = Math.floor(y * inv);
  // 2^26 keeps the packed pair below Number.MAX_SAFE_INTEGER while still
  // covering ±33 million cells on each axis before the string fallback.
  const base = 67108864;
  const offset = base / 2;
  if (ix >= -offset && ix < offset && iy >= -offset && iy < offset) {
    return (ix + offset) * base + iy + offset;
  }
  return `${ix}:${iy}`;
}

type BeamState = {
  lastEndX: number;
  lastEndY: number;
};

type ScorchCell = {
  key: number | string;
  slot: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  heat: number;
  char: number;
  lastHitSec: number;
  seed: number;
};

type PendingDamageScorch = {
  x: number;
  y: number;
  width: number;
  energy: number;
};

function hashCell(key: number | string): number {
  if (typeof key === 'number') {
    let numericHash = (key % 0x100000000) | 0;
    numericHash ^= numericHash >>> 16;
    numericHash = Math.imul(numericHash, 0x45d9f3b);
    numericHash ^= numericHash >>> 16;
    return (numericHash >>> 0) / 0x100000000;
  }
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

export class BurnMark3D {
  private readonly root = new THREE.Group();
  private readonly geometry = createPrimitiveCircleGeometry('beam', 'mid', 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.InstancedMesh;
  private readonly lastHit = new Float32Array(MAX_SCORCH_CELLS);
  private readonly heat = new Float32Array(MAX_SCORCH_CELLS);
  private readonly char = new Float32Array(MAX_SCORCH_CELLS);
  private readonly seed = new Float32Array(MAX_SCORCH_CELLS);
  private readonly lastHitAttr: THREE.InstancedBufferAttribute;
  private readonly heatAttr: THREE.InstancedBufferAttribute;
  private readonly charAttr: THREE.InstancedBufferAttribute;
  private readonly seedAttr: THREE.InstancedBufferAttribute;
  private readonly matrixDirty = createDirtySlotSpan();
  private readonly lastHitDirty = createDirtySlotSpan();
  private readonly heatDirty = createDirtySlotSpan();
  private readonly charDirty = createDirtySlotSpan();
  private readonly seedDirty = createDirtySlotSpan();
  private readonly cells: ScorchCell[] = [];
  private readonly cellByKey = new Map<number | string, ScorchCell>();
  private readonly pendingDamageScorches: PendingDamageScorch[] = [];
  private readonly beams = new Map<BeamStateKey, BeamState>();
  private readonly seenBeamKeys = new Set<BeamStateKey>();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly localNormal = new THREE.Vector3(0, 0, 1);
  private readonly worldNormal = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private timeSec = 0;
  private pruneAccumMs = 0;
  private smoothedDensity = -1;
  private currentCap = MAX_SCORCH_CELLS;

  constructor(
    parentWorld: THREE.Group,
    private readonly scope: ViewportFootprint | null = null,
    private readonly getGroundZ: (x: number, y: number) => number = () => 0,
    private readonly getGroundNormal?: (
      x: number,
      y: number,
    ) => { nx: number; ny: number; nz: number },
  ) {
    parentWorld.add(this.root);
    const burnAttrs = bindBurnDecayAttributes(this.geometry, {
      lastHit: this.lastHit,
      heat: this.heat,
      char: this.char,
      seed: this.seed,
    });
    this.lastHitAttr = burnAttrs.lastHitAttr;
    this.heatAttr = burnAttrs.heatAttr;
    this.charAttr = burnAttrs.charAttr;
    this.seedAttr = burnAttrs.seedAttr;
    this.material = new THREE.ShaderMaterial({
      vertexShader: SCORCH_VERTEX_SHADER,
      fragmentShader: SCORCH_FRAGMENT_SHADER,
      uniforms: {
        uTimeSec: { value: 0 },
        uHotTauSec: { value: Math.max(0.001, BURN_COLOR_TAU / 1000) },
        uResidueTauSec: { value: Math.max(0.001, BURN_COOL_TAU / 1000) },
        uHotColor: { value: HOT_LIN },
        uCoolColor: { value: COOL_LIN },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    applyExposureToRawShader(this.material);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_SCORCH_CELLS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.root.add(this.mesh);
  }

  /** Queue a one-shot terrain scorch from the shared damage-impact pipeline.
   *  It is deposited during update so it shares this renderer's density cap,
   *  LRU consolidation, decay constants, and single upload batch. */
  depositDamageImpact(x: number, y: number, width: number, energy: number): void {
    if (this.pendingDamageScorches.length >= MAX_QUEUED_DAMAGE_SCORCHES) return;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(energy) ||
      width <= 0 ||
      energy <= 0
    ) return;
    this.pendingDamageScorches.push({ x, y, width, energy });
  }

  update(projectiles: readonly Entity[], dtMs: number): void {
    const clampedDtMs = Math.min(250, Math.max(0, dtMs));
    const dtSec = clampedDtMs / 1000;
    this.timeSec += dtSec;
    this.material.uniforms.uTimeSec.value = this.timeSec;

    if (!getBurnMarks()) {
      this.clear();
      return;
    }

    const densityTarget = clamp01(getGraphicsConfig().burnMarkDensity ?? 1);
    if (this.smoothedDensity < 0) {
      this.smoothedDensity = densityTarget;
    } else {
      const ema = 1 - Math.exp(-clampedDtMs / DENSITY_EMA_TAU_MS);
      this.smoothedDensity += (densityTarget - this.smoothedDensity) * ema;
    }
    const density = this.smoothedDensity;
    this.currentCap = Math.min(MAX_SCORCH_CELLS, Math.round(MAX_SCORCH_CELLS * density));
    const lifeMultiplier = 0.5 + density * 0.5;
    this.material.uniforms.uHotTauSec.value =
      Math.max(0.001, BURN_COLOR_TAU * lifeMultiplier / 1000);
    this.material.uniforms.uResidueTauSec.value =
      Math.max(0.001, BURN_COOL_TAU * lifeMultiplier / 1000);

    if (this.currentCap <= 0) {
      this.clear();
      return;
    }

    for (let i = 0; i < this.pendingDamageScorches.length; i++) {
      const scorch = this.pendingDamageScorches[i];
      this.depositAt(scorch.x, scorch.y, scorch.width, scorch.energy);
    }
    this.pendingDamageScorches.length = 0;

    this.seenBeamKeys.clear();
    for (let i = 0; i < projectiles.length; i++) {
      const entity = projectiles[i];
      const projectile = entity.projectile;
      if (!projectile) continue;
      const isDGun = entity.dgunProjectile?.isDGun === true &&
        projectile.projectileType === 'projectile';
      const isRay = projectile.projectileType === 'beam';
      if (!isDGun && !isRay) continue;
      if (isRay && projectile.endpointDamageable === false) continue;

      const key: BeamStateKey = isDGun
        ? `dgun:${entity.id}`
        : beamStateKey(projectile.sourceEntityId, projectile.config.turretIndex ?? 0);
      this.seenBeamKeys.add(key);
      const end = projectile.points && projectile.points.length >= 2
        ? projectile.points[projectile.points.length - 1]
        : undefined;
      const endX = isDGun ? entity.transform.x : (end?.x ?? entity.transform.x);
      const endY = isDGun ? entity.transform.y : (end?.y ?? entity.transform.y);
      if (this.scope && !this.scope.inScope(endX, endY, 200)) continue;
      const groundZ = this.getGroundZ(endX, endY);
      if (!isDGun) {
        const endZ = end?.z ?? 0;
        const tolerance = Math.max(
          GROUND_HIT_Z_TOLERANCE,
          projectile.config.shotProfile.visual.lineRadius,
        );
        if (Math.abs(endZ - groundZ) > tolerance) {
          this.beams.delete(key);
          continue;
        }
      }

      const visual = projectile.config.shotProfile.visual;
      const width = Math.max(4, visual.burnMarkWidth || visual.lineRadius * 2);
      const damageRadius = Math.max(width, visual.lineDamageSphereRadius);
      const shot = projectile.config.shot;
      const dps = isRay && shot.type === 'beam'
        ? Math.max(0, shot.dps)
        : 180;
      const deposit = Math.max(0.012, dps * dtSec / Math.max(6, damageRadius));
      let state = this.beams.get(key);
      if (!state) {
        state = { lastEndX: endX, lastEndY: endY };
        this.beams.set(key, state);
        this.depositAt(endX, endY, width, deposit);
        continue;
      }
      this.depositSweep(state.lastEndX, state.lastEndY, endX, endY, width, deposit);
      state.lastEndX = endX;
      state.lastEndY = endY;
    }

    for (const [key] of this.beams) {
      if (!this.seenBeamKeys.has(key)) this.beams.delete(key);
    }

    while (this.cells.length > this.currentCap) this.removeOldestCell();
    this.pruneAccumMs += clampedDtMs;
    if (this.pruneAccumMs >= SCORCH_PRUNE_INTERVAL_MS) {
      this.pruneAccumMs %= SCORCH_PRUNE_INTERVAL_MS;
      this.pruneExpiredCells();
    }
    this.uploadChanges();
  }

  private depositSweep(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    width: number,
    deposit: number,
  ): void {
    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.sqrt(dx * dx + dy * dy);
    const samples = Math.min(
      MAX_SWEEP_SAMPLES_PER_PROJECTILE,
      Math.max(1, Math.ceil(length / (SCORCH_CELL_SIZE * 0.75))),
    );
    const perSampleDeposit = deposit / samples;
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      this.depositAt(startX + dx * t, startY + dy * t, width, perSampleDeposit);
    }
  }

  private depositAt(x: number, y: number, width: number, deposit: number): void {
    const key = scorchCellKey(x, y);
    let cell = this.cellByKey.get(key);
    if (!cell) {
      if (this.cells.length >= this.currentCap || this.cells.length >= MAX_SCORCH_CELLS) {
        this.removeOldestCell();
      }
      const groundZ = this.getGroundZ(x, y);
      cell = {
        key,
        slot: this.cells.length,
        x,
        y,
        z: groundZ + MARK_LIFT,
        radius: Math.max(SCORCH_CELL_SIZE * 0.8, width * 0.56),
        heat: 0,
        char: 0,
        lastHitSec: this.timeSec,
        seed: hashCell(key),
      };
      this.cells.push(cell);
      this.cellByKey.set(key, cell);
      this.writeMatrix(cell);
      this.seed[cell.slot] = cell.seed;
      markDirtySlot(this.seedDirty, cell.slot);
    } else {
      // Refresh insertion order: cellByKey doubles as the bounded LRU queue.
      this.cellByKey.delete(key);
      this.cellByKey.set(key, cell);
    }

    const age = Math.max(0, this.timeSec - cell.lastHitSec);
    const hotTau = Math.max(0.001, this.material.uniforms.uHotTauSec.value as number);
    const residueTau = Math.max(0.001, this.material.uniforms.uResidueTauSec.value as number);
    cell.heat = Math.min(1, cell.heat * Math.exp(-age / hotTau) + deposit * 0.36);
    cell.char = Math.min(1, cell.char * Math.exp(-age / residueTau) + deposit * 0.085);
    const radius = Math.max(cell.radius, width * 0.56);
    if (radius !== cell.radius) {
      cell.radius = radius;
      this.writeMatrix(cell);
    }
    cell.lastHitSec = this.timeSec;
    this.writeThermalAttributes(cell);
  }

  private writeMatrix(cell: ScorchCell): void {
    const normal = this.getGroundNormal?.(cell.x, cell.y);
    this.worldNormal.set(normal?.nx ?? 0, normal?.nz ?? 1, normal?.ny ?? 0).normalize();
    this.quaternion.setFromUnitVectors(this.localNormal, this.worldNormal);
    this.position.set(cell.x, cell.z, cell.y);
    this.scale.set(cell.radius, cell.radius, 1);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.mesh.setMatrixAt(cell.slot, this.matrix);
    markDirtySlot(this.matrixDirty, cell.slot);
  }

  private writeThermalAttributes(cell: ScorchCell): void {
    const slot = cell.slot;
    this.lastHit[slot] = cell.lastHitSec;
    this.heat[slot] = cell.heat;
    this.char[slot] = cell.char;
    markDirtySlot(this.lastHitDirty, slot);
    markDirtySlot(this.heatDirty, slot);
    markDirtySlot(this.charDirty, slot);
  }

  private pruneExpiredCells(): void {
    const hotTau = Math.max(0.001, this.material.uniforms.uHotTauSec.value as number);
    const residueTau = Math.max(0.001, this.material.uniforms.uResidueTauSec.value as number);
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const cell = this.cells[i];
      const age = Math.max(0, this.timeSec - cell.lastHitSec);
      const heat = cell.heat * Math.exp(-age / hotTau);
      const char = cell.char * Math.exp(-age / residueTau);
      if (Math.max(heat, char) < SCORCH_FADE_FLOOR) this.removeCellAt(i);
    }
  }

  private removeOldestCell(): void {
    const oldest = this.cellByKey.values().next();
    if (!oldest.done) this.removeCellAt(oldest.value.slot);
  }

  private removeCellAt(slot: number): void {
    const last = this.cells.length - 1;
    const removed = this.cells[slot];
    this.cellByKey.delete(removed.key);
    if (slot !== last) {
      const moved = this.cells[last];
      moved.slot = slot;
      this.cells[slot] = moved;
      this.cellByKey.set(moved.key, moved);
      const matrices = this.mesh.instanceMatrix.array as Float32Array;
      matrices.copyWithin(slot * 16, last * 16, last * 16 + 16);
      this.lastHit[slot] = this.lastHit[last];
      this.heat[slot] = this.heat[last];
      this.char[slot] = this.char[last];
      this.seed[slot] = this.seed[last];
      markDirtySlot(this.matrixDirty, slot);
      markDirtySlot(this.lastHitDirty, slot);
      markDirtySlot(this.heatDirty, slot);
      markDirtySlot(this.charDirty, slot);
      markDirtySlot(this.seedDirty, slot);
    }
    this.cells.pop();
    this.mesh.count = this.cells.length;
  }

  private uploadChanges(): void {
    this.mesh.count = this.cells.length;
    uploadDirtySlotSpan(this.mesh.instanceMatrix, this.matrixDirty, 16, this.cells.length);
    uploadDirtySlotSpan(this.lastHitAttr, this.lastHitDirty, 1, this.cells.length);
    uploadDirtySlotSpan(this.heatAttr, this.heatDirty, 1, this.cells.length);
    uploadDirtySlotSpan(this.charAttr, this.charDirty, 1, this.cells.length);
    uploadDirtySlotSpan(this.seedAttr, this.seedDirty, 1, this.cells.length);
  }

  private clear(): void {
    this.cells.length = 0;
    this.cellByKey.clear();
    this.pendingDamageScorches.length = 0;
    this.beams.clear();
    this.seenBeamKeys.clear();
    this.mesh.count = 0;
    this.pruneAccumMs = 0;
    this.smoothedDensity = -1;
    clearDirtySlotSpan(this.matrixDirty);
    clearDirtySlotSpan(this.lastHitDirty);
    clearDirtySlotSpan(this.heatDirty);
    clearDirtySlotSpan(this.charDirty);
    clearDirtySlotSpan(this.seedDirty);
  }

  destroy(): void {
    this.clear();
    disposeMesh(this.mesh);
    this.root.parent?.remove(this.root);
  }
}
