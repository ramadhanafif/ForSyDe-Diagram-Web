import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { configDefaults } from 'vitest/config';
import { defineConfig } from 'vite';

export default defineConfig({
  // the React compiler memoizes components; eslint's react-hooks rules hold the code to it
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  base: process.env.BASE_PATH ?? '/ForSyDe-Diagram-Web/',
  build: {
    target: 'es2022',
    // vendor code in its own chunk, so a release that changes only app code
    // keeps it cached; driver.js stays a lazy chunk of its own
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'vendor', test: /node_modules[\\/](?!driver\.js)/ }],
        },
      },
    },
    // the vendor chunk is about 560 kB (CodeMirror and React)
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: 'node',
    // browser tests run under Playwright (npm run e2e), not vitest
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
});
