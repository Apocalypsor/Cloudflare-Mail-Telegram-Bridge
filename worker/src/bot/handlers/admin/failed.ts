import { isAdmin } from "@worker/bot/utils/auth";
import { clearBotState } from "@worker/bot/utils/state";
import {
  deleteAllFailedEmails,
  deleteFailedEmail,
  getAllFailedEmails,
  getFailedEmail,
} from "@worker/db/failed-emails";
import {
  retryAllFailedEmails,
  retryFailedEmail,
} from "@worker/handlers/queue/utils";
import { t } from "@worker/i18n";
import type { Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { failedEmailListMessage } from "./utils";

/** 注册 failed-emails 管理回调：list / retry-all / fr:N / fd:N / failed_clear。 */
export function registerFailedEmailCallbacks(bot: Bot, env: Env) {
  // List failed emails
  bot.callbackQuery("failed", async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }
    await clearBotState(env, userId);
    const items = await getAllFailedEmails(env.DB);
    const { text, keyboard } = failedEmailListMessage(items);
    await ctx.editMessageText(text, { reply_markup: keyboard });
    await ctx.answerCallbackQuery();
  });

  // Retry all failed emails
  bot.callbackQuery("retry_all", async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }

    await ctx.answerCallbackQuery({ text: t("admin:failedEmails.retrying") });
    try {
      const result = await retryAllFailedEmails(env);
      const msg =
        result.failed > 0
          ? t("admin:failedEmails.retryResultWithFailed", {
              success: result.success,
              failed: result.failed,
            })
          : t("admin:failedEmails.retryResult", { success: result.success });
      await ctx.editMessageText(`${t("admin:failedEmails.title")}\n\n${msg}`, {
        reply_markup: new InlineKeyboard()
          .text(t("admin:failedEmails.refreshList"), "failed")
          .text(t("common:button.back"), "admin"),
      });
    } catch (err) {
      await reportErrorToObservability(env, "bot.retry_all_failed", err);
      await ctx.editMessageText(t("admin:failedEmails.retryError"), {
        reply_markup: new InlineKeyboard().text(
          t("common:button.back"),
          "failed",
        ),
      });
    }
  });

  // Retry single failed email
  bot.callbackQuery(/^fr:(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }

    const id = parseInt(ctx.match?.[1], 10);
    const item = await getFailedEmail(env.DB, id);
    if (!item) {
      return ctx.answerCallbackQuery({
        text: t("common:error.recordNotFound"),
      });
    }

    await ctx.answerCallbackQuery({ text: t("admin:failedEmails.retrying") });

    try {
      await retryFailedEmail(item, env);
    } catch (err) {
      await reportErrorToObservability(env, "bot.retry_single_failed", err, {
        failedEmailId: id,
      });
    }

    // Refresh list
    const items = await getAllFailedEmails(env.DB);
    const { text, keyboard } = failedEmailListMessage(items);
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch {
      // 消息可能已被删除
    }
  });

  // Delete single failed email
  bot.callbackQuery(/^fd:(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }

    const id = parseInt(ctx.match?.[1], 10);
    await deleteFailedEmail(env.DB, id);
    await ctx.answerCallbackQuery({ text: t("admin:users.deleted") });

    // Refresh list
    const items = await getAllFailedEmails(env.DB);
    const { text, keyboard } = failedEmailListMessage(items);
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  // Clear all failed emails
  bot.callbackQuery("failed_clear", async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }

    await deleteAllFailedEmails(env.DB);
    await ctx.editMessageText(t("admin:failedEmails.cleared"), {
      reply_markup: new InlineKeyboard().text(t("common:button.back"), "admin"),
    });
    await ctx.answerCallbackQuery({
      text: t("admin:failedEmails.clearedShort"),
    });
  });
}
