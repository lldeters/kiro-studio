import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/unit/**/*.test.ts', 'webview-ui/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
