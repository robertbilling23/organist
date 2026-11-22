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
        console: resolve(__dirname, 'src/console.ts'),
        editor: resolve(__dirname, 'src/editor.ts')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name]-[hash][extname]'
      }
    }
  }
});
