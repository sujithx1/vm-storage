import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // In dev, API calls go to the backend project (run it with `bun run dev` there).
  server: { proxy: { '/api': 'http://127.0.0.1:4848' } },
});
