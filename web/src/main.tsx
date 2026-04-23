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

// TelegramProvider 必须最外 —— ready/expand + 主题 CSS 变量要先于任何 UI 渲染。
createRoot(rootEl).render(
  <StrictMode>
    <TelegramProvider>
      <QueryProvider>
        <RouterProvider router={router} />
      </QueryProvider>
    </TelegramProvider>
  </StrictMode>,
);
