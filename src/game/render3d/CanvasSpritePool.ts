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

export type CanvasSpritePoolOptions<TState, TPaintArgs extends unknown[]> = {
  parent: THREE.Object3D;
  canvasWidth: number;
  canvasHeight: number;
  debugName: string;
  textureFilter?: 'linear' | 'nearest';
  material?: Omit<THREE.SpriteMaterialParameters, 'map'>;
  makeState: (slot: CanvasSpriteBaseSlot, index: number) => TState;
  configureSprite?: (slot: CanvasSpriteSlot<TState>, index: number) => void;
  repaint?: (slot: CanvasSpriteSlot<TState>, ...args: TPaintArgs) => boolean;
};

export class CanvasSpritePool<TState, TPaintArgs extends unknown[] = []> {
  private readonly slots: CanvasSpriteSlot<TState>[] = [];

  constructor(private readonly options: CanvasSpritePoolOptions<TState, TPaintArgs>) {}

  get length(): number {
    return this.slots.length;
  }

  acquire(index: number): CanvasSpriteSlot<TState> {
    while (this.slots.length <= index) {
      this.slots.push(this.createSlot(this.slots.length));
    }
    const slot = this.slots[index];
    slot.sprite.visible = true;
    return slot;
  }

  repaintIfChanged(slot: CanvasSpriteSlot<TState>, ...args: TPaintArgs): void {
    const repaint = this.options.repaint;
    if (repaint && repaint(slot, ...args)) {
      slot.texture.needsUpdate = true;
    }
  }

  hideUnused(used: number): void {
    for (let i = used; i < this.slots.length; i++) {
      this.slots[i].sprite.visible = false;
    }
  }

  hideAll(): void {
    this.hideUnused(0);
  }

  destroy(): void {
    for (const slot of this.slots) {
      detachObject(slot.sprite);
      slot.texture.dispose();
      disposeMaterial(slot.material);
    }
    this.slots.length = 0;
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
