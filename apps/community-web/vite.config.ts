import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: { dedupe: ['react','react-dom'] },
  server: { host: '127.0.0.1', port: 5174, strictPort: true, fs: { allow: [path.resolve(import.meta.dirname, '../..')] } },
  build: { outDir: '../../.ui-preview/community-web-build', emptyOutDir: true },
});
