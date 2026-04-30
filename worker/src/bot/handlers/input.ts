import { isAdmin } from "@worker/bot/utils/auth";
import {
  clearBotState,
  getBotState,
  setBotState,
} from "@worker/bot/utils/state";
import {
  createImapAccount,
  getAuthorizedAccount,
  updateAccount,
} from "@worker/db/accounts";
import { t } from "@worker/i18n";
import { syncAccounts } from "@worker/providers/imap";
import type { Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";

/**
 * 处理文本消息输入（用于添加/编辑账号的多步骤交互）。
 * 必须在所有 command handler 之后注册，作为 catch-all。
 */
export function registerInputHandler(bot: Bot, env: Env) {
  bot.on("message:text", async (ctx) => {
    const userId = String(ctx.from.id);
    const text = ctx.message.text.trim();

    const state = await getBotState(env, userId);
    if (!state) return;

    const admin = isAdmin(userId, env);

    // ─── 添加账号：chat_id / label 步骤 ──────────────────────────
    if (state.action === "add") {
      if (state.step === "chat_id") {
        if (!/^-?\d+$/.test(text)) {
          await ctx.reply(t("accounts:input.chatIdMustBeNumber"));
          return;
        }
        await setBotState(env, userId, {
          action: "add",
          step: "type",
          chatId: text,
        });
        const kb = new InlineKeyboard()
          .text(t("accounts:add.gmail"), "addtype:gmail")
          .row()
          .text(t("accounts:add.outlook"), "addtype:outlook")
          .row()
          .text(t("accounts:add.imap"), "addtype:imap")
          .row()
          .text(t("common:button.cancel"), "accs");
        await ctx.reply(t("accounts:add.selectType"), { reply_markup: kb });
      }
    }

    // ─── 添加 IMAP 账号：各步骤 ───────────────────────────────────
    else if (state.action === "add_imap") {
      if (state.step === "host") {
        if (!text) {
          await ctx.reply(t("accounts:input.hostEmpty"));
          return;
        }
        await setBotState(env, userId, {
          ...state,
          step: "port",
          imapHost: text,
        });
        const kb = new InlineKeyboard().text(t("common:button.cancel"), "accs");
        await ctx.reply(t("accounts:imap.promptPort", { host: text }), {
          reply_markup: kb,
        });
      } else if (state.step === "port") {
        const port = parseInt(text, 10);
        if (Number.isNaN(port) || port < 1 || port > 65535) {
          await ctx.reply(t("accounts:input.portInvalid"));
          return;
        }
        await setBotState(env, userId, {
          ...state,
          step: "secure",
          imapPort: port,
        });
        const kb = new InlineKeyboard()
          .text(t("accounts:imap.secureYes"), "imapsecure:yes")
          .text(t("accounts:imap.secureNo"), "imapsecure:no")
          .row()
          .text(t("common:button.cancelPlain"), "accs");
        await ctx.reply(
          t("accounts:imap.promptSecure", {
            server: `${state.imapHost}:${port}`,
          }),
          { reply_markup: kb },
        );
      } else if (state.step === "user") {
        if (!text) {
          await ctx.reply(t("accounts:input.userEmpty"));
          return;
        }
        await setBotState(env, userId, {
          ...state,
          step: "pass",
          imapUser: text,
        });
        const kb = new InlineKeyboard().text(t("common:button.cancel"), "accs");
        await ctx.reply(t("accounts:imap.promptPass"), { reply_markup: kb });
      } else if (state.step === "pass") {
        if (!text) {
          await ctx.reply(t("accounts:input.passEmpty"));
          return;
        }
        try {
          const account = await createImapAccount(env.DB, {
            chatId: state.chatId,
            telegramUserId: userId,
            email: state.imapUser,
            imapHost: state.imapHost,
            imapPort: state.imapPort,
            imapSecure: state.imapSecure ? 1 : 0,
            imapUser: state.imapUser,
            imapPass: text,
          });
          await clearBotState(env, userId);

          // 通知中间件更新连接列表
          if (env.IMAP_BRIDGE_URL && env.IMAP_BRIDGE_SECRET) {
            await syncAccounts(env).catch((err) => {
              reportErrorToObservability(
                env,
                "imap.sync_after_create_failed",
                err,
                { accountId: account.id },
              );
            });
          }

          const kb = new InlineKeyboard()
            .text(t("common:button.viewAccount"), `acc:${account.id}`)
            .text(t("common:button.accountList"), "accs");
          await ctx.reply(
            t("accounts:imap.created", {
              id: account.id,
              email: state.imapUser,
              chatId: state.chatId,
            }),
            { reply_markup: kb },
          );
        } catch (err) {
          await clearBotState(env, userId);
          await ctx.reply(
            t("common:error.createFailedDetail", {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    }

    // ─── 编辑 Chat ID ─────────────────────────────────────────────
    else if (state.action === "edit_chatid") {
      if (!/^-?\d+$/.test(text)) {
        await ctx.reply(t("accounts:input.chatIdMustBeNumber"));
        return;
      }
      const account = await getAuthorizedAccount(
        env.DB,
        state.accountId,
        userId,
        admin,
      );
      if (!account) {
        await clearBotState(env, userId);
        await ctx.reply(`❌ ${t("common:error.accountNotFound")}`);
        return;
      }

      try {
        await updateAccount(env.DB, state.accountId, text);
        await clearBotState(env, userId);
        const kb = new InlineKeyboard()
          .text(t("common:button.viewAccount"), `acc:${state.accountId}`)
          .text(t("common:button.accountList"), "accs");
        await ctx.reply(t("accounts:edit.chatIdUpdated", { value: text }), {
          reply_markup: kb,
        });
      } catch (err) {
        await clearBotState(env, userId);
        await ctx.reply(
          t("common:error.updateFailedDetail", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  });
}
