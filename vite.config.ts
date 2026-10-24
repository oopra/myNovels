import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: { '/api': { target: 'http://127.0.0.1:4801', changeOrigin: false } },
  },
  build: { outDir: 'dist/client' },
  test: { include: ['tests/**/*.test.ts'] },
});
