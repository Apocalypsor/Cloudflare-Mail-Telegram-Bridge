import { resolveMessageAccount } from "@bot/utils/message-context";
import { t } from "@i18n";
import { accountCanArchive, getEmailProvider } from "@providers";
import { cleanupTgForEmail, markEmailAsRead } from "@services/message-actions";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import type { Env } from "@/types";

/** 归档 inline button callback */
export function registerArchiveHandler(bot: Bot, env: Env) {
  bot.callbackQuery("archive", async (ctx) => {
    const msg = ctx.callbackQuery.message;
    if (!msg) return;

    try {
      const chatId = String(msg.chat.id);
      const resolved = await resolveMessageAccount(env, chatId, msg.message_id);
      if (!resolved.ok) {
        await ctx.answerCallbackQuery({ text: resolved.error });
        return;
      }
      const { mapping, account } = resolved;

      if (!accountCanArchive(account)) {
        await ctx.answerCallbackQuery({
          text: t("archive:gmailUnconfigured"),
          show_alert: true,
        });
        return;
      }

      const provider = getEmailProvider(account, env);
      // 归档的同时标已读（用户已看过，邮件即将离开收件箱）
      await markEmailAsRead(env, account, mapping.email_message_id);
      await provider.archiveMessage(mapping.email_message_id);
      await cleanupTgForEmail(env, account.id, mapping.email_message_id);

      await ctx.answerCallbackQuery({ text: t("archive:archived") });
      console.log(`Archived: email=${mapping.email_message_id}`);
    } catch (err) {
      await reportErrorToObservability(env, "bot.archive_failed", err);
      await ctx.answerCallbackQuery({
        text: t("common:error.operationFailed"),
      });
    }
  });
}
