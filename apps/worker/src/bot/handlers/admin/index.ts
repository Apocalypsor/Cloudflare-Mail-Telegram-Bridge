import {
  adminMenuKeyboard,
  buildSecretsText,
  SECRETS_AUTO_DELETE_SECONDS,
} from "@worker/bot/utils/admin";
import { isAdmin } from "@worker/bot/utils/auth";
import { deleteMessage } from "@worker/clients/telegram";
import { t } from "@worker/i18n";
import { renewAllPush } from "@worker/providers";
import type { Env, WaitUntil } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import { sleep } from "@worker/utils/sleep";
import type { Bot } from "grammy";
import { registerFailedEmailCallbacks } from "./failed";

export const registerAdminHandlers = (
  bot: Bot,
  env: Env,
  botUsername: string,
  waitUntil: WaitUntil,
) => {
  // Secrets panel (admin only, hidden behind /start -> global management)
  bot.callbackQuery("secrets", async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }

    const sent = await ctx.reply(buildSecretsText(env), {
      parse_mode: "MarkdownV2",
    });
    const chatId = String(sent.chat.id);
    waitUntil(
      sleep(SECRETS_AUTO_DELETE_SECONDS * 1_000)
        .then(() => deleteMessage(env, chatId, sent.message_id))
        .catch((err) =>
          reportErrorToObservability(
            env,
            "bot.secrets_auto_delete_failed",
            err,
            { chatId, messageId: sent.message_id },
          ),
        ),
    );
    await ctx.answerCallbackQuery({
      text: t("admin:secrets.sent", { seconds: SECRETS_AUTO_DELETE_SECONDS }),
    });
  });

  // Global management menu
  bot.callbackQuery("admin", async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }
    await ctx.editMessageText(t("admin:menu.title"), {
      reply_markup: await adminMenuKeyboard(
        env,
        ctx.callbackQuery.message?.chat.type,
        botUsername,
      ),
    });
    await ctx.answerCallbackQuery();
  });

  // Watch all
  bot.callbackQuery("walla", async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }

    await ctx.answerCallbackQuery({ text: t("admin:watch.renewing") });
    try {
      await renewAllPush(env);
      await ctx.editMessageText(t("admin:watch.renewed"), {
        reply_markup: await adminMenuKeyboard(
          env,
          ctx.callbackQuery.message?.chat.type,
          botUsername,
        ),
      });
    } catch (err) {
      await reportErrorToObservability(env, "bot.watch_all_failed", err);
      await ctx.editMessageText(t("admin:watch.failed"), {
        reply_markup: await adminMenuKeyboard(
          env,
          ctx.callbackQuery.message?.chat.type,
          botUsername,
        ),
      });
    }
  });

  registerFailedEmailCallbacks(bot, env);
};
