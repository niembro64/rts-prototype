import { createGame, destroyGame, type GameInstance, type GameScene } from '../game/createGame';
import { ClientViewState } from '../game/network/ClientViewState';
import type { GameConfig } from '@/types/game';

type ForegroundGameConfig = Omit<GameConfig, 'clientViewState'>;

export type GameCanvasForegroundGame = {
  create(config: ForegroundGameConfig): GameInstance;
  destroy(): void;
  getInstance(): GameInstance | null;
  getScene(): GameScene | null;
};

export function useGameCanvasForegroundGame(): GameCanvasForegroundGame {
  let gameInstance: GameInstance | null = null;
  let clientViewState: ClientViewState | null = null;

  function destroy(): void {
    if (!gameInstance) {
      clientViewState = null;
      return;
    }
    destroyGame(gameInstance);
    gameInstance = null;
    clientViewState = null;
  }

  return {
    create(config) {
      clientViewState = new ClientViewState();
      clientViewState.setMapDimensions(config.mapWidth, config.mapHeight);
      gameInstance = createGame({
        ...config,
        clientViewState,
      });
      return gameInstance;
    },
    destroy,
    getInstance() {
      return gameInstance;
    },
    getScene() {
      return gameInstance?.getScene() ?? null;
    },
  };
}
