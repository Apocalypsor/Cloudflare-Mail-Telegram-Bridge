import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * 单 entry bundle —— web 页面和 Mini App 共用 `index.html` / `main.tsx`。
 * Mini App 专属路由 `/telegram-app/*` 和 web 路由共存在一棵 routeTree，
 * Pages `_redirects` 把所有 SPA 路径都 rewrite 到 `/index.html`。
 */
export default defineConfig({
  // router 插件必须排在 react 插件之前，才能把 routeTree 的生成和 Fast Refresh 串起来
  // tsconfigPaths 把 tsconfig.json 的 paths 直接喂给 Vite，避免 alias 双份维护
  plugins: [
    tsconfigPaths(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          tanstack: ["@tanstack/react-router", "@tanstack/react-query"],
          heroui: ["@heroui/react", "@heroui/styles"],
          typebox: ["@sinclair/typebox"],
          telegram: ["@telegram-apps/sdk-react"],
        },
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
