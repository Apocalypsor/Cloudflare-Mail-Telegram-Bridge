import type { ReactNode } from "react";
import { loginUrlForCurrentPath, useSession } from "@/hooks/use-session";

/**
 * 非 Mini App 的 web 页面共用的外壳 —— 固定深色、zinc/emerald。顶栏左边
 * Telemail wordmark + 可选 subtitle，右边展示当前登录状态（未登录 "登录"
 * 链接到 `/login?return_to=<current>`，登录了显示名字）。
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
 * 顶栏右侧登录状态。未登录：emerald "登录"链接。已登录：第一个字母的圆头
 * + first name。加载中不渲染（避免闪 "登录" 再切到用户名）。
 */
function AuthStatus() {
  const session = useSession();
  if (session.isLoading) return <div className="h-7 w-14" aria-hidden />;
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
    <div
      className="shrink-0 flex items-center gap-2 text-sm text-zinc-300"
      title={`已登录 Telegram ID: ${session.data.telegramId}`}
    >
      <span className="inline-flex w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/40 items-center justify-center text-[11px] font-semibold text-emerald-300">
        {initial}
      </span>
      <span className="hidden sm:inline">{first}</span>
    </div>
  );
}
