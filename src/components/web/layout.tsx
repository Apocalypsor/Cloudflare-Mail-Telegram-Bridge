import { TAILWIND_CSS } from "@assets/tailwind";
import type { Child } from "hono/jsx";

export function Layout({
  title,
  children,
}: {
  title: string;
  children: Child;
}) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="icon" type="image/png" href="/favicon.png" />
        <style dangerouslySetInnerHTML={{ __html: TAILWIND_CSS }} />
      </head>
      <body class="min-h-screen bg-slate-900 text-slate-200 flex justify-center p-6 font-sans">
        {children}
      </body>
    </html>
  );
}

export function Card({
  children,
  class: className,
}: {
  children: Child;
  class?: string;
}) {
  return (
    <main
      class={`w-full my-auto bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-xl ${className ?? ""}`}
    >
      {children}
    </main>
  );
}
