import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Multi-entry：web 页面 和 Mini App 完全分 bundle（见 docs/AGENTS.md 里 "web
 * split" 约定）。两套 HTML + 两套 `main-*.tsx` + 两套 routeTree + 两份 CSS，
 * 各自独立下载，互不污染彼此的主题 / 全局样式 / SDK。
 *
 * Pages `_redirects` 把 `/telegram-app/*` 重写到 `/miniapp.html`，其余走
 * `index.html`（Pages 默认 `/` fallback）。
 */
export default defineConfig({
  // router 插件必须排在 react 插件之前，才能把 routeTree 的生成和 Fast Refresh 串起来
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: path.resolve(root, "src/routes-web"),
      generatedRouteTree: path.resolve(root, "src/routeTree.web.gen.ts"),
    }),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: path.resolve(root, "src/routes-miniapp"),
      generatedRouteTree: path.resolve(root, "src/routeTree.miniapp.gen.ts"),
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "@worker": path.resolve(root, "../src"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      input: {
        index: path.resolve(root, "index.html"),
        miniapp: path.resolve(root, "miniapp.html"),
      },
    },
  },
  server: {
    port: 5173,
    // 开发时代理 Worker API 到本地 wrangler dev（默认 8787），保持和生产同源。
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/webhook": "http://127.0.0.1:8787",
    },
  },
});
