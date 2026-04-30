import { api } from "@page/api/client";
import { useQuery } from "@tanstack/react-query";
import type { WhoamiResponse } from "@worker/api/modules/auth/model";

/**
 * 查一下当前浏览器有没有有效 session cookie（已登录 + approved）。
 * 不登录时返回 null data —— **不会跳转**，只是给 UI 一个信号。
 *
 * 内部走 TanStack Query，queryKey `["session", "whoami"]`，所有调用方共享
 * 同一份缓存 —— 一个页面里多个组件（WebLayout 的顶栏 + 业务页自己）各
 * 调一次 `useSession`，实际只发一次请求。
 */
export function useSession(): {
  isLoading: boolean;
  data: WhoamiResponse | null;
} {
  const q = useQuery<WhoamiResponse | null>({
    queryKey: ["session", "whoami"],
    queryFn: async () => {
      const { data, error } = await api.api.session.whoami.get();
      if (error) {
        // 401 是预期"未登录"信号 —— 返回 null 避免 isError
        if (error.status === 401) return null;
        throw error;
      }
      return data;
    },
    retry: false,
    staleTime: Infinity,
  });

  return {
    isLoading: q.isLoading,
    data: q.data ?? null,
  };
}

/** `/login?return_to=<current>` 的 URL —— 方便 "登录" 链接直接用。 */
export function loginUrlForCurrentPath(): string {
  if (typeof window === "undefined") return "/login";
  const here = window.location.pathname + window.location.search;
  return `/login?return_to=${encodeURIComponent(here)}`;
}
