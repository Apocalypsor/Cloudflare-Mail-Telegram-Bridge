import { clearBotState, getBotState, setBotState } from "@bot/utils/state";
import { createAccount } from "@db/accounts";
import { putOAuthBotMsg } from "@db/kv";
import { t } from "@i18n";
import { PROVIDERS } from "@providers";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AccountType, Env } from "@/types";

/** 注册新增账号流程的回调：
 *  - add / addme — 输入 chat_id 步骤入口
 *  - addtype:gmail|outlook... — OAuth 型 provider 通用流程（动态根据 PROVIDERS）
 *  - addtype:imap / imapsecure:* — IMAP 配置流程
 */
export function registerAddCallbacks(bot: Bot, env: Env) {
  // Start add flow
  bot.callbackQuery("add", async (ctx) => {
    const userId = String(ctx.from.id);
    await setBotState(env, userId, { action: "add", step: "chat_id" });

    const kb = new InlineKeyboard()
      .text(t("accounts:add.useCurrent", { id: userId }), "addme")
      .row()
      .text(t("common:button.cancel"), "accs");
    await ctx.editMessageText(t("accounts:add.promptChatId"), {
      reply_markup: kb,
    });
    await ctx.answerCallbackQuery();
  });

  // Add with own chat ID shortcut
  bot.callbackQuery("addme", async (ctx) => {
    const userId = String(ctx.from.id);
    await setBotState(env, userId, {
      action: "add",
      step: "type",
      chatId: userId,
    });

    const kb = new InlineKeyboard()
      .text(t("accounts:add.gmail"), "addtype:gmail")
      .row()
      .text(t("accounts:add.outlook"), "addtype:outlook")
      .row()
      .text(t("accounts:add.imap"), "addtype:imap")
      .row()
      .text(t("common:button.cancel"), "accs");
    await ctx.editMessageText(
      t("accounts:add.selectTypePrompt", { chatId: userId }),
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });

  // Type selection: 所有 OAuth 型 provider 共享这一段流程（addtype:gmail / addtype:outlook / 未来新增）
  for (const [type, klass] of Object.entries(PROVIDERS) as [
    AccountType,
    (typeof PROVIDERS)[AccountType],
  ][]) {
    const oauth = klass.oauth;
    if (!oauth) continue;

    bot.callbackQuery(`addtype:${type}`, async (ctx) => {
      const userId = String(ctx.from.id);
      const state = await getBotState(env, userId);
      if (!state || state.action !== "add" || state.step !== "type") {
        return ctx.answerCallbackQuery({
          text: t("common:error.operationExpired"),
        });
      }

      if (!oauth.isConfigured(env)) {
        return ctx.answerCallbackQuery({
          text: t("accounts:add.notConfigured", { provider: oauth.name }),
        });
      }

      try {
        const account = await createAccount(env.DB, state.chatId, userId, type);
        await clearBotState(env, userId);

        const origin = env.WORKER_URL?.replace(/\/$/, "") || "";
        const oauthUrl = await oauth.generateOAuthUrl(
          env,
          account.id,
          `${origin}/oauth/${type}/callback`,
        );
        const kb = new InlineKeyboard()
          .url(
            t("accounts:button.clickAuthProvider", { provider: oauth.name }),
            oauthUrl,
          )
          .row()
          .text(t("common:button.viewAccount"), `acc:${account.id}`);

        const msg = ctx.callbackQuery.message;
        if (msg) {
          await putOAuthBotMsg(env.EMAIL_KV, account.id, {
            chatId: String(msg.chat.id),
            messageId: msg.message_id,
          });
        }

        await ctx.editMessageText(
          t("accounts:add.oauthCreated", {
            type: klass.displayName,
            provider: oauth.name,
            id: account.id,
            chatId: state.chatId,
          }),
          { reply_markup: kb },
        );
      } catch (err) {
        await clearBotState(env, userId);
        await reportErrorToObservability(env, "bot.create_account_failed", err);
        await ctx.editMessageText(t("common:error.createFailed"));
      }
      await ctx.answerCallbackQuery();
    });
  }

  // Type selection: IMAP
  bot.callbackQuery("addtype:imap", async (ctx) => {
    const userId = String(ctx.from.id);
    const state = await getBotState(env, userId);
    if (!state || state.action !== "add" || state.step !== "type") {
      return ctx.answerCallbackQuery({
        text: t("common:error.operationExpired"),
      });
    }

    if (!env.IMAP_BRIDGE_URL || !env.IMAP_BRIDGE_SECRET) {
      return ctx.answerCallbackQuery({
        text: t("accounts:add.imapNotConfigured"),
      });
    }

    await setBotState(env, userId, {
      action: "add_imap",
      step: "host",
      chatId: state.chatId,
    });
    const kb = new InlineKeyboard().text(t("common:button.cancel"), "accs");
    await ctx.editMessageText(
      t("accounts:imap.promptHost", { chatId: state.chatId }),
      {
        reply_markup: kb,
      },
    );
    await ctx.answerCallbackQuery();
  });

  // IMAP: secure selection (Yes/No inline buttons)
  bot.callbackQuery(/^imapsecure:(yes|no)$/, async (ctx) => {
    const userId = String(ctx.from.id);
    const state = await getBotState(env, userId);
    if (!state || state.action !== "add_imap" || state.step !== "secure") {
      return ctx.answerCallbackQuery({
        text: t("common:error.operationExpired"),
      });
    }

    const secure = ctx.match?.[1] === "yes";
    await setBotState(env, userId, {
      ...state,
      step: "user",
      imapSecure: secure,
    });
    const kb = new InlineKeyboard().text(t("common:button.cancel"), "accs");
    await ctx.editMessageText(
      t("accounts:imap.promptUser", {
        server: `${state.imapHost}:${state.imapPort} ${secure ? "(TLS)" : `(${t("accounts:imap.noTls")})`}`,
      }),
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });
}
