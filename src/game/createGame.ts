import Phaser from 'phaser';
import { RtsScene } from './scenes/RtsScene';
import type { PlayerId } from './sim/types';
import type { GameConnection } from './server/GameConnection';
import type { GameServer } from './server/GameServer';
import { MAP_BG_COLOR, hexToStr } from '../config';

export interface GameConfig {
  parent: HTMLElement;
  width: number;
  height: number;
  playerIds?: PlayerId[];
  localPlayerId?: PlayerId;
  gameConnection: GameConnection;
  mapWidth: number;
  mapHeight: number;
  backgroundMode?: boolean;
  gameServer?: GameServer;
}

export interface GameInstance {
  game: Phaser.Game;
  getScene: () => RtsScene | null;
}

// Store config globally so scene can access it
let pendingGameConfig: {
  playerIds: PlayerId[];
  localPlayerId: PlayerId;
  gameConnection: GameConnection;
  mapWidth: number;
  mapHeight: number;
  backgroundMode: boolean;
  gameServer?: GameServer;
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
    gameConnection: config.gameConnection,
    mapWidth: config.mapWidth,
    mapHeight: config.mapHeight,
    backgroundMode: config.backgroundMode ?? false,
    gameServer: config.gameServer,
  };

  const phaserConfig: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: config.parent,
    width: config.width,
    height: config.height,
    backgroundColor: hexToStr(MAP_BG_COLOR),
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
