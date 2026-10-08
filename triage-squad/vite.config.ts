import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.TRIAGE_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./web/dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    // changeOrigin stays false so the Origin and Host headers still match and the server's CSRF check passes.
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/ingest': { target: apiTarget, changeOrigin: false },
      '/healthz': { target: apiTarget, changeOrigin: false },
    },
  },
});
