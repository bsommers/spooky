import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fontLicensePlugin, themePlugin } from './build/plugins.ts';

// Everything the page needs is bundled and same-origin: no CDN, no remote fonts, no inline script or style. The server
// sends a strict Content-Security-Policy (src/api/static.ts) and the offline test scans this output for remote URLs.
export default defineConfig({
  plugins: [react(), themePlugin(), fontLicensePlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0, // no data: URIs (CSP img-src/font-src 'self')
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    target: 'es2022',
    license: { fileName: 'licenses/THIRD_PARTY_LICENSES.md' }, // licenses of every bundled package ship with the bundle
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8787', '/openapi.json': 'http://127.0.0.1:8787' } },
});
