import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  publicDir: false,
  server: {
    hmr: false
  },
  build: {
    outDir: 'assets',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        console: resolve(import.meta.dirname, 'src/console.ts'),
        editor: resolve(import.meta.dirname, 'src/editor.ts')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name]-[hash][extname]'
      }
    }
  }
});
