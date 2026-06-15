import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  // GitHub Pages serves from /<repo>/ — relative base keeps assets working there
  // and locally without configuration.
  base: './',
  // The non-compat @dimforge/rapier2d ships its WASM as a separate file imported
  // via the ESM "WebAssembly integration proposal" (import * as wasm from ".wasm").
  // vite-plugin-wasm handles that import (Vite core does not); top-level-await
  // supports the resulting top-level await in the es2022 target. Both are required
  // for the production build to emit a standalone .wasm (not a base64 blob) and for
  // vitest to load the module at all.
  plugins: [wasm(), topLevelAwait()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2200,
  },
  server: {
    port: 5173,
  },
  test: {
    // The package declares only a `module` entry (no `main`/`exports`), which
    // Node/vitest SSR resolution ignores — alias it straight to that entry so the
    // test runner can resolve it. vite-plugin-wasm then handles the .wasm import.
    alias: { '@dimforge/rapier2d': '@dimforge/rapier2d/rapier.js' },
    deps: { optimizer: { ssr: { exclude: ['@dimforge/rapier2d'] } }, inline: ['@dimforge/rapier2d'] },
  },
});
