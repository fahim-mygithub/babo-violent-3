import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves from /<repo>/ — relative base keeps assets working there
  // and locally without configuration.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2200,
  },
  server: {
    port: 5173,
  },
});
