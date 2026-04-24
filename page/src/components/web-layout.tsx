import { Dropdown } from "@heroui/react";
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "@/api/client";
import { ROUTE_SESSION_LOGOUT } from "@/api/routes";
import { loginUrlForCurrentPath, useSession } from "@/hooks/use-session";

/**
 * 非 Mini App 的 web 页面共用的外壳 —— 固定深色、zinc/emerald。顶栏左边
 * Telemail wordmark + 可选 subtitle，右边展示当前登录状态（未登录 "登录"
 * pill 链接到 `/login?return_to=<current>`，登录了显示头像首字母 + first name
 * + chevron，点击下拉出 "登出"）。
 */
export function WebLayout({
  subtitle,
  children,
}: {
  /** 可选副标题，显示在 wordmark 旁边（比如 "工具"） */
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
      <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-3 min-w-0">
            <span className="text-lg font-semibold tracking-tight text-emerald-400">
              Telemail
            </span>
            {subtitle && (
              <span className="text-sm text-zinc-500 truncate">
                · {subtitle}
              </span>
            )}
          </div>
          <AuthStatus />
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}

/**
 * 顶栏右侧登录状态。
 * - 加载中：不渲染（避免闪 "登录" 再切到用户名）
 * - 未登录：emerald "登录" pill 链接到 `/login?return_to=<current>`
 * - 已登录：HeroUI Dropdown —— trigger 是 "头像首字母 · 名字 · chevron"
 *   的窄按钮（hover 背景变深），popover 是紧凑的 zinc-900 卡片，里面
 *   只有一项 "登出"
 */
function AuthStatus() {
  const session = useSession();

  const logoutMut = useMutation({
    mutationFn: async () => {
      await api.post(ROUTE_SESSION_LOGOUT.replace(/^\//, "")).json();
    },
    onSettled: () => {
      // session cookie 已被 Worker 清掉，reload 让所有使用 session 的组件
      // 重新请求 whoami → 返 null → AuthStatus 切 "登录"，受保护页自动跳
      // /login。比手动 qc.invalidate + 各处 if 判断省心。
      window.location.reload();
    },
  });

  if (session.isLoading) return <div className="h-8 w-20" aria-hidden />;

  if (!session.data) {
    return (
      <a
        href={loginUrlForCurrentPath()}
        className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 transition-colors"
      >
        登录
      </a>
    );
  }

  const first = session.data.firstName;
  const initial = first ? first[0] : "?";

  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label="账户菜单"
        className="shrink-0 flex items-center gap-2 pl-1 pr-2 py-1 rounded-full text-sm text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800/60 data-[pressed]:bg-zinc-800 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
      >
        <span className="inline-flex w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/40 items-center justify-center text-[11px] font-semibold text-emerald-300">
          {initial}
        </span>
        <span className="hidden sm:inline max-w-[120px] truncate">{first}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="w-3 h-3 text-zinc-500 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </Dropdown.Trigger>
      <Dropdown.Popover
        placement="bottom end"
        className="bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl shadow-black/40 min-w-[140px] p-1"
      >
        <Dropdown.Menu
          aria-label="账户菜单"
          onAction={(key) => {
            if (key === "logout") logoutMut.mutate();
          }}
          disabledKeys={logoutMut.isPending ? ["logout"] : []}
          className="outline-none"
        >
          <Dropdown.Item
            id="logout"
            className="px-3 py-1.5 rounded-md text-sm text-zinc-100 data-[hovered]:bg-zinc-800 data-[focused]:bg-zinc-800 data-[disabled]:text-zinc-500 data-[disabled]:bg-transparent outline-none cursor-pointer transition-colors"
          >
            {logoutMut.isPending ? "登出中…" : "登出"}
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
