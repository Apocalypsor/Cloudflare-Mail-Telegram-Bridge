import { cleanupAndDeleteAccount } from "@worker/bot/utils/account";
import { isAdmin } from "@worker/bot/utils/auth";
import {
  accountDetailKeyboard,
  accountDetailText,
  formatUserName,
} from "@worker/bot/utils/formatters";
import { clearBotState, setBotState } from "@worker/bot/utils/state";
import {
  getAuthorizedAccount,
  getOwnAccounts,
  getVisibleAccounts,
  setAccountDisabled,
  updateAccount,
} from "@worker/db/accounts";
import { getAllUsers, getUserByTelegramId } from "@worker/db/users";
import { t } from "@worker/i18n";
import { getEmailProvider } from "@worker/providers";
import type { Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { accountListKeyboard, resolveAccount, resolveOwnerName } from "./utils";

/** 注册编辑 / 删除类回调：
 *  - acc:N:t — 启用/停用切换
 *  - acc:N:edit / :eci — 编辑菜单 + chat_id
 *  - acc:N:own / edown:N:M — 管理员转让 owner
 *  - acc:N:del / :dy — 删除确认 + 执行
 */
export function registerEditCallbacks(bot: Bot, env: Env) {
  // Toggle account enable / disable
  bot.callbackQuery(/^acc:(\d+):t$/, async (ctx) => {
    const { accountId, admin, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    const nowDisabled = !account.disabled;
    await setAccountDisabled(env.DB, accountId, nowDisabled);

    // 持久化后的钩子：IMAP 会立刻通知 bridge reconcile，其他 provider no-op
    await getEmailProvider(account, env)
      .onPersistedChange()
      .catch((err) =>
        reportErrorToObservability(env, "bot.on_persisted_change_failed", err, {
          accountId,
        }),
      );

    const ownerName = await resolveOwnerName(
      env.DB,
      admin,
      account.telegram_user_id,
    );
    const updated = { ...account, disabled: nowDisabled ? 1 : 0 };
    await ctx.editMessageText(accountDetailText(updated, ownerName), {
      reply_markup: accountDetailKeyboard(updated),
    });
    await ctx.answerCallbackQuery({
      text: nowDisabled
        ? t("accounts:disabled.toggledOn")
        : t("accounts:disabled.toggledOff"),
    });
  });

  // Delete confirmation prompt
  bot.callbackQuery(/^acc:(\d+):del$/, async (ctx) => {
    const { accountId, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    const kb = new InlineKeyboard()
      .text(t("common:button.confirm_delete"), `acc:${accountId}:dy`)
      .text(t("common:button.cancelPlain"), `acc:${accountId}`);
    await ctx.editMessageText(
      t("accounts:delete.confirm", {
        id: accountId,
        email: account.email || t("common:label.notSet"),
        chatId: account.chat_id,
      }),
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });

  // Confirm delete
  bot.callbackQuery(/^acc:(\d+):dy$/, async (ctx) => {
    const { userId, accountId, admin, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    await cleanupAndDeleteAccount(env, account);

    const accounts = admin
      ? await getOwnAccounts(env.DB, userId)
      : await getVisibleAccounts(env.DB, userId, false);
    await ctx.editMessageText(
      t("accounts:delete.deleted", { id: accountId, count: accounts.length }),
      {
        reply_markup: accountListKeyboard(accounts, {
          isAdmin: admin,
          showBack: true,
        }),
      },
    );
    await ctx.answerCallbackQuery({ text: t("common:deleted") });
  });

  // Edit menu
  bot.callbackQuery(/^acc:(\d+):edit$/, async (ctx) => {
    const { userId, accountId, admin, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    await clearBotState(env, userId);
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    const kb = new InlineKeyboard()
      .text(t("accounts:edit.chatId"), `acc:${accountId}:eci`)
      .row();
    if (admin) {
      kb.text(t("accounts:edit.assignOwner"), `acc:${accountId}:own`).row();
    }
    kb.text(t("common:button.back"), `acc:${accountId}`);

    await ctx.editMessageText(
      `${t("accounts:edit.title", { id: accountId })}\n\n${accountDetailText(account)}\n\n${t("accounts:edit.selectItem")}`,
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });

  // Edit Chat ID
  bot.callbackQuery(/^acc:(\d+):eci$/, async (ctx) => {
    const { userId, accountId, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    await setBotState(env, userId, { action: "edit_chatid", accountId });
    const kb = new InlineKeyboard().text(
      t("common:button.cancel"),
      `acc:${accountId}:edit`,
    );
    await ctx.editMessageText(
      t("accounts:edit.chatIdPrompt", { current: account.chat_id }),
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });

  // Owner selection (admin)
  bot.callbackQuery(/^acc:(\d+):own$/, async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env))
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });

    const accountId = parseInt(ctx.match?.[1], 10);
    const account = await getAuthorizedAccount(env.DB, accountId, userId, true);
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFoundShort"),
      });

    const users = await getAllUsers(env.DB);
    const kb = new InlineKeyboard();
    for (const u of users) {
      const name = formatUserName(u);
      const current =
        u.telegram_id === account.telegram_user_id
          ? t("accounts:edit.ownerCurrent")
          : "";
      kb.text(`${name}${current}`, `edown:${accountId}:${u.telegram_id}`).row();
    }
    kb.text(t("common:button.back"), `acc:${accountId}:edit`);

    await ctx.editMessageText(
      t("accounts:edit.ownerTitle", {
        id: accountId,
        current: account.telegram_user_id || t("common:label.none"),
      }),
      {
        reply_markup: kb,
      },
    );
    await ctx.answerCallbackQuery();
  });

  // Confirm owner change
  bot.callbackQuery(/^edown:(\d+):(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env))
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });

    const accountId = parseInt(ctx.match?.[1], 10);
    const newOwner = ctx.match?.[2];
    const account = await getAuthorizedAccount(env.DB, accountId, userId, true);
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFoundShort"),
      });

    await updateAccount(env.DB, accountId, account.chat_id, newOwner);
    const updated = await getAuthorizedAccount(env.DB, accountId, userId, true);
    if (!updated)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFoundShort"),
      });
    const newOwnerUser = await getUserByTelegramId(env.DB, newOwner);
    const ownerName = newOwnerUser?.username
      ? `@${newOwnerUser.username}`
      : formatUserName(newOwnerUser ?? { first_name: newOwner });
    await ctx.editMessageText(accountDetailText(updated, ownerName), {
      reply_markup: accountDetailKeyboard(updated),
    });
    await ctx.answerCallbackQuery({
      text: t("accounts:edit.ownerAssigned", { owner: newOwner }),
    });
  });
}
