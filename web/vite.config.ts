import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 5476,
    fs: { allow: ['..'] },
    proxy: { '/api': { target: 'http://127.0.0.1:7456', changeOrigin: false } },
  },
});
