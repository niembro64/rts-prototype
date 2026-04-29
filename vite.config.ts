import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { resolve } from 'path';

const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  base: isTauri ? '/' : '/budget-annihilation/',
  plugins: [vue(), wasm(), topLevelAwait()],
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
          if (!normalizedId.includes('/node_modules/')) return;
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
        },
      },
    },
  },
});
