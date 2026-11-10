import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Never inline fonts as data: URIs - the site's CSP (font-src 'self') blocks them,
    // and a cached woff2 file is better than base64 in the CSS anyway.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
    rollupOptions: {
      output: {
        // Stable vendor chunk for the marketing pages (react + router); three.js
        // only ever lands in the lazily loaded quote-builder chunk.
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'react';
        },
      },
    },
  },
  ssr: {
    // Bundle everything into the prerender entry so the build step does not
    // depend on how node resolves react-router's ESM/CJS exports.
    noExternal: true,
  },
  server: {
    port: 3001,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
