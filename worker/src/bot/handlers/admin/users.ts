import { cleanupAndDeleteAccount } from "@worker/bot/utils/account";
import { isAdmin } from "@worker/bot/utils/auth";
import { formatUserName } from "@worker/bot/utils/formatters";
import { getOwnAccounts } from "@worker/db/accounts";
import {
  approveUser,
  deleteUser,
  getNonAdminUsers,
  getUserByTelegramId,
  rejectUser,
} from "@worker/db/users";
import { t } from "@worker/i18n";
import type { Env } from "@worker/types";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { userListKeyboard, userListText } from "./utils";

/** 删除用户及其绑定的所有邮箱账号 */
async function deleteUserWithAccounts(
  env: Env,
  telegramId: string,
): Promise<void> {
  const accounts = await getOwnAccounts(env.DB, telegramId);
  for (const acc of accounts) {
    await cleanupAndDeleteAccount(env, acc);
  }
  await deleteUser(env.DB, telegramId);
}

/** 注册 user 管理回调：列表 / info / approve / reject / delete confirm + confirmed。 */
export function registerUserCallbacks(bot: Bot, env: Env) {
  // User list
  bot.callbackQuery("users", async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }
    const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
    await ctx.editMessageText(userListText(users), {
      reply_markup: userListKeyboard(users, { showBack: true }),
    });
    await ctx.answerCallbackQuery();
  });

  // User info (no-op, just shows toast)
  bot.callbackQuery(/^u:(\d+):info$/, async (ctx) => {
    if (!isAdmin(String(ctx.from.id), env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }
    await ctx.answerCallbackQuery({ text: `Telegram ID: ${ctx.match?.[1]}` });
  });

  // Approve user
  bot.callbackQuery(/^u:(\d+):a$/, async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }

    const targetId = ctx.match?.[1];
    await approveUser(env.DB, targetId);

    try {
      await ctx.api.sendMessage(targetId, t("start:approvedNotify"));
    } catch {
      /* user may have blocked bot */
    }

    // Refresh user list
    const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
    await ctx.editMessageText(userListText(users), {
      reply_markup: userListKeyboard(users, { showBack: true }),
    });
    await ctx.answerCallbackQuery({ text: "✅" });
  });

  // Reject / revoke user
  bot.callbackQuery(/^u:(\d+):r$/, async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }

    const targetId = ctx.match?.[1];
    await rejectUser(env.DB, targetId);

    try {
      await ctx.api.sendMessage(targetId, t("start:revokedNotify"));
    } catch {
      /* user may have blocked bot */
    }

    // Refresh user list
    const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
    await ctx.editMessageText(userListText(users), {
      reply_markup: userListKeyboard(users, { showBack: true }),
    });
    await ctx.answerCallbackQuery({ text: t("admin:users.processed") });
  });

  // Delete user confirmation
  bot.callbackQuery(/^u:(\d+):del$/, async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }

    const targetId = ctx.match?.[1];
    const user = await getUserByTelegramId(env.DB, targetId);
    const displayName = user?.username
      ? `@${user.username}`
      : user
        ? formatUserName(user)
        : targetId;
    const kb = new InlineKeyboard()
      .text(t("common:button.confirm_delete"), `u:${targetId}:dy`)
      .text(t("common:button.cancelPlain"), "users");
    await ctx.editMessageText(
      t("admin:users.confirmDelete", { name: displayName }),
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });

  // Delete user confirmed
  bot.callbackQuery(/^u:(\d+):dy$/, async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }

    const targetId = ctx.match?.[1];
    await deleteUserWithAccounts(env, targetId);

    const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
    await ctx.editMessageText(userListText(users), {
      reply_markup: userListKeyboard(users, { showBack: true }),
    });
    await ctx.answerCallbackQuery({ text: t("admin:users.deleted") });
  });
}
