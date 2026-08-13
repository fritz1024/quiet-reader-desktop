import { defineConfig } from 'vite';

export default defineConfig({
  root: 'app',
  // Must be relative. main.cjs loads dist/index.html through loadFile(), i.e.
  // file://, where Vite's default absolute '/assets/...' resolves to the
  // filesystem root and neither the stylesheet nor the bundle loads. 2.0.0
  // shipped that way: the window rendered raw unstyled HTML. Dev did not catch
  // it because `npm run dev` serves through VITE_DEV_SERVER_URL instead.
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
