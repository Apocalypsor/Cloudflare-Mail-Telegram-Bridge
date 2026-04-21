import { buildEmailKeyboard } from "@bot/keyboards";
import { resolveMessageAccount } from "@bot/utils/message-context";
import { t } from "@i18n";
import { accountCanArchive, getEmailProvider } from "@providers";
import { cleanupTgForEmail } from "@services/message-actions";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Env } from "@/types";

/**
 * 从已有 reply_markup 推断当前星标状态 —— 读星按钮的 callback_data：
 * "star" 表示未星标（按钮动作是加星），"unstar" 表示已星标。
 * 用 junk_cancel 还原键盘时避免查远端 `isStarred()`。
 */
function readStarredFromReplyMarkup(replyMarkup: unknown): boolean {
  if (!replyMarkup || typeof replyMarkup !== "object") return false;
  const rows = (replyMarkup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(rows)) return false;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const btn of row) {
      const data =
        btn && typeof btn === "object"
          ? (btn as { callback_data?: unknown }).callback_data
          : undefined;
      if (data === "unstar") return true;
      if (data === "star") return false;
    }
  }
  return false;
}

/**
 * 标记为垃圾邮件 inline button，两步确认：
 *  - `junk_mark`     用户点 🚫 → 改成 [⚠️ 确认] [❌ 取消]，取消按钮的 callback_data
 *                    里带上当时的 star 状态（`junk_cancel:0|1`）
 *  - `junk_confirm`  点确认 → 真的标记为垃圾、删 TG 消息 + mapping
 *  - `junk_cancel:s` 点取消 → 从 callback_data 还原 star 状态、重建键盘。*不* 查远端
 *                    isStarred、*不* 动 pin 状态 —— junk 操作保持和 star/pin 解耦
 */
export function registerJunkHandler(bot: Bot, env: Env) {
  bot.callbackQuery("junk_mark", async (ctx) => {
    const msg = ctx.callbackQuery.message;
    if (!msg) return;
    const resolved = await resolveMessageAccount(
      env,
      String(msg.chat.id),
      msg.message_id,
    );
    if (!resolved.ok) {
      await ctx.answerCallbackQuery({ text: resolved.error });
      return;
    }
    const starred = readStarredFromReplyMarkup(msg.reply_markup);
    const kb = new InlineKeyboard()
      .text(t("junk:confirm"), "junk_confirm")
      .text(t("common:button.cancel"), `junk_cancel:${starred ? "1" : "0"}`);
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery({ text: t("junk:confirmPrompt") });
  });

  bot.callbackQuery("junk_confirm", async (ctx) => {
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

      const provider = getEmailProvider(account, env);
      await provider.markAsJunk(mapping.email_message_id);
      await cleanupTgForEmail(env, account.id, mapping.email_message_id);

      await ctx.answerCallbackQuery({ text: t("junk:markedAsJunk") });
      console.log(`Marked as junk: email=${mapping.email_message_id}`);
    } catch (err) {
      await reportErrorToObservability(env, "bot.junk_mark_failed", err);
      await ctx.answerCallbackQuery({
        text: t("common:error.operationFailed"),
      });
    }
  });

  bot.callbackQuery(/^junk_cancel:(0|1)$/, async (ctx) => {
    const msg = ctx.callbackQuery.message;
    if (!msg) return;
    try {
      const starred = ctx.match[1] === "1";
      const chatId = String(msg.chat.id);
      const resolved = await resolveMessageAccount(env, chatId, msg.message_id);
      if (!resolved.ok) {
        await ctx.answerCallbackQuery({ text: resolved.error });
        return;
      }
      const { mapping, account } = resolved;
      const keyboard = await buildEmailKeyboard(
        env,
        mapping.email_message_id,
        account.id,
        starred,
        accountCanArchive(account),
        mapping.tg_chat_id,
        mapping.tg_message_id,
      );
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      await ctx.answerCallbackQuery();
    } catch (err) {
      await reportErrorToObservability(env, "bot.junk_cancel_failed", err);
      await ctx.answerCallbackQuery({
        text: t("common:error.operationFailed"),
      });
    }
  });
}
