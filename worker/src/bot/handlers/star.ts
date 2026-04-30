import { t } from "@worker/i18n";
import type { Env } from "@worker/types";
import { markAsReadByMessage, toggleStar } from "@worker/utils/message-actions";
import { reportErrorToObservability } from "@worker/utils/observability";
import type { Bot } from "grammy";

/** 星标/取消星标 inline button callback */
export function registerStarHandler(bot: Bot, env: Env) {
  bot.callbackQuery("star", async (ctx) => {
    const msg = ctx.callbackQuery.message;
    if (!msg) return;

    try {
      const result = await toggleStar(
        env,
        String(msg.chat.id),
        msg.message_id,
        true,
      );
      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: result.reason });
        return;
      }

      await ctx.editMessageReplyMarkup({ reply_markup: result.keyboard });

      // 星标同时自动标记已读
      await markAsReadByMessage(env, String(msg.chat.id), msg.message_id);

      await ctx.answerCallbackQuery({ text: t("star:starred") });
      console.log(`Starred: email=${result.emailMessageId}`);
    } catch (err) {
      await reportErrorToObservability(env, "bot.star_failed", err);
      await ctx.answerCallbackQuery({
        text: t("common:error.operationFailed"),
      });
    }
  });

  bot.callbackQuery("unstar", async (ctx) => {
    const msg = ctx.callbackQuery.message;
    if (!msg) return;

    try {
      const result = await toggleStar(
        env,
        String(msg.chat.id),
        msg.message_id,
        false,
      );
      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: result.reason });
        return;
      }

      await ctx.editMessageReplyMarkup({ reply_markup: result.keyboard });

      await ctx.answerCallbackQuery({ text: t("star:unstarred") });
      console.log(`Unstarred: email=${result.emailMessageId}`);
    } catch (err) {
      await reportErrorToObservability(env, "bot.unstar_failed", err);
      await ctx.answerCallbackQuery({
        text: t("common:error.operationFailed"),
      });
    }
  });
}
