import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

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
  // @dimforge/rapier2d-compat self-contains its WASM as inlined base64 and exposes
  // an async init() — no vite-plugin-wasm / top-level-await needed. initPhysics()
  // dynamic-imports it, so rollup emits the compat module (WASM and all) as a
  // deferred async chunk; the menu loads without it.
  plugins: [pwaIcons()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2200,
    assetsInlineLimit: 0, // keep hashed assets as separate cacheable fetches (Rapier's WASM is already inlined in the compat JS, so this no longer affects it)
    rollupOptions: {
      output: {
        // Do NOT manualChunk @dimforge/rapier2d-compat. initPhysics() already
        // dynamic-imports it, so rollup emits it as its own deferred async chunk
        // (with the inlined base64 WASM) — keeping it out of the entry so the menu
        // loads without Rapier. Only stably-shared vendor libs get manual chunks.
        manualChunks: {
          three: ['three'],
          peerjs: ['peerjs'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
