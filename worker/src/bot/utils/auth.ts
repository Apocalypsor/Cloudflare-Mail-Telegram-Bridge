import { t } from "@worker/i18n";
import type { Env } from "@worker/types";
import type { Bot, Context, NextFunction } from "grammy";

export function isAdmin(userId: string, env: Env): boolean {
  return userId === env.ADMIN_TELEGRAM_ID;
}

/** 全局命令中间件：把 `/cmd` 形式的消息限制为仅私聊。
 *  群 / 频道里发 /accounts /sync /unread 等会泄漏用户私人数据；/start 在那里跑
 *  还会触发 upsertUser 用频道/群成员的 ctx.from 引入未授权注册路径。
 *
 *  用 `ctx.msg`（grammY 的统一 getter）拿当前更新里的消息体，覆盖 message /
 *  editedMessage / channelPost / editedChannelPost 四种来源 —— 频道里发的
 *  /start 是 channel_post，光看 ctx.message 会漏。仅拦截"开头是 bot_command
 *  entity"的更新；callback_query / 其它非命令消息照常 next()（群里收到的邮件
 *  TG 消息上的按钮在群里也得能响应）。
 *
 *  注册必须在所有 `bot.command(...)` handler 之前 —— grammY 中间件按 `use`
 *  顺序串起来跑。 */
export function registerPrivateOnlyCommandGuard(bot: Bot) {
  bot.use(async (ctx: Context, next: NextFunction) => {
    const isTopLevelCommand = ctx.msg?.entities?.some(
      (e) => e.type === "bot_command" && e.offset === 0,
    );
    if (isTopLevelCommand && ctx.chat?.type !== "private") {
      // 频道 channel_post 没有 from，ctx.reply 仍然在该 chat 里发；私聊不可达就
      // 静默吃掉（不抛），比如机器人被踢、限流等
      await ctx.reply(t("common:privateOnly")).catch(() => {});
      return;
    }
    await next();
  });
}
