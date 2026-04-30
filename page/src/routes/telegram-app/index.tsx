import { Spinner } from "@heroui/react";
import { api } from "@page/api/client";
import { extractErrorMessage } from "@page/api/utils";
import { useBackButton } from "@page/hooks/use-back-button";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { retrieveLaunchParams } from "@telegram-apps/sdk-react";
import { useEffect, useState } from "react";

/**
 * 入口路由（`/telegram-app/`，对应 BotFather `/newapp` 注册的 Web App URL）。
 * 群聊 deep link `t.me/<bot>/<short>?startapp=<prefix>_<chatId>_<tgMsgId>`
 * 唯一会落到这里。读 `start_param` 前缀决定跳哪去：
 *   r_<chatId>_<tgMsgId>  → /telegram-app/reminders?accountId=&emailMessageId=&token=
 *   m_<chatId>_<tgMsgId>  → /telegram-app/mail/$id?accountId=&t=
 *   <chatId>_<tgMsgId>    → /telegram-app/reminders（兼容旧按钮，无前缀 = reminder）
 *   无 start_param         → /telegram-app/reminders（列表模式，主菜单"我的提醒"）
 */
function RouterPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // 路由中转页本身不是停留页，不显示 BackButton
  useBackButton(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let startParam = "";
      try {
        startParam = retrieveLaunchParams().tgWebAppData?.start_param ?? "";
      } catch {
        // 非 TG 环境（直接打开 /telegram-app/）→ 当作无 start_param 走默认路径
      }

      if (!startParam) {
        navigate({ to: "/telegram-app/reminders", search: {}, replace: true });
        return;
      }

      const m = startParam.match(/^(?:([a-z])_)?(-?\d+)_(\d+)$/);
      if (!m) {
        setError("无效的入口参数");
        return;
      }
      const feature = m[1] || "r";
      const chatId = m[2];
      const tgMsgId = m[3];

      try {
        const { data, error } = await api.api.reminders["resolve-context"].get({
          query: { start: `${chatId}_${tgMsgId}` },
        });
        if (cancelled) return;
        if (error) throw error;
        const ctx = data;
        if (feature === "m") {
          navigate({
            to: "/telegram-app/mail/$id",
            params: { id: ctx.emailMessageId },
            search: { accountId: ctx.accountId, t: ctx.token },
            replace: true,
          });
        } else {
          navigate({
            to: "/telegram-app/reminders",
            search: {
              accountId: ctx.accountId,
              emailMessageId: ctx.emailMessageId,
              token: ctx.token,
            },
            replace: true,
          });
        }
      } catch (e) {
        if (cancelled) return;
        setError(await extractErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-sm w-full rounded-xl border border-red-900/50 bg-red-950/30 p-6 text-center">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Spinner size="lg" color="success" />
    </div>
  );
}

export const Route = createFileRoute("/telegram-app/")({
  component: RouterPage,
});
