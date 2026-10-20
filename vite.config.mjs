import { defineConfig } from "vite";

const apiPort = process.env.VITE_API_PORT || "3456";

export default defineConfig({
  root: "public",
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VITE_DEV_PORT || 5173),
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
