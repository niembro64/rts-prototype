import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { resolve } from 'path';

const isTauri = !!process.env.TAURI_ENV_PLATFORM;
const usePollingWatcher = process.env.RTS_WATCH_POLLING === '1';

function getSrcPath(normalizedId: string): string | undefined {
  const marker = '/src/';
  const markerIndex = normalizedId.indexOf(marker);
  return markerIndex >= 0 ? normalizedId.slice(markerIndex + marker.length) : undefined;
}

function isSharedAppModule(srcPath: string): boolean {
  return (
    srcPath === 'config.ts' ||
    srcPath === 'audioConfig.ts' ||
    srcPath === 'battleBarConfig.ts' ||
    srcPath === 'barThemes.ts' ||
    srcPath === 'clientBarConfig.ts' ||
    srcPath === 'demoConfig.ts' ||
    srcPath === 'gamePhase.ts' ||
    srcPath === 'lodConfig.ts' ||
    srcPath === 'mapSizeConfig.ts' ||
    srcPath === 'persistence.ts' ||
    srcPath === 'playerNamesConfig.ts' ||
    srcPath === 'serverBarConfig.ts' ||
    srcPath === 'shellConfig.ts' ||
    srcPath === 'uiLabels.ts' ||
    srcPath === 'game/sim/blueprints/unitRoster.ts' ||
    srcPath.startsWith('types/')
  );
}

export default defineConfig({
  base: isTauri ? '/' : '/budget-annihilation/',
  plugins: [vue(), wasm(), topLevelAwait()],
  server: usePollingWatcher
    ? {
        watch: {
          usePolling: true,
          interval: 500,
          ignored: [
            '**/node_modules/**',
            '**/dist/**',
            '**/public/assets/environment-packs/**',
          ],
        },
      }
    : undefined,
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/');
          if (normalizedId.includes('/node_modules/')) {
            if (normalizedId.includes('/node_modules/three/')) return 'vendor-three';
            if (
              normalizedId.includes('/node_modules/vue/') ||
              normalizedId.includes('/node_modules/@vue/')
            ) return 'vendor-vue';
            if (
              normalizedId.includes('/node_modules/peerjs/') ||
              normalizedId.includes('/node_modules/peerjs-js-binarypack/') ||
              normalizedId.includes('/node_modules/@msgpack/')
            ) return 'vendor-network';
            return 'vendor';
          }

          const srcPath = getSrcPath(normalizedId);
          if (!srcPath) return;
          if (isSharedAppModule(srcPath)) return 'app-shared';

          if (
            normalizedId.includes('/src/game/render3d/') ||
            normalizedId.includes('/src/game/scenes/') ||
            normalizedId.includes('/src/game/input/')
          ) return 'app-render3d';
          if (
            normalizedId.includes('/src/game/math/') ||
            normalizedId.includes('/src/game/sim/') ||
            normalizedId.includes('/src/game/network/')
          ) return 'app-engine';
          if (normalizedId.includes('/src/game/server/')) return 'app-server';
          if (normalizedId.includes('/src/game/audio/')) return 'app-audio';
          if (normalizedId.includes('/src/components/')) return 'app-components';
        },
      },
    },
  },
});
