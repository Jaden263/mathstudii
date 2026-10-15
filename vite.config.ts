/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Tauri sets TAURI_ENV_PLATFORM while building the native apps.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  plugins: [
    react(),
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
