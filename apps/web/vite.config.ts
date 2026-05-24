import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app is served under a base path (default /md/, matching radar.qdrn.io/md).
const base = process.env.VITE_BASE ?? "/md/";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // In dev, proxy API + websocket to the backend.
      [`${base}api`]: {
        target: "http://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
