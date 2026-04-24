import { createFileRoute } from "@tanstack/react-router";
import { WebLayout } from "@/components/web-layout";

/**
 * 域名根 `/`：Telemail 是一个 Telegram Mini App，正常入口是 `/telegram-app`
 * （BotFather Web App URL，另一套 bundle）。直接访问根路径只是兜底提示。
 */
function LandingPage() {
  return (
    <WebLayout>
      <div className="max-w-md mx-auto mt-16 rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center">
        <h1 className="text-xl font-semibold text-zinc-100 mb-2">Telemail</h1>
        <p className="text-sm text-zinc-500">请通过 Telegram 打开 Mini App</p>
      </div>
    </WebLayout>
  );
}

export const Route = createFileRoute("/")({
  component: LandingPage,
});
