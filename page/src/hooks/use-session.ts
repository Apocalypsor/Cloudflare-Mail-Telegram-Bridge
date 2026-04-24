import { useQuery } from "@tanstack/react-query";
import { HTTPError, type KyResponse } from "ky";
import { api } from "@/api/client";
import { ROUTE_SESSION_WHOAMI } from "@/api/routes";
import { type Whoami, whoamiResponseSchema } from "@/api/schemas";

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
  data: Whoami | null;
} {
  const q = useQuery<Whoami | null>({
    queryKey: ["session", "whoami"],
    queryFn: async () => {
      try {
        const raw = await api
          .get(ROUTE_SESSION_WHOAMI.replace(/^\//, ""))
          .json();
        return whoamiResponseSchema.parse(raw);
      } catch (err) {
        // 401 是预期"未登录"信号，不是错误 —— 返回 null 避免 `isError`
        // 让调用方判错态失败。其他 error 往上抛，由 queryFn 的 error 处理。
        if (
          err instanceof HTTPError &&
          (err as HTTPError<KyResponse>).response.status === 401
        ) {
          return null;
        }
        throw err;
      }
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
