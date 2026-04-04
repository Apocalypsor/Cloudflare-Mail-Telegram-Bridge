import { HELP_TEXT } from "@bot/commands";
import { mainMenuKeyboard } from "@bot/keyboards";
import { isAdmin } from "@bot/utils/auth";
import { formatUserName } from "@bot/utils/formatters";
import {
  approveUser,
  getUserByTelegramId,
  rejectUser,
  upsertUser,
} from "@db/users";
import { t } from "@i18n";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Env } from "@/types";

export function registerStartHandlers(bot: Bot, env: Env) {
  // ─── /start: 主入口，自动注册用户 ────────────────────────────────────────
  bot.command("start", async (ctx) => {
    const telegramId = String(ctx.from?.id);
    const admin = isAdmin(telegramId, env);
    let user = await getUserByTelegramId(env.DB, telegramId);

    if (!user) {
      await upsertUser(
        env.DB,
        telegramId,
        ctx.from?.first_name || "Unknown",
        ctx.from?.last_name,
        ctx.from?.username,
        undefined,
        admin ? 1 : 0,
      );
      user = await getUserByTelegramId(env.DB, telegramId);

      if (!admin) {
        const displayName = formatUserName({
          first_name: ctx.from?.first_name || "Unknown",
          last_name: ctx.from?.last_name,
        });
        const username = ctx.from?.username ? ` (@${ctx.from.username})` : "";
        try {
          const kb = new InlineKeyboard()
            .text(t("start:approve"), `approve:${telegramId}`)
            .text(t("start:reject"), `reject:${telegramId}`);
          await ctx.api.sendMessage(
            env.ADMIN_TELEGRAM_ID,
            t("start:newUser", {
              name: `${displayName}${username}`,
              id: telegramId,
            }),
            {
              reply_markup: kb,
            },
          );
        } catch (err) {
          await reportErrorToObservability(env, "bot.notify_admin_failed", err);
        }
      }
    }

    if (!admin && user && user.approved !== 1) {
      return ctx.reply(t("common:admin.awaitingApprovalFull"));
    }

    return ctx.reply(t("start:panel"), {
      reply_markup: mainMenuKeyboard(admin),
    });
  });

  // ─── /help ────────────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    return ctx.reply(HELP_TEXT, { parse_mode: "MarkdownV2" });
  });

  // ─── Main menu callback ──────────────────────────────────────────────────
  bot.callbackQuery("menu", async (ctx) => {
    const userId = String(ctx.from.id);
    const admin = isAdmin(userId, env);
    await ctx.editMessageText(t("start:panel"), {
      reply_markup: mainMenuKeyboard(admin),
    });
    await ctx.answerCallbackQuery();
  });

  // ─── 管理员审批 inline 按钮回调 ──────────────────────────────────────────
  bot.callbackQuery(/^(approve|reject):(\d+)$/, async (ctx) => {
    if (!isAdmin(String(ctx.from.id), env)) {
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });
    }
    const [, action, targetId] = ctx.match as RegExpMatchArray;
    const user = await getUserByTelegramId(env.DB, targetId);
    if (!user) {
      return ctx.answerCallbackQuery({
        text: t("common:error.userNotFound"),
      });
    }

    if (action === "approve") {
      await approveUser(env.DB, targetId);
      await ctx.editMessageText(
        t("start:approved", { name: formatUserName(user), id: targetId }),
      );
      try {
        await ctx.api.sendMessage(targetId, t("start:approvedNotify"));
      } catch {
        /* user may have blocked bot */
      }
    } else {
      await rejectUser(env.DB, targetId);
      await ctx.editMessageText(
        t("start:rejected", { name: formatUserName(user), id: targetId }),
      );
      try {
        await ctx.api.sendMessage(targetId, t("start:rejectedNotify"));
      } catch {
        /* user may have blocked bot */
      }
    }
    return ctx.answerCallbackQuery();
  });
}
