import Phaser from 'phaser';
import { RtsScene } from './scenes/RtsScene';

export interface GameConfig {
  parent: HTMLElement;
  width: number;
  height: number;
}

export interface GameInstance {
  game: Phaser.Game;
  getScene: () => RtsScene | null;
}

export function createGame(config: GameConfig): GameInstance {
  const phaserConfig: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: config.parent,
    width: config.width,
    height: config.height,
    backgroundColor: '#1a1a2e',
    physics: {
      default: 'matter',
      matter: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    },
    scene: [RtsScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    input: {
      mouse: {
        preventDefaultWheel: true,
        preventDefaultDown: true,
        preventDefaultUp: true,
        preventDefaultMove: false,
      },
    },
    render: {
      antialias: true,
      pixelArt: false,
    },
  };

  const game = new Phaser.Game(phaserConfig);

  return {
    game,
    getScene: () => {
      const scene = game.scene.getScene('RtsScene');
      return scene instanceof RtsScene ? scene : null;
    },
  };
}

export function destroyGame(instance: GameInstance): void {
  const scene = instance.getScene();
  if (scene) {
    scene.shutdown();
  }
  instance.game.destroy(true);
}
