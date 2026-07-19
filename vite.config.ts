import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/forsyde-playground/',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
  },
});
