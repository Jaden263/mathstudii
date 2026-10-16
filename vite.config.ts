/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { createReadStream, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

// Python (Pyodide) core files: served from node_modules in dev, copied to dist/pyodide/ at build.
const PYODIDE_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const PYODIDE_DIR = fileURLToPath(new URL('./node_modules/pyodide', import.meta.url));
const MIME: Record<string, string> = { mjs: 'text/javascript', wasm: 'application/wasm', zip: 'application/zip', json: 'application/json' };

function pyodideFiles(): Plugin {
  let outDir = 'dist';
  return {
    name: 'mathstudii-pyodide',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/pyodide\/([\w.-]+)(?:\?.*)?$/.exec(req.url ?? '');
        if (!m || !PYODIDE_FILES.includes(m[1])) return next();
        res.setHeader('Content-Type', MIME[m[1].split('.').pop()!] ?? 'application/octet-stream');
        createReadStream(resolve(PYODIDE_DIR, m[1])).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(outDir)) return;
      mkdirSync(resolve(outDir, 'pyodide'), { recursive: true });
      for (const f of PYODIDE_FILES) copyFileSync(resolve(PYODIDE_DIR, f), resolve(outDir, 'pyodide', f));
    },
  };
}

// Tauri sets TAURI_ENV_PLATFORM while building the native apps.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  plugins: [
    react(),
    pyodideFiles(),
    VitePWA({
        // native builds bundle everything; the plugin then only provides a no-op register module
        disable: isTauri,
        registerType: 'autoUpdate',
        injectRegister: false,
        includeAssets: ['icon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'mathstudii',
          short_name: 'mathstudii',
          description: 'Engineering calculation worksheets with live math, units, solving, plotting and symbolics.',
          theme_color: '#2f6fdf',
          background_color: '#eef0f4',
          display: 'standalone',
          start_url: '.',
          scope: '.',
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
          file_handlers: [{ action: '.', accept: { 'application/json': ['.mstd'] } }],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          globIgnores: ['**/pyodide/**', '**/replicad_single*.wasm'],
          // Python is large (~13 MB) and only needed by worksheets with code: cache it on first use
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.pathname.includes('/pyodide/') || url.hostname === 'cdn.jsdelivr.net',
              handler: 'CacheFirst',
              options: { cacheName: 'python', expiration: { maxEntries: 200 }, cacheableResponse: { statuses: [0, 200] } },
            },
            // the B-rep CAD kernel (23 MB) is too big to precache: cache it on first use
            {
              urlPattern: ({ url }) => /replicad_single[\w-]*\.wasm$/.test(url.pathname),
              handler: 'CacheFirst',
              options: { cacheName: 'cad-kernel', expiration: { maxEntries: 2 }, cacheableResponse: { statuses: [0, 200] } },
            },
          ],
        },
      }),
  ],
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || false },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: isTauri ? (process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15') : 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  test: { environment: 'node', testTimeout: 30000, setupFiles: ['src/test-setup.ts'] },
});
