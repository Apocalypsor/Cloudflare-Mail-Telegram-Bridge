import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";

interface RouterContext {
  queryClient: QueryClient;
}

function RootLayout() {
  // 拿当前 pathname 做 key，路由切换时 div 重挂、page-enter 动画重跑。
  // TG chrome 初始化（ready / expand / theme / disableVerticalSwipes）已经
  // 由 main.tsx 里的 <TelegramProvider> 统一接管，这里不再做。
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
