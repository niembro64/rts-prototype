import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { resolve } from 'path';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

const isTauri = !!process.env.TAURI_ENV_PLATFORM;
const usePollingWatcher = process.env.RTS_WATCH_POLLING === '1';

function computeBuildFingerprint(): string {
  const hash = createHash('sha256');
  const addTree = (relativeDirectory: string): void => {
    const absoluteDirectory = resolve(__dirname, relativeDirectory);
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .filter((entry) => entry.name !== '.DS_Store')
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        addTree(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(relativePath);
      hash.update('\0');
      hash.update(readFileSync(resolve(__dirname, relativePath)));
      hash.update('\0');
    }
  };

  // `src` contains the authoritative TypeScript plus the exact generated
  // WASM bytes imported by the bundle. Dependency resolution can also change
  // runtime semantics, so bind the lockfile into the same identity.
  addTree('src');
  hash.update('package-lock.json\0');
  hash.update(readFileSync(resolve(__dirname, 'package-lock.json')));
  return `sha256:${hash.digest('hex')}`;
}

// SharedArrayBuffer prerequisite for the sim-in-worker roadmap (SCALE-1000):
// the page must be crossOriginIsolated, which requires these two headers on
// the document. require-corp (not credentialless) keeps Safari 16.4+ in the
// supported set; every asset is same-origin so no subresource needs CORP.
// Static hosts that cannot set response headers need a coi-serviceworker
// shim at deploy time; dev and `vite preview` get the real headers here.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(({ command }) => {
  const isTauriBuild = isTauri && command === 'build';
  return {
    base: isTauri ? '/' : '/budget-annihilation/',
    plugins: [vue(), wasm(), topLevelAwait()],
    define: {
      __BA_BUILD_FINGERPRINT__: JSON.stringify(computeBuildFingerprint()),
    },
    esbuild: isTauriBuild
      ? {
          drop: ['console', 'debugger'],
          legalComments: 'none',
        }
      : undefined,
    server: {
      headers: crossOriginIsolationHeaders,
      ...(usePollingWatcher
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
        : {}),
    },
    preview: {
      headers: crossOriginIsolationHeaders,
    },
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
