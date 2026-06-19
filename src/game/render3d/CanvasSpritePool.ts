import * as THREE from 'three';
import { configureSpriteTexture, detachObject, disposeMaterial } from './threeUtils';

type CanvasSpriteBaseSlot = {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
};

export type CanvasSpriteSlot<TState> = CanvasSpriteBaseSlot & {
  state: TState;
};

type CanvasSpritePoolOptions<TState, TPaintArgs extends unknown[]> = {
  parent: THREE.Object3D;
  canvasWidth: number;
  canvasHeight: number;
  debugName: string;
  textureFilter?: 'linear' | 'nearest';
  material?: Omit<THREE.SpriteMaterialParameters, 'map'>;
  maxRetainedSlots?: number;
  emptyRetainedSlots?: number;
  shrinkCooldownFrames?: number;
  shrinkBatchSize?: number;
  showOnAcquire?: boolean;
  makeState: (slot: CanvasSpriteBaseSlot, index: number) => TState;
  configureSprite?: (slot: CanvasSpriteSlot<TState>, index: number) => void;
  repaint?: (slot: CanvasSpriteSlot<TState>, ...args: TPaintArgs) => boolean;
};

export type CanvasSpritePoolTelemetry = {
  debugName: string;
  activeSlots: number;
  retainedSlots: number;
  peakRetainedSlots: number;
  createdSlots: number;
  disposedSlots: number;
  maxRetainedSlots: number | null;
  emptyRetainedSlots: number;
  shrinkCooldownFrames: number;
  idleFramesOverBudget: number;
};

export class CanvasSpritePool<TState, TPaintArgs extends unknown[] = []> {
  private readonly slots: CanvasSpriteSlot<TState>[] = [];
  private activeSlots = 0;
  private peakRetainedSlots = 0;
  private createdSlots = 0;
  private disposedSlots = 0;
  private idleFramesOverBudget = 0;

  constructor(private readonly options: CanvasSpritePoolOptions<TState, TPaintArgs>) {}

  get length(): number {
    return this.slots.length;
  }

  acquire(index: number): CanvasSpriteSlot<TState> {
    while (this.slots.length <= index) {
      const slot = this.createSlot(this.slots.length);
      this.slots.push(slot);
      this.noteSlotCreated();
    }
    if (index + 1 > this.activeSlots) this.activeSlots = index + 1;
    const slot = this.slots[index];
    if (this.options.showOnAcquire !== false && !slot.sprite.visible) {
      slot.sprite.visible = true;
    }
    return slot;
  }

  repaintIfChanged(slot: CanvasSpriteSlot<TState>, ...args: TPaintArgs): void {
    const repaint = this.options.repaint;
    if (repaint && repaint(slot, ...args)) {
      slot.texture.needsUpdate = true;
    }
  }

  hideUnused(used: number): void {
    this.hideUnusedInternal(used, false);
  }

  hideAll(): void {
    this.hideUnusedInternal(0, true);
  }

  getTelemetry(): CanvasSpritePoolTelemetry {
    return {
      debugName: this.options.debugName,
      activeSlots: this.activeSlots,
      retainedSlots: this.slots.length,
      peakRetainedSlots: this.peakRetainedSlots,
      createdSlots: this.createdSlots,
      disposedSlots: this.disposedSlots,
      maxRetainedSlots: this.options.maxRetainedSlots ?? null,
      emptyRetainedSlots: this.emptyRetainedSlots(),
      shrinkCooldownFrames: this.shrinkCooldownFrames(),
      idleFramesOverBudget: this.idleFramesOverBudget,
    };
  }

  private hideUnusedInternal(used: number, immediateShrink: boolean): void {
    const active = Math.max(0, Math.min(this.slots.length, used | 0));
    const previousActive = Math.min(this.activeSlots, this.slots.length);
    this.activeSlots = active;
    for (let i = active; i < previousActive; i++) {
      if (this.slots[i].sprite.visible) this.slots[i].sprite.visible = false;
    }
    this.shrinkUnusedTail(active, immediateShrink);
  }

  destroy(): void {
    while (this.slots.length > 0) this.disposeTailSlot();
    this.activeSlots = 0;
    this.idleFramesOverBudget = 0;
  }

  private shrinkUnusedTail(used: number, immediate: boolean): void {
    const target = this.retentionTarget(used);
    if (this.slots.length <= target) {
      this.idleFramesOverBudget = 0;
      return;
    }
    if (!immediate) {
      this.idleFramesOverBudget++;
      if (this.idleFramesOverBudget < this.shrinkCooldownFrames()) return;
    }
    const removeCount = Math.min(
      this.slots.length - target,
      immediate ? this.slots.length : this.shrinkBatchSize(),
    );
    for (let i = 0; i < removeCount; i++) this.disposeTailSlot();
  }

  private retentionTarget(used: number): number {
    const maxRetained = this.options.maxRetainedSlots;
    if (maxRetained === undefined) return this.slots.length;
    const budget = Math.max(0, maxRetained | 0);
    const target = used === 0
      ? this.emptyRetainedSlots()
      : Math.max(used, budget);
    return Math.min(this.slots.length, target);
  }

  private emptyRetainedSlots(): number {
    return Math.max(0, this.options.emptyRetainedSlots ?? 0);
  }

  private shrinkCooldownFrames(): number {
    return Math.max(1, this.options.shrinkCooldownFrames ?? 90);
  }

  private shrinkBatchSize(): number {
    return Math.max(1, this.options.shrinkBatchSize ?? 64);
  }

  private disposeTailSlot(): void {
    const slot = this.slots.pop();
    if (!slot) return;
    detachObject(slot.sprite);
    slot.texture.dispose();
    disposeMaterial(slot.material);
    this.disposedSlots++;
  }

  private noteSlotCreated(): void {
    this.createdSlots++;
    if (this.slots.length > this.peakRetainedSlots) {
      this.peakRetainedSlots = this.slots.length;
    }
  }

  private createSlot(index: number): CanvasSpriteSlot<TState> {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, this.options.canvasWidth | 0);
    canvas.height = Math.max(1, this.options.canvasHeight | 0);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(`${this.options.debugName}: 2d canvas context unavailable`);

    const texture = new THREE.CanvasTexture(canvas);
    configureSpriteTexture(texture, this.options.textureFilter);
    const material = new THREE.SpriteMaterial({
      transparent: true,
      depthTest: true,
      ...this.options.material,
      map: texture,
    });
    const sprite = new THREE.Sprite(material);
    const base = { sprite, canvas, ctx, texture, material };
    const slot: CanvasSpriteSlot<TState> = {
      ...base,
      state: this.options.makeState(base, index),
    };
    this.options.configureSprite?.(slot, index);
    this.options.parent.add(sprite);
    return slot;
  }
}
