import { isAdmin } from "@bot/auth";
import { formatUserName, userListText } from "@bot/formatters";
import { clearBotState } from "@bot/state";
import {
  countFailedEmails,
  deleteAllFailedEmails,
  deleteFailedEmail,
  getAllFailedEmails,
  getFailedEmail,
} from "@db/failed-emails";
import {
  approveUser,
  getNonAdminUsers,
  getUserByTelegramId,
  rejectUser,
} from "@db/users";
import { t } from "@i18n";
import { deleteUserWithAccounts } from "@services/account";
import { retryAllFailedEmails, retryFailedEmail } from "@services/bridge";
import { renewAllPush } from "@services/email/factory";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Env, TelegramUser } from "@/types";

export function userListKeyboard(
  users: TelegramUser[],
  opts?: { showBack?: boolean },
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const u of users) {
    const name = formatUserName(u);
    if (u.approved === 1) {
      kb.text(`✅ ${name}`, `u:${u.telegram_id}:info`)
        .text(t("admin:users.revoke"), `u:${u.telegram_id}:r`)
        .text("🗑", `u:${u.telegram_id}:del`);
    } else {
      kb.text(`⏳ ${name}`, `u:${u.telegram_id}:info`)
        .text(t("admin:users.approve"), `u:${u.telegram_id}:a`)
        .text("🗑", `u:${u.telegram_id}:del`);
    }
    kb.row();
  }
  if (opts?.showBack) kb.text(t("common:button.back"), "menu");
  return kb;
}

async function adminMenuKeyboard(env: Env): Promise<InlineKeyboard> {
  const failedCount = await countFailedEmails(env.DB);
  const failedLabel =
    failedCount > 0
      ? t("admin:failedEmails.titleWithCount", { count: failedCount })
      : t("admin:failedEmails.title");
  const kb = new InlineKeyboard()
    .text(failedLabel, "failed")
    .row()
    .text(t("admin:renewWatch"), "walla")
    .row();
  if (env.WORKER_URL) {
    const base = env.WORKER_URL.replace(/\/$/, "");
    kb.url(t("admin:htmlPreview"), `${base}/preview`).row();
    kb.url(t("admin:junkCheck"), `${base}/junk-check`).row();
  }
  kb.text(t("common:button.back"), "menu");
  return kb;
}

function failedEmailListMessage(
  items: import("@db/failed-emails").FailedEmail[],
): { text: string; keyboard: InlineKeyboard } {
  if (items.length === 0) {
    return {
      text: t("admin:failedEmails.noRecords"),
      keyboard: new InlineKeyboard().text(t("common:button.back"), "admin"),
    };
  }
  const lines = items.map((item, i) => {
    const date = item.created_at.replace("T", " ").slice(0, 16);
    const subj = item.subject
      ? item.subject.length > 30
        ? `${item.subject.slice(0, 30)}…`
        : item.subject
      : t("common:label.noSubjectParen");
    return `${i + 1}. ${subj}\n   ${date} | ${item.error_message?.slice(0, 40) || t("common:error.unknownError")}`;
  });
  const kb = new InlineKeyboard()
    .text(t("admin:failedEmails.retryAll"), "retry_all")
    .text(t("admin:failedEmails.clearAll"), "failed_clear")
    .row();
  for (const item of items) {
    const label = item.subject
      ? item.subject.length > 15
        ? `${item.subject.slice(0, 15)}…`
        : item.subject
      : `#${item.id}`;
    kb.text(`🔄 ${label}`, `fr:${item.id}`).text("🗑", `fd:${item.id}`).row();
  }
  kb.text(t("common:button.back"), "admin");
  return {
    text: `${t("admin:failedEmails.titleWithCount", { count: items.length })}\n\n${lines.join("\n\n")}`,
    keyboard: kb,
  };
}

export function registerAdminHandlers(bot: Bot, env: Env) {
  // ─── /users: 快速查看用户列表（管理员） ──────────────────────────────────
  bot.command("users", async (ctx) => {
    const userId = String(ctx.from?.id);
    if (!isAdmin(userId, env)) {
      return ctx.reply(t("common:admin.only"));
    }

    const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
    return ctx.reply(userListText(users), {
      reply_markup: userListKeyboard(users),
    });
  });

  // Admin operations menu
  bot.callbackQuery("admin", async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }
    await clearBotState(env, userId);
    await ctx.editMessageText(t("admin:menu.title"), {
      reply_markup: await adminMenuKeyboard(env),
    });
    await ctx.answerCallbackQuery();
  });

  // User list
  bot.callbackQuery("users", async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }
    await clearBotState(env, userId);
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
        reply_markup: await adminMenuKeyboard(env),
      });
    } catch (err) {
      await reportErrorToObservability(env, "bot.watch_all_failed", err);
      await ctx.editMessageText(t("admin:watch.failed"), {
        reply_markup: await adminMenuKeyboard(env),
      });
    }
  });

  // ─── Failed emails management ─────────────────────────────────────────

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
