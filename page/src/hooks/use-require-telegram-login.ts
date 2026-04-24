import { useEffect } from "react";
import type { Whoami } from "@/api/schemas";
import { loginUrlForCurrentPath, useSession } from "@/hooks/use-session";

/**
 * Web 页面（/preview, /junk-check）进门闸：`useSession` 返 null 时立即
 * 把浏览器跳到 `/login?return_to=<current>`，登录回来后 Worker 302 回原
 * 页面。
 *
 * 业务页用 `isLoading || isRedirecting` 盖一层 placeholder，避免未登录
 * 用户瞥见真正的表单。
 *
 * `useSession` 不会 redirect、只返回状态；这个 hook 就是"useSession + 强
 * 制 redirect 未登录用户"的组合。两者共享同一个 TanStack Query 缓存。
 */
export function useRequireTelegramLogin(): {
  isLoading: boolean;
  isRedirecting: boolean;
  data: Whoami | undefined;
} {
  const session = useSession();
  const isRedirecting = !session.isLoading && !session.data;

  useEffect(() => {
    if (!isRedirecting) return;
    window.location.href = loginUrlForCurrentPath();
  }, [isRedirecting]);

  return {
    isLoading: session.isLoading,
    isRedirecting,
    data: session.data ?? undefined,
  };
}
