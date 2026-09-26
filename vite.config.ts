import react from '@vitejs/plugin-react';
import { configDefaults } from 'vitest/config';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH ?? '/ForSyDe-Diagram-Web/',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    // browser tests run under Playwright (npm run e2e), not vitest
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
});
