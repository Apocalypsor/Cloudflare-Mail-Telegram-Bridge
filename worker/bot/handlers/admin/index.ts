import { isAdmin } from "@bot/utils/auth";
import { clearBotState } from "@bot/utils/state";
import { getNonAdminUsers } from "@db/users";
import { t } from "@i18n";
import { renewAllPush } from "@providers";
import { escapeMdV2 } from "@utils/markdown-v2";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import { type Env, QueueMessageType } from "@/types";
import { registerFailedEmailCallbacks } from "./failed";
import { registerUserCallbacks } from "./users";
import { adminMenuKeyboard, userListKeyboard, userListText } from "./utils";

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

  // ─── /secrets: 显示环境 secrets + 派生 URL（管理员，仅私聊） ────────────
  // 不进 BOT_COMMANDS（不出现在命令菜单），避免普通用户看到。
  // 加新 secret：往下面 `secrets` 数组里加一行即可。
  bot.command("secrets", async (ctx) => {
    const userId = String(ctx.from?.id);
    if (!isAdmin(userId, env)) {
      return ctx.reply(t("common:admin.only"));
    }

    const secrets: Array<{ label: string; value: string }> = [
      { label: "TELEGRAM_WEBHOOK_SECRET", value: env.TELEGRAM_WEBHOOK_SECRET },
      { label: "ADMIN_SECRET", value: env.ADMIN_SECRET },
      { label: "ADMIN_TELEGRAM_ID", value: env.ADMIN_TELEGRAM_ID },
    ];

    // code-span 内只需转义 ` 和 \（escapeMdV2 会过度转义 . 等）
    const codeEsc = (s: string) =>
      s.replace(/\\/g, "\\\\").replace(/`/g, "\\`");

    const lines: string[] = [`*${escapeMdV2(t("admin:secrets.title"))}*`];
    for (const { label, value } of secrets) {
      lines.push(``, escapeMdV2(label), `\`${codeEsc(value)}\``);
    }
    if (env.WORKER_URL) {
      const url = `${env.WORKER_URL.replace(/\/$/, "")}/api/telegram/webhook?secret=${env.TELEGRAM_WEBHOOK_SECRET}`;
      lines.push(
        ``,
        escapeMdV2(t("admin:secrets.webhookUrlLabel")),
        `\`${codeEsc(url)}\``,
      );
    }

    const autoDeleteSeconds = 60;
    lines.push(
      ``,
      t("admin:secrets.autoDeleteHint", { seconds: autoDeleteSeconds }),
    );

    const sent = await ctx.reply(lines.join("\n"), {
      parse_mode: "MarkdownV2",
    });

    // 通过 EMAIL_QUEUE + delaySeconds 排定删除（私聊里 bot 删不掉用户发的
    // /secrets 命令，TG API 限制，所以只删 bot 自己的回复）。
    await env.EMAIL_QUEUE.send(
      {
        type: QueueMessageType.DeleteTgMessage,
        chatId: String(sent.chat.id),
        messageId: sent.message_id,
      },
      { delaySeconds: autoDeleteSeconds },
    );
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

  registerUserCallbacks(bot, env);
  registerFailedEmailCallbacks(bot, env);
}
