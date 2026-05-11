import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { resolve } from 'path';

const isTauri = !!process.env.TAURI_ENV_PLATFORM;
const usePollingWatcher = process.env.RTS_WATCH_POLLING === '1';

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

          if (normalizedId.includes('/src/game/render3d/')) return 'app-render3d';
          if (normalizedId.includes('/src/game/scenes/')) return 'app-scenes';
          if (normalizedId.includes('/src/game/sim/')) return 'app-sim';
          if (normalizedId.includes('/src/game/network/')) return 'app-network';
          if (normalizedId.includes('/src/game/server/')) return 'app-server';
          if (normalizedId.includes('/src/game/audio/')) return 'app-audio';
          if (normalizedId.includes('/src/components/')) return 'app-components';
        },
      },
    },
  },
});
