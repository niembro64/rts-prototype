import Phaser from 'phaser';
import { RtsScene } from './scenes/RtsScene';
import type { PlayerId } from './sim/types';
import type { NetworkRole } from './network/NetworkManager';

export interface GameConfig {
  parent: HTMLElement;
  width: number;
  height: number;
  playerIds?: PlayerId[];
  localPlayerId?: PlayerId;
  networkRole?: NetworkRole;
  backgroundMode?: boolean;
}

export interface GameInstance {
  game: Phaser.Game;
  getScene: () => RtsScene | null;
}

// Store config globally so scene can access it
let pendingGameConfig: {
  playerIds: PlayerId[];
  localPlayerId: PlayerId;
  networkRole: NetworkRole;
  backgroundMode: boolean;
} | null = null;

export function getPendingGameConfig() {
  return pendingGameConfig;
}

export function clearPendingGameConfig() {
  pendingGameConfig = null;
}

export function createGame(config: GameConfig): GameInstance {
  // Store config for scene to pick up
  pendingGameConfig = {
    playerIds: config.playerIds ?? [1, 2],
    localPlayerId: config.localPlayerId ?? 1,
    networkRole: config.networkRole ?? 'offline',
    backgroundMode: config.backgroundMode ?? false,
  };

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
