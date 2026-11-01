import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy forwards /admin and /api to the backend on the same origin as
// this app is served from, so the session cookie (SameSite=Lax) round-trips
// without needing CORS at all in local dev. In production, VITE_API_BASE_URL
// (see .env.example) points apiClient.js at the real backend origin instead.
export default defineConfig({
  root: '.',
  plugins: [react()],
  server: {
    port: 4174,
    proxy: {
      '/admin': 'http://localhost:4000',
      '/api': 'http://localhost:4000'
    }
  },
  build: {
    outDir: 'dist'
  }
});
