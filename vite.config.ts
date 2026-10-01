import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const base = process.env.VITE_BASE_PATH ?? '/wp/';

// Optional dev proxy: set STIRLING_UPSTREAM=https://your-stirling-host to test the
// Stirling engine locally through the same-origin /stirling path. In production the
// equivalent proxy must be mounted on the deployment host (GitHub Pages is static).
const stirlingUpstream = (process.env.STIRLING_UPSTREAM ?? '').replace(/\/+$/, '');

const serverProxies: Record<string, { target: string; changeOrigin: boolean; rewrite?: (path: string) => string }> = {};
if (stirlingUpstream) {
  serverProxies['/stirling'] = {
    target: stirlingUpstream,
    changeOrigin: true,
    rewrite: path => path.replace(/^\/stirling/, ''),
  };
}
// Dev proxy for the serverless function (run `.freebuff/api-dev.mjs` on :5174).
serverProxies['/api'] = { target: 'http://127.0.0.1:5174', changeOrigin: true };

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base,
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  server: { proxy: serverProxies },
});
