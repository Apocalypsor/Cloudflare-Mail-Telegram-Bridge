import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";

export interface RouterContext {
  queryClient: QueryClient;
}

function RootLayout() {
  // pathname 作 key 让路由切换时 div 重挂，触发 page-enter 动画
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
