import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths so the build works from a sub-path such as
  // https://<user>.github.io/new-project/ (GitHub Pages).
  base: './',
  plugins: [react()],
});
