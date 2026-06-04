import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    proxy: {
      // Forward every /api/* request to the Express backend.
      // This avoids CORS issues during development — the browser sees only
      // one origin (localhost:5173) and Vite handles the proxying silently.
      '/api': {
        target:      'http://localhost:3002',
        changeOrigin: true,
        secure:       false,
      },
    },
  },
});
