import { useQuery } from "@tanstack/react-query";
import { HTTPError } from "ky";
import { useEffect } from "react";
import { api } from "@/api/client";
import { ROUTE_SESSION_WHOAMI } from "@/api/routes";
import { type Whoami, whoamiResponseSchema } from "@/api/schemas";

/**
 * Web 页面（/preview, /junk-check）进门闸：挂载时调 `/api/session/whoami`
 * 校验 session cookie + approved。没登录就立即把浏览器跳到 `/login?return_to=...`，
 * 登录回来后 Worker 会重定向回原页面。
 *
 * 返回 `{ isLoading, data, isRedirecting }`，业务页用 `isLoading || isRedirecting`
 * 盖一层 placeholder，避免未登录用户瞥见真正的表单。
 */
export function useRequireTelegramLogin(): {
  isLoading: boolean;
  isRedirecting: boolean;
  data: Whoami | undefined;
} {
  const q = useQuery({
    queryKey: ["session", "whoami"],
    queryFn: async () => {
      const raw = await api.get(ROUTE_SESSION_WHOAMI.replace(/^\//, "")).json();
      return whoamiResponseSchema.parse(raw);
    },
    retry: false,
    staleTime: Infinity,
  });

  const is401 =
    q.isError &&
    q.error instanceof HTTPError &&
    q.error.response.status === 401;

  useEffect(() => {
    if (!is401) return;
    const here = window.location.pathname + window.location.search;
    window.location.href = `/login?return_to=${encodeURIComponent(here)}`;
  }, [is401]);

  return {
    isLoading: q.isLoading,
    isRedirecting: is401,
    data: q.data,
  };
}
