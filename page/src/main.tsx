import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryProvider, queryClient } from "@/providers/query";
import { TelegramProvider } from "@/providers/telegram";
import { routeTree } from "./routeTree.gen";
import "./styles/app.css";

/**
 * 单一 SPA 入口 —— web 页面和 Mini App 共用这个 bundle。
 *
 * - `@telegram-apps/sdk-react` 通过 postMessage bridge 跟 TG 客户端通信，无需
 *   再在 `index.html` 里加载 `telegram-web-app.js`
 * - `TelegramProvider` 挂根部 —— TG 环境里 `init()` + 各 component mount；
 *   非 TG 浏览器里 `isTMA()` 返 false，整段 effect 静默跳过
 * - 调用方不再 `getTelegram()`：用 `@/utils/tg` 里的 helper（`notifyHaptic`
 *   `confirmPopup` `openExternalLink` 等）或者 SDK 直接 import
 * - 路由共用：web 路径（`/`、`/mail/:id`、`/preview`、`/junk-check`、
 *   `/login`）和 Mini App 路径（`/telegram-app/*`）在同一棵 routeTree
 */
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root missing");

createRoot(rootEl).render(
  <StrictMode>
    <TelegramProvider>
      <QueryProvider>
        <RouterProvider router={router} />
      </QueryProvider>
    </TelegramProvider>
  </StrictMode>,
);
