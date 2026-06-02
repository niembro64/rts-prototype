import type { GameInstance, GameScene } from '../game/createGame';
import type { ClientViewState } from '../game/network/ClientViewState';
import type { GameConfig } from '@/types/game';

type ForegroundGameConfig = Omit<GameConfig, 'clientViewState'>;
type GameModule = typeof import('../game/createGame');

export type GameCanvasForegroundGame = {
  create(config: ForegroundGameConfig): Promise<GameInstance>;
  destroy(): void;
  getInstance(): GameInstance | null;
  getScene(): GameScene | null;
};

export function useGameCanvasForegroundGame(): GameCanvasForegroundGame {
  let gameInstance: GameInstance | null = null;
  let clientViewState: ClientViewState | null = null;
  let gameModule: GameModule | null = null;

  function destroy(): void {
    if (!gameInstance) {
      clientViewState?.clear();
      clientViewState = null;
      return;
    }
    if (gameModule === null) {
      throw new Error('Foreground game runtime missing during destroy');
    }
    gameModule.destroyGame(gameInstance);
    gameInstance = null;
    clientViewState?.clear();
    clientViewState = null;
  }

  return {
    async create(config) {
      destroy();
      const [loadedGameModule, clientViewStateModule] = await Promise.all([
        import('../game/createGame'),
        import('../game/network/ClientViewState'),
      ]);
      gameModule = loadedGameModule;
      clientViewState = new clientViewStateModule.ClientViewState();
      clientViewState.setMapDimensions(config.mapWidth, config.mapHeight);
      gameInstance = loadedGameModule.createGame({
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
