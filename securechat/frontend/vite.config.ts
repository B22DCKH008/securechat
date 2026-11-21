/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Backend dev: 2 instance Go ở :8081/:8082 (docker-compose). Proxy giúp tránh CORS khi dev.
const backend = process.env.VITE_BACKEND ?? 'http://localhost:8081';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: {
      '/v1': { target: backend, changeOrigin: true },
      '/ws': { target: backend, ws: true, changeOrigin: true },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  test: {
    environment: 'node', // file nào cần DOM thì ghi `// @vitest-environment jsdom` ở đầu file
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
  },
});
