import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/ForSyDe-Diagram-Web/',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
  },
});
