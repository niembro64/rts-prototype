// createGame3D — minimal 3D PoC entry point.
//
// Mirrors createGame.ts but uses Three.js to render the game. Server sim code is
// untouched: we consume the same GameConnection + ClientViewState pipeline and
// just draw extruded primitives instead of Pixi sprites.
//
// Scope: view-only. No selection, no commands, no HUD. Watches a background
// battle (or any other LocalGameConnection) and renders it in 3D.

import { ThreeApp } from './render3d/ThreeApp';
import { Render3DEntities } from './render3d/Render3DEntities';
import { ClientViewState } from './network/ClientViewState';
import { SnapshotBuffer } from './scenes/helpers/SnapshotBuffer';
import type { GameConnection } from './server/GameConnection';
import { MAP_BG_COLOR, hexToStr } from '../config';

export type Game3DConfig = {
  parent: HTMLElement;
  width: number;
  height: number;
  gameConnection: GameConnection;
  mapWidth: number;
  mapHeight: number;
};

export type Game3DInstance = {
  app: ThreeApp;
  destroy: () => void;
};

export function createGame3D(config: Game3DConfig): Game3DInstance {
  const bgColor = hexToStr(MAP_BG_COLOR);

  const app = new ThreeApp(
    config.parent,
    config.width,
    config.height,
    config.mapWidth,
    config.mapHeight,
    bgColor,
  );

  const clientViewState = new ClientViewState();
  const snapshotBuffer = new SnapshotBuffer();
  snapshotBuffer.attach(config.gameConnection);

  const entityRenderer = new Render3DEntities(app.world, clientViewState);

  app.onUpdate(() => {
    const state = snapshotBuffer.consume();
    if (state) {
      clientViewState.applyNetworkState(state);
    }
    entityRenderer.update();
  });

  app.start();

  return {
    app,
    destroy: () => {
      app.stop();
      entityRenderer.destroy();
      app.destroy();
    },
  };
}
