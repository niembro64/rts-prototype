import * as THREE from 'three';

export function createRepeatingCanvasTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  repeat?: number,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  if (repeat !== undefined) texture.repeat.set(repeat, repeat);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = colorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

type WrappedCanvasItem = {
  x: number;
  y: number;
  rotation: number;
};

export function drawWrappedCanvasItem<T extends WrappedCanvasItem>(
  context: CanvasRenderingContext2D,
  item: T,
  canvasSize: number,
  halfExtent: number,
  draw: (context: CanvasRenderingContext2D, item: T) => void,
  localScaleY = 1,
): void {
  for (let offsetY = -1; offsetY <= 1; offsetY++) {
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      const centerX = item.x + offsetX * canvasSize;
      const centerY = item.y + offsetY * canvasSize;
      if (
        centerX + halfExtent < 0 ||
        centerX - halfExtent >= canvasSize ||
        centerY + halfExtent < 0 ||
        centerY - halfExtent >= canvasSize
      ) {
        continue;
      }
      context.save();
      context.translate(centerX, centerY);
      context.rotate(item.rotation);
      if (localScaleY !== 1) context.scale(1, localScaleY);
      draw(context, item);
      context.restore();
    }
  }
}
