import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react({ jsxRuntime: 'classic' })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: true,
    target: 'es2018',
    lib: {
      entry: join(__dirname, 'src/App.tsx'),
      name: 'InsightApp',
      fileName: () => 'main.js',
      formats: ['iife'],
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'style.css') return 'main.css';
          return assetInfo.name;
        },
      },
    },
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});
