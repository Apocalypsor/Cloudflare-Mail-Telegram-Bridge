import { t } from "@i18n";
import type { Bot, Context, NextFunction } from "grammy";
import type { Env } from "@/types";

export function isAdmin(userId: string, env: Env): boolean {
  return userId === env.ADMIN_TELEGRAM_ID;
}

/** 全局命令中间件：把 `/cmd` 形式的消息限制为仅私聊。
 *  群里发 /accounts /sync /unread 等会泄漏用户私人数据；/start 在群里跑还会
 *  借群成员的 ctx.from 触发 upsertUser，引入未授权注册路径。
 *
 *  仅拦截"文本消息开头是 bot_command entity"的更新；callback_query / 其它非命令
 *  消息照常走（群里收到的邮件 TG 消息上的按钮在群里也得能响应）。
 *
 *  注册必须在所有 `bot.command(...)` handler 之前 —— grammY 中间件是按 `use`
 *  顺序串起来跑的。 */
export function registerPrivateOnlyCommandGuard(bot: Bot) {
  bot.use(async (ctx: Context, next: NextFunction) => {
    const isTopLevelCommand = ctx.message?.entities?.some(
      (e) => e.type === "bot_command" && e.offset === 0,
    );
    if (isTopLevelCommand && ctx.chat?.type !== "private") {
      await ctx.reply(t("common:privateOnly"));
      return;
    }
    await next();
  });
}
