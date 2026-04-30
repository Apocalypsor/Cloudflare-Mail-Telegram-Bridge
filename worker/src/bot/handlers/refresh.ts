import { refreshEmail } from "@worker/handlers/queue/bridge";
import { t } from "@worker/i18n";
import type { Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import type { Bot } from "grammy";

/** 刷新邮件 inline button callback */
export function registerRefreshHandler(bot: Bot, env: Env) {
  bot.callbackQuery("refresh", async (ctx) => {
    const msg = ctx.callbackQuery.message;
    if (!msg) return;

    await ctx.answerCallbackQuery({ text: t("bridge:refreshing") });

    try {
      const isCaption = "caption" in msg && !!msg.caption;
      const result = await refreshEmail(
        env,
        String(msg.chat.id),
        msg.message_id,
        isCaption,
      );

      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: result.reason });
        return;
      }

      if (result.removed) {
        // TG 消息已经在 reconcile 里被删掉；callback 在开头已答过 "refreshing…"，
        // 这里发一条新消息告知原因，避免消息凭空消失的歧义
        await ctx.reply(t(`bridge:removed.${result.removed}`)).catch(() => {});
      }

      console.log(`Refreshed: chat=${msg.chat.id}, message=${msg.message_id}`);
    } catch (err) {
      await reportErrorToObservability(env, "bot.refresh_failed", err);
      await ctx.answerCallbackQuery({
        text: t("common:error.operationFailed"),
      });
    }
  });
}
