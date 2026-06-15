import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

/**
 * Build-time PWA icon rasterizer (S6.6). Rasterizes the existing favicon.svg
 * into 192/512 PNGs emitted into the build output — so no binary is ever
 * committed (S4 rule). `apply:'build'` + a lazy dynamic import of @resvg/resvg-js
 * keep it out of the dev server and vitest, which never import the native dep.
 */
function pwaIcons(): Plugin {
  const svgPath = fileURLToPath(new URL('./public/favicon.svg', import.meta.url));
  return {
    name: 'pwa-icons',
    apply: 'build',
    async generateBundle() {
      const { Resvg } = await import('@resvg/resvg-js');
      const svg = readFileSync(svgPath, 'utf8');
      for (const size of [192, 512]) {
        const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
          .render()
          .asPng();
        this.emitFile({ type: 'asset', fileName: `icon-${size}.png`, source: png });
      }
    },
  };
}

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
  plugins: [wasm(), topLevelAwait(), pwaIcons()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2200,
    assetsInlineLimit: 0, // never base64-inline the Rapier .wasm — keep it a hashed, cacheable, deferred fetch
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          peerjs: ['peerjs'],
          rapier: ['@dimforge/rapier2d'],
        },
      },
    },
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
