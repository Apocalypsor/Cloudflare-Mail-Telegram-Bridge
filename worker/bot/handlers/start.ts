import { helpText } from "@bot/commands";
import { isAdmin } from "@bot/utils/auth";
import { formatUserName } from "@bot/utils/formatters";
import {
  approveUser,
  getUserByTelegramId,
  rejectUser,
  upsertUser,
} from "@db/users";
import { t } from "@i18n";
import {
  ROUTE_MINI_APP_LIST,
  ROUTE_MINI_APP_REMINDERS,
  ROUTE_MINI_APP_SEARCH,
} from "@page/paths";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Env } from "@/types";

/** 主菜单键盘：邮件列表 + 提醒 Mini App 入口 + 账号/用户管理。
 *  /start 默认私聊，inline web_app 按钮在私聊有效；没配 WORKER_URL 时回退
 *  到文本命令（callback_data 对应 /unread 等路由）。 */
function mainMenuKeyboard(admin: boolean, env: Env): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (env.WORKER_URL) {
    const base = env.WORKER_URL.replace(/\/$/, "");
    const listUrl = (type: string) =>
      `${base}${ROUTE_MINI_APP_LIST.replace(":type", type)}`;
    kb.row()
      .webApp(t("keyboards:menu.unread"), listUrl("unread"))
      .webApp(t("keyboards:menu.starred"), listUrl("starred"))
      .row()
      .webApp(t("keyboards:menu.junk"), listUrl("junk"))
      .webApp(t("keyboards:menu.archived"), listUrl("archived"))
      .row()
      .webApp(
        t("keyboards:menu.reminders"),
        `${base}${ROUTE_MINI_APP_REMINDERS}`,
      )
      .webApp(t("keyboards:menu.search"), `${base}${ROUTE_MINI_APP_SEARCH}`);
  } else {
    kb.row()
      .text(t("keyboards:menu.unread"), "unread")
      .text(t("keyboards:menu.starred"), "starred")
      .row()
      .text(t("keyboards:menu.junk"), "junk")
      .text(t("keyboards:menu.archived"), "archived");
  }
  kb.row()
    .text(t("keyboards:menu.sync"), "sync")
    .text(t("keyboards:menu.accountManagement"), "accs")
    .row();
  if (admin) {
    kb.text(t("keyboards:menu.userManagement"), "users")
      .text(t("keyboards:menu.globalOps"), "admin")
      .row();
  }
  return kb;
}

export function registerStartHandlers(bot: Bot, env: Env) {
  // ─── /start: 主入口，自动注册用户（私聊由全局守卫保证） ──────────────────
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
      reply_markup: mainMenuKeyboard(admin, env),
    });
  });

  // ─── /help ────────────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    const admin = isAdmin(String(ctx.from?.id), env);
    return ctx.reply(helpText(admin), { parse_mode: "MarkdownV2" });
  });

  // ─── Main menu callback ──────────────────────────────────────────────────
  bot.callbackQuery("menu", async (ctx) => {
    const userId = String(ctx.from.id);
    const admin = isAdmin(userId, env);
    await ctx.editMessageText(t("start:panel"), {
      reply_markup: mainMenuKeyboard(admin, env),
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
