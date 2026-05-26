import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  resolve: {
    alias: {
      '@': resolve(process.cwd(), 'src'),
    },
  },
  build: {
    target: 'node18',
    ssr: 'scripts/simRuntimeProbe.ts',
    outDir: 'tmp/sim-runtime',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'es',
      },
    },
  },
});
