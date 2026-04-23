import { Card } from "@heroui/react";
import { createFileRoute } from "@tanstack/react-router";

/**
 * 域名根 `/`：Telemail 是一个 Telegram Mini App，正常入口是 `/telegram-app`
 * （BotFather Web App URL）。直接访问根路径只是兜底提示，生产里不会走到这里。
 */
function LandingPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="max-w-sm w-full p-8 text-center">
        <h1 className="text-xl font-semibold mb-2 text-[color:var(--foreground)]">
          Telemail
        </h1>
        <p className="text-sm text-[color:var(--muted)]">
          请通过 Telegram 打开 Mini App
        </p>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/")({
  component: LandingPage,
});
