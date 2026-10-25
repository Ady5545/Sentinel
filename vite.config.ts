import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves this repository below /Sentinel/.
// Keep the normal root path for local development and preview.
const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';

export default defineConfig({
  base: isGitHubActions ? '/Sentinel/' : '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  preview: {
    host: '127.0.0.1'
  }
});
