import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://localhost:8088', '/ws': { target: 'ws://localhost:8088', ws: true } },
  },
  build: { chunkSizeWarningLimit: 900 },
});
