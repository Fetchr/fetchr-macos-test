import { readFileSync } from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Промо-ролик собирается отдельным Vite из корня promo/, но берёт токены,
// шрифты и иконки прямо из приложения через тот же алиас "@".
const repo = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  cacheDir: path.join(repo, "node_modules/.vite-promo"),
  define: {
    __APP_VERSION__: JSON.stringify(`v${pkg.version}`),
  },
  resolve: {
    alias: {
      "@": path.join(repo, "src"),
    },
  },
  server: {
    port: 5188,
    strictPort: true,
    host: "127.0.0.1",
    fs: { allow: [repo] },
  },
  build: {
    outDir: path.join(__dirname, "dist"),
    emptyOutDir: true,
  },
});
