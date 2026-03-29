import { registerAccountHandlers } from "@bot/handlers/accounts";
import { registerAdminHandlers } from "@bot/handlers/admin";
import { registerInputHandler } from "@bot/handlers/input";
import { registerJunkHandler } from "@bot/handlers/junk";
import { registerMailListHandlers } from "@bot/handlers/mail-list";
import { registerReactionHandler } from "@bot/handlers/reaction";
import { registerStarHandler } from "@bot/handlers/star";
import { registerStartHandlers } from "@bot/handlers/start";
import { registerSyncHandler } from "@bot/handlers/sync";
import { reportErrorToObservability } from "@utils/observability";
import { Api, Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { BOT_INFO_TTL, KV_BOT_INFO_KEY } from "@/constants";
import type { Env } from "@/types";

export { syncBotCommands } from "@bot/commands";

/** 从 KV 获取 botInfo，首次调用时从 Telegram API 拉取并缓存 */
export async function getBotInfo(env: Env): Promise<UserFromGetMe> {
  const cached = await env.EMAIL_KV.get(KV_BOT_INFO_KEY);
  if (cached) return JSON.parse(cached);

  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  const botInfo = await api.getMe();
  await env.EMAIL_KV.put(KV_BOT_INFO_KEY, JSON.stringify(botInfo), {
    expirationTtl: BOT_INFO_TTL,
  });
  return botInfo;
}

/** 创建 grammY Bot 实例（仅用于 webhook 接收端） */
export function createBot(env: Env, botInfo: UserFromGetMe) {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });

  bot.catch(async (err) => {
    await reportErrorToObservability(env, "bot.handler_error", err.error).catch(
      () => {},
    );
    try {
      if (err.ctx.callbackQuery) {
        await err.ctx
          .answerCallbackQuery({ text: "❌ 操作失败，请重试" })
          .catch(() => {});
      }
    } catch {
      // ignore
    }
  });

  // ─── 注册各模块 handler ────────────────────────────────────────────────
  registerStartHandlers(bot, env);
  registerAccountHandlers(bot, env);
  registerAdminHandlers(bot, env);
  registerReactionHandler(bot, env);
  registerStarHandler(bot, env);
  registerJunkHandler(bot, env);
  registerSyncHandler(bot, env);
  registerMailListHandlers(bot, env);
  // 输入处理必须最后注册（catch-all text handler）
  registerInputHandler(bot, env);

  return bot;
}
