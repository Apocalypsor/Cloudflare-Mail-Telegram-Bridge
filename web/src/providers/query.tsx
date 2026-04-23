import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * TanStack Query 客户端 —— 应用级单例。
 *
 * 同时 export 实例和 Provider：
 *   - `queryClient` 要传给 `createRouter({ context: { queryClient } })`，这是
 *     router 级别的依赖注入，不走 React tree，所以必须从模块级拿到
 *   - `<QueryProvider>` 负责在 React 树里开 context，供 `useQuery` 等 hook 用
 *
 * 两者背后是同一个实例。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

export function QueryProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
