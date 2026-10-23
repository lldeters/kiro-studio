import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The extension loads dist/webview/main.js and main.css by these exact names. Lazily loaded parts (code highlighting,
// diagrams) become chunks next to them and are loaded relative to main.js.
export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: mode === 'development',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.names.some((n) => n.endsWith('.css')) ? 'main.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
