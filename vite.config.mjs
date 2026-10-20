import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const apiPort = process.env.VITE_API_PORT || "3456";

export default defineConfig({
  root: "public",
  publicDir: false,
  build: {
    outDir: path.join(rootDir, "build/ui"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VITE_DEV_PORT || 5173),
    strictPort: true,
    hmr: {
      host: "127.0.0.1",
      port: Number(process.env.VITE_DEV_PORT || 5173),
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
