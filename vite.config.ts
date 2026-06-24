import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { resolve } from 'path';

const isTauri = !!process.env.TAURI_ENV_PLATFORM;
const usePollingWatcher = process.env.RTS_WATCH_POLLING === '1';

export default defineConfig(({ command }) => {
  const isTauriBuild = isTauri && command === 'build';
  return {
    base: isTauri ? '/' : '/budget-annihilation/',
    plugins: [vue(), wasm(), topLevelAwait()],
    esbuild: isTauriBuild
      ? {
          drop: ['console', 'debugger'],
          legalComments: 'none',
        }
      : undefined,
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
      target: isTauri ? 'es2022' : undefined,
      modulePreload: {
        polyfill: !isTauri,
      },
      chunkSizeWarningLimit: 1500,
      reportCompressedSize: !isTauri,
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
            // colorsConfig is a pure-data leaf (it imports only colorsConfig.json)
            // whose normalized `COLORS` singleton is read at MODULE-INIT time by
            // many config modules (shellConfig, constructionVisualConfig, config,
            // nameLabelConfig, barThemes, ...). If Rollup folds colorsConfig into a
            // chunk that participates in a circular import, a consumer's top-level
            // `COLORS.x` read can execute before `COLORS` has been assigned, which
            // crashes in production as `TypeError: Cannot read properties of
            // undefined (reading 'construction')`. Pinning colorsConfig to its own
            // leaf chunk guarantees it has no back-edges and therefore initializes
            // before every importer, on every bundler ordering.
            if (
              normalizedId.endsWith('/src/colorsConfig.ts') ||
              normalizedId.endsWith('/src/colorsConfig.json')
            ) {
              return 'config-colors';
            }
          },
        },
      },
    },
  };
});
