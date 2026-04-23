import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryProvider, queryClient } from "@/providers/query";
import { TelegramProvider } from "@/providers/telegram";
import { routeTree } from "./routeTree.gen";
import "./styles/tailwind.css";

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

// Provider 嵌套顺序：TelegramProvider 最外（ready/expand 要最先跑，主题变量
// 要在任何 UI 渲染之前定好）；QueryProvider 次之；RouterProvider 最内。
createRoot(rootEl).render(
  <StrictMode>
    <TelegramProvider>
      <QueryProvider>
        <RouterProvider router={router} />
      </QueryProvider>
    </TelegramProvider>
  </StrictMode>,
);
