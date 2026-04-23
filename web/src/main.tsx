import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TelegramProvider } from "@/providers/telegram";
import { routeTree } from "./routeTree.gen";
import "./styles/tailwind.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

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

// TelegramProvider 必须在最外层（含 RouterProvider）：各页面的 hook
// (useBackButton / useMainButton / useSecondaryButton) 都假设 TG 已经 init。
createRoot(rootEl).render(
  <StrictMode>
    <TelegramProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TelegramProvider>
  </StrictMode>,
);
