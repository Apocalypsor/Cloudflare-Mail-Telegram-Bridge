import { Button, Card } from "@heroui/react";
import { WebLayout } from "@page/components/web-layout";
import { createFileRoute } from "@tanstack/react-router";

/**
 * 域名根 `/`：Telemail 是一个 Telegram Mini App，入口在 TG bot 内部。
 * 直接访问根路径给一个简洁的落地页，告知用户入口在 TG，外加三张 feature 卡
 * 简述产品能做什么。
 */
function LandingPage() {
  return (
    <WebLayout>
      <section className="max-w-4xl mx-auto mt-6 sm:mt-14 space-y-10 px-2">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/40 text-3xl mb-5">
            ✉️
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-100">
            Telemail
          </h1>
          <p className="text-sm sm:text-base text-zinc-400 mt-3 max-w-md mx-auto leading-relaxed">
            把 Telegram 变成你的邮箱 —— 新邮件实时推送到聊天，
            <br className="hidden sm:inline" />
            支持 Gmail / Outlook / IMAP，AI 分类 + 稍后提醒。
          </p>
          <Button
            onPress={() =>
              window.open(
                "https://github.com/Apocalypsor/telemail",
                "_blank",
                "noopener",
              )
            }
            className="mt-7 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-semibold inline-flex items-center gap-2"
            size="lg"
          >
            <GitHubIcon />
            查看 GitHub 源码
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Feature
            icon="📬"
            title="实时推送"
            text="Gmail / Outlook / IMAP，新邮件直接发到聊天。"
          />
          <Feature
            icon="🤖"
            title="AI 分类"
            text="LLM 识别垃圾 / 通知 / 交易，自动打标给摘要。"
          />
          <Feature
            icon="⏰"
            title="稍后提醒"
            text="不想马上处理？一键设定 Mini App 提醒。"
          />
        </div>
      </section>
    </WebLayout>
  );
}

function GitHubIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="w-5 h-5"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function Feature({
  icon,
  title,
  text,
}: {
  icon: string;
  title: string;
  text: string;
}) {
  return (
    <Card className="bg-zinc-900 border border-zinc-800 p-5">
      <div className="text-2xl mb-3">{icon}</div>
      <div className="text-zinc-100 font-semibold mb-1.5">{title}</div>
      <div className="text-xs text-zinc-500 leading-relaxed">{text}</div>
    </Card>
  );
}

export const Route = createFileRoute("/")({
  component: LandingPage,
});
