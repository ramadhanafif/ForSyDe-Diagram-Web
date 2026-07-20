import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH ?? '/ForSyDe-Diagram-Web/',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
  },
});
