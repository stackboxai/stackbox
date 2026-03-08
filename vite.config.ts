import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4322",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:4322",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
