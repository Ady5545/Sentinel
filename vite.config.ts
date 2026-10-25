import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Packaged Electron loads dist/index.html from disk; relative assets work offline.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1' }
});
