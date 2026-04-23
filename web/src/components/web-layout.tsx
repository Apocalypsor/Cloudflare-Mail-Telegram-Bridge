import type { ReactNode } from "react";

/**
 * 非 Mini App 的 web 页面共用的外壳 —— 固定深色、独立于 TG 主题。
 * 顶部一条 Telemail wordmark，主内容区居中约束宽度。
 *
 * 颜色用 Tailwind 的 zinc/emerald 字面量，不走 --tg-theme-* CSS 变量，
 * 保证浏览器和 TG in-app browser 看起来都一致。
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
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-baseline gap-3">
          <span className="text-lg font-semibold tracking-tight text-emerald-400">
            Telemail
          </span>
          {subtitle && (
            <span className="text-sm text-zinc-500">· {subtitle}</span>
          )}
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
