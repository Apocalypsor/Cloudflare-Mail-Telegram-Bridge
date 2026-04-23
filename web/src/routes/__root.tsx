import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { initTelegramChrome } from "@/lib/tg";

interface RouterContext {
  queryClient: QueryClient;
}

function RootLayout() {
  useEffect(() => {
    initTelegramChrome();
  }, []);

  // 拿当前 pathname 做 key，路由切换时 div 重挂、page-enter 动画重跑
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div key={pathname} data-page-enter>
      <Outlet />
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});
