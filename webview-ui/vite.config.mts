import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Writes the npm modules the webview bundle contains to dist, so that scripts/third-party-notices.ts can ship their licences. */
function listBundledModules(): Plugin {
  return {
    name: 'kiro-list-bundled-modules',
    apply: 'build',
    buildEnd() {
      const modules = this.getModuleIds();
      const found: string[] = [];
      for (const id of modules) if (id.includes('/node_modules/')) found.push(id.split('?')[0] ?? id);
      mkdirSync(join(import.meta.dirname, '..', 'dist'), { recursive: true });
      writeFileSync(join(import.meta.dirname, '..', 'dist', 'webview-modules.json'), JSON.stringify(found));
    },
  };
}

// The extension loads dist/webview/main.js and main.css by these exact names. Lazily loaded parts (code highlighting,
// diagrams) become chunks next to them and are loaded relative to main.js.
export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), listBundledModules()],
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
