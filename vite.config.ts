import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    headers: {
      'Permissions-Policy': 'camera=(self), xr-spatial-tracking=(self)',
      'Referrer-Policy': 'no-referrer',
    },
  },
});
