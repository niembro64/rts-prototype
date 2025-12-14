import Phaser from 'phaser';
import { RtsScene } from './scenes/RtsScene';

export interface GameConfig {
  parent: HTMLElement;
  width: number;
  height: number;
}

export function createGame(config: GameConfig): Phaser.Game {
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

  return new Phaser.Game(phaserConfig);
}

export function destroyGame(game: Phaser.Game): void {
  // Shutdown all scenes first
  game.scene.getScenes(true).forEach((scene) => {
    if (scene instanceof RtsScene) {
      scene.shutdown();
    }
  });

  // Destroy the game instance
  game.destroy(true);
}
