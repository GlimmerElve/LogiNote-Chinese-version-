import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
// Isolated preview: no desktop startup, migrations, scene runtime or real account.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5182, strictPort: true, hmr: false, watch: null },
  optimizeDeps: { entries: ['design/mobile-prototype/index.html'] },
  preview: { host: '127.0.0.1', port: 5182, strictPort: true },
  build: {
    outDir: 'output/mobile-prototype',
    emptyOutDir: true,
    rollupOptions: { input: {
      prototype: path.resolve('design/mobile-prototype/index.html'),
      concepts: path.resolve('design/mobile-concepts/index.html'),
    } },
  },
});
