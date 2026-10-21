import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const apiPort = process.env.VITE_API_PORT || "3456";
const shoelaceDist = path.join(
  rootDir,
  "node_modules/@shoelace-style/shoelace/dist",
);

function shoelaceAssetsPlugin() {
  return {
    name: "shoelace-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] || "";
        if (!url.startsWith("/shoelace/")) return next();
        const rel = decodeURIComponent(url.slice("/shoelace/".length));
        const file = path.resolve(shoelaceDist, rel);
        if (
          !file.startsWith(shoelaceDist + path.sep) ||
          !fs.existsSync(file) ||
          !fs.statSync(file).isFile()
        ) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "image/svg+xml");
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      fs.cpSync(path.join(shoelaceDist, "assets"), path.join(rootDir, "build/ui/shoelace/assets"), {
        recursive: true,
      });
    },
  };
}

export default defineConfig({
  root: "public",
  publicDir: false,
  plugins: [shoelaceAssetsPlugin()],
  build: {
    outDir: path.join(rootDir, "build/ui"),
    emptyOutDir: true,
    // Data-URI SVGs break `url(#id)` fills (hero mark / favicon gradients).
    assetsInlineLimit: 0,
  },
  server: {
    host: process.env.VITE_LISTEN_HOST || "127.0.0.1",
    port: Number(process.env.VITE_DEV_PORT || 5173),
    strictPort: true,
    hmr: {
      host: process.env.VITE_HMR_HOST || "127.0.0.1",
      port: Number(process.env.VITE_DEV_PORT || 5173),
      clientPort: Number(process.env.VITE_DEV_PORT || 5173),
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
