// Phaser.Scene shim — provides the same API surface that RtsScene uses,
// backed by PixiJS. Minimizes changes to RtsScene and other files.

import { GraphicsAdapter, BlendModes } from './render/Graphics';
import { Camera } from './Camera';
import { PixiApp } from './PixiApp';
import { Text } from 'pixi.js';

// Re-export BlendModes so code using Phaser.BlendModes.ADD can import from here
export { BlendModes };

// Keyboard key wrapper matching Phaser.Input.Keyboard.Key behavior
export class KeyShim {
  isDown = false;
  private _listeners: Map<string, Set<() => void>> = new Map();

  on(event: string, callback: () => void): this {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(callback);
    return this;
  }

  removeAllListeners(): void {
    this._listeners.clear();
  }

  /** Called by InputShim when key state changes */
  _fireDown(): void {
    this.isDown = true;
    const set = this._listeners.get('down');
    if (set) for (const cb of set) cb();
  }

  _fireUp(): void {
    this.isDown = false;
  }
}

// Pointer wrapper matching Phaser.Input.Pointer
export class PointerShim {
  x = 0;
  y = 0;
  worldX = 0;
  worldY = 0;
  isDown = false;
  /** Bitmask of currently pressed buttons (bit 0 = left, 1 = right, 2 = middle) */
  private _buttons = 0;
  /** Most recent button involved in a down/up event */
  button = -1;
  /** Most recent native pointer event (for accessing shiftKey, etc.) */
  event: PointerEvent = null as any;

  leftButtonDown(): boolean { return (this._buttons & 1) !== 0; }
  middleButtonDown(): boolean { return (this._buttons & 4) !== 0; }
  rightButtonDown(): boolean { return (this._buttons & 2) !== 0; }

  /** Called on pointerdown */
  _down(screenX: number, screenY: number, nativeButton: number, buttons: number, nativeEvent?: PointerEvent): void {
    this.x = screenX;
    this.y = screenY;
    this.button = nativeButton;
    this._buttons = buttons;
    this.isDown = true;
    if (nativeEvent) this.event = nativeEvent;
  }

  /** Called on pointerup */
  _up(screenX: number, screenY: number, nativeButton: number, buttons: number, nativeEvent?: PointerEvent): void {
    this.x = screenX;
    this.y = screenY;
    this.button = nativeButton;
    this._buttons = buttons;
    this.isDown = this._buttons !== 0;
    if (nativeEvent) this.event = nativeEvent;
  }

  /** Called on pointermove */
  _move(screenX: number, screenY: number, buttons: number, nativeEvent?: PointerEvent): void {
    this.x = screenX;
    this.y = screenY;
    this._buttons = buttons;
    this.isDown = this._buttons !== 0;
    if (nativeEvent) this.event = nativeEvent;
  }
}

// Input system shim
export class InputShim {
  activePointer = new PointerShim();
  keyboard: KeyboardShim | null;

  private _listeners: Map<string, Set<Function>> = new Map();
  private _onceListeners: Map<string, Set<Function>> = new Map();
  _canvas: HTMLCanvasElement;
  _camera: Camera;
  private _keys: Map<string, KeyShim> = new Map();

  constructor(canvas: HTMLCanvasElement, camera: Camera) {
    this._canvas = canvas;
    this._camera = camera;
    this.keyboard = new KeyboardShim(this._keys);

    // Prevent context menu
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Pointer events — use e.buttons bitmask for multi-button tracking
    canvas.addEventListener('pointerdown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.activePointer._down(sx, sy, e.button, e.buttons, e);
      this._fire('pointerdown', this.activePointer, e);
    });

    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.activePointer._move(sx, sy, e.buttons, e);
      this._fire('pointermove', this.activePointer, e);
    });

    canvas.addEventListener('pointerup', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.activePointer._up(sx, sy, e.button, e.buttons, e);
      this._fire('pointerup', this.activePointer, e);
    });

    // Wheel — update pointer position from wheel event coordinates
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this.activePointer.x = e.clientX - rect.left;
      this.activePointer.y = e.clientY - rect.top;
      this._fire('wheel', this.activePointer, null, e.deltaX, e.deltaY, e.deltaZ);
    }, { passive: false });

    // Keyboard
    window.addEventListener('keydown', (e) => {
      const key = this._keys.get(e.code);
      if (key) key._fireDown();
      // Fire keydown-{KEY} events (e.g., keydown-R)
      this._fire(`keydown-${e.key.toUpperCase()}`, e);
    });

    window.addEventListener('keyup', (e) => {
      const key = this._keys.get(e.code);
      if (key) key._fireUp();
    });
  }

  on(event: string, callback: Function): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(callback);
  }

  once(event: string, callback: Function): void {
    let set = this._onceListeners.get(event);
    if (!set) {
      set = new Set();
      this._onceListeners.set(event, set);
    }
    set.add(callback);
  }

  off(event: string, callback?: Function): void {
    if (callback) {
      this._listeners.get(event)?.delete(callback);
      this._onceListeners.get(event)?.delete(callback);
    } else {
      this._listeners.delete(event);
      this._onceListeners.delete(event);
    }
  }

  private _fire(event: string, ...args: any[]): void {
    const set = this._listeners.get(event);
    if (set) for (const cb of set) cb(...args);
    const onceSet = this._onceListeners.get(event);
    if (onceSet) {
      for (const cb of onceSet) cb(...args);
      onceSet.clear();
    }
  }
}

// Keyboard shim
export class KeyboardShim {
  private _keys: Map<string, KeyShim>;
  constructor(keys: Map<string, KeyShim>) {
    this._keys = keys;
  }

  addKey(keyCode: number | string): KeyShim {
    const code = typeof keyCode === 'number' ? KEY_CODE_MAP[keyCode] ?? '' : keyCode;
    let key = this._keys.get(code);
    if (!key) {
      key = new KeyShim();
      this._keys.set(code, key);
    }
    return key;
  }

  once(event: string, callback: () => void): void {
    // Handle keyboard.once('keydown-R', ...) pattern
    const handler = (e: KeyboardEvent) => {
      const suffix = event.replace('keydown-', '');
      if (e.key.toUpperCase() === suffix) {
        callback();
        window.removeEventListener('keydown', handler);
      }
    };
    window.addEventListener('keydown', handler);
  }
}

// Map Phaser KeyCodes to DOM event.code strings
const KEY_CODE_MAP: Record<number, string> = {
  77: 'KeyM',    // M
  70: 'KeyF',    // F
  72: 'KeyH',    // H
  66: 'KeyB',    // B
  68: 'KeyD',    // D
  49: 'Digit1',  // ONE
  50: 'Digit2',  // TWO
  27: 'Escape',  // ESC
  16: 'ShiftLeft', // SHIFT
};

// KeyCodes matching Phaser.Input.Keyboard.KeyCodes
export const KeyCodes = {
  M: 77,
  F: 70,
  H: 72,
  B: 66,
  D: 68,
  ONE: 49,
  TWO: 50,
  ESC: 27,
  SHIFT: 16,
} as const;

// Events shim (for scene lifecycle events)
class EventsShim {
  private _once: Map<string, Set<Function>> = new Map();

  once(event: string, callback: Function, _context?: any): void {
    let set = this._once.get(event);
    if (!set) {
      set = new Set();
      this._once.set(event, set);
    }
    set.add(callback);
  }

  emit(event: string): void {
    const set = this._once.get(event);
    if (set) {
      for (const cb of set) cb();
      set.clear();
    }
  }
}

// CameraManager shim (this.cameras.main)
class CameraManagerShim {
  main: Camera;
  constructor(camera: Camera) {
    this.main = camera;
  }
}

// Scene shim — Phaser.Scene-like base class backed by PixiJS
class SceneManagerShim {
  private _restartCallback?: () => void;
  onRestart(cb: () => void): void { this._restartCallback = cb; }
  restart(): void { this._restartCallback?.(); }
}

/**
 * Base class that provides Phaser.Scene-compatible API backed by PixiJS.
 * RtsScene extends this instead of Phaser.Scene.
 */
export class SceneShim {
  cameras!: CameraManagerShim;
  input!: InputShim;
  events = new EventsShim();
  scene = new SceneManagerShim();
  game!: { canvas: HTMLCanvasElement; destroy: (removeCanvas: boolean) => void };

  protected pixiApp!: PixiApp;
  private _graphicsObjects: GraphicsAdapter[] = [];

  /** Called by PixiApp after construction. */
  _init(app: PixiApp): void {
    this.pixiApp = app;
    this.cameras = new CameraManagerShim(app.camera);
    this.input = new InputShim(app.canvas, app.camera);
    this.game = {
      canvas: app.canvas,
      destroy: (_removeCanvas: boolean) => app.destroy(),
    };
  }

  /** Phaser-compatible: create a new Graphics object added to the world. */
  get add() {
    const self = this;
    return {
      graphics(): GraphicsAdapter {
        const g = new GraphicsAdapter(self.pixiApp.world, self.pixiApp.hud);
        self.pixiApp.world.addChild(g.pixi);
        self._graphicsObjects.push(g);
        return g;
      },
      text(x: number, y: number, text: string, style?: any): any {
        const t = new Text(text, {
          fontFamily: style?.fontFamily ?? 'monospace',
          fontSize: style?.fontSize ?? 12,
          fill: style?.color ?? '#ffffff',
        });
        t.position.set(x, y);
        self.pixiApp.world.addChild(t);
        return {
          _pixiText: t,
          setText(s: string) { t.text = s; return this; },
          setPosition(nx: number, ny: number) { t.position.set(nx, ny); return this; },
          setOrigin(ox: number, oy: number) { t.anchor?.set(ox, oy); return this; },
          setDepth(_d: number) { return this; },
          setVisible(v: boolean) { t.visible = v; return this; },
          setAlpha(a: number) { t.alpha = a; return this; },
          visible: true,
          destroy() { t.destroy(); },
        };
      },
    };
  }

  /** Lifecycle methods — overridden by subclass. */
  create(): void {}
  shutdown(): void {
    this.events.emit('shutdown');
    for (const g of this._graphicsObjects) {
      g.destroy();
    }
    this._graphicsObjects.length = 0;
  }
}
