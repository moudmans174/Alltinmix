import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the app talks to the API through this proxy, so there is no CORS to configure.
// In production (Docker) the same job is done by nginx, see nginx.conf.
const target = process.env.VITE_PROXY_TARGET || 'http://localhost:4000';
const proxy = { '/api': target, '/uploads': target };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 5173, proxy },
});
