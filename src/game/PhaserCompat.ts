// Phaser compatibility layer — allows existing render/input files to use
// Phaser-like type annotations backed by PixiJS infrastructure.
// Import this as `import Phaser from '../PhaserCompat'` to replace `import Phaser from 'phaser'`.

import type { SceneShim, KeyShim, PointerShim } from './SceneShim';
import type { IGraphics } from './render/Graphics';
import type { Viewport } from './Camera';

// Text shim type matching the subset of Phaser.GameObjects.Text we use
type TextShim = {
  setText(s: string): any;
  setPosition(x: number, y: number): any;
  setOrigin(ox: number, oy: number): any;
  setDepth(d: number): any;
  setVisible(v: boolean): any;
  setAlpha(a: number): any;
  visible: boolean;
  destroy(): void;
};

// Unified Phaser-compatible namespace + runtime object
const Phaser = {
  BlendModes: { NORMAL: 0, ADD: 1, MULTIPLY: 2, SCREEN: 3 } as const,
  Math: {
    Clamp(value: number, min: number, max: number): number {
      return Math.min(Math.max(value, min), max);
    },
  },
  Input: {
    Keyboard: {
      KeyCodes: {
        M: 77, F: 70, H: 72, B: 66, D: 68, ONE: 49, TWO: 50, ESC: 27, SHIFT: 16,
      } as const,
    },
  },
} as const;

// Augment with namespace for type-level usage
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Phaser {
  export type Scene = SceneShim;
  export namespace GameObjects {
    export type Graphics = IGraphics;
    export type Text = TextShim;
  }
  export namespace Cameras {
    export namespace Scene2D {
      export type Camera = import('./Camera').Camera;
    }
  }
  export namespace Input {
    export type Pointer = PointerShim;
    export namespace Keyboard {
      export type Key = KeyShim;
    }
  }
  export namespace Geom {
    export type Rectangle = Viewport;
  }
}

export default Phaser;
