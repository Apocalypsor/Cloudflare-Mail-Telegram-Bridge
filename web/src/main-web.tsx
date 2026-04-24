import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryProvider, queryClient } from "@/providers/query";
import { routeTree } from "./routeTree.web.gen";
import "./styles/web.css";

// Web bundle 不注入 Telegram SDK，不加载 TelegramProvider；Mini App 专属
// 路由（/telegram-app/*）不在这个 route tree 里 —— Pages `_redirects` 把
// `/telegram-app/*` 重写到 `miniapp.html`，走另一套 bundle。
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
});

// 注意：这里的 Register 只在 tsconfig.web.json project 里可见（另一边 Mini App
// project 有自己的 main-miniapp.tsx 注册），所以两棵 routeTree 的类型不互相污染。
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root missing");

createRoot(rootEl).render(
  <StrictMode>
    <QueryProvider>
      <RouterProvider router={router} />
    </QueryProvider>
  </StrictMode>,
);
