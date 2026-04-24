import { registerAccountHandlers } from "@bot/handlers/accounts";
import { registerAdminHandlers } from "@bot/handlers/admin";
import { registerArchiveHandler } from "@bot/handlers/archive";
import { registerInputHandler } from "@bot/handlers/input";
import { registerJunkHandler } from "@bot/handlers/junk";
import { registerMailListHandlers } from "@bot/handlers/mail-list";
import { registerPinCleanupHandler } from "@bot/handlers/pin-cleanup";
import { registerReactionHandler } from "@bot/handlers/reaction";
import { registerRefreshHandler } from "@bot/handlers/refresh";
import { registerStarHandler } from "@bot/handlers/star";
import { registerStartHandlers } from "@bot/handlers/start";
import { registerSyncHandler } from "@bot/handlers/sync";
import { getCachedBotInfo, putCachedBotInfo } from "@db/kv";
import { t } from "@i18n";
import { memoizeAsync } from "@utils/memoize";
import { reportErrorToObservability } from "@utils/observability";
import { Api, Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "@/types";

export { syncBotCommands } from "@bot/commands";

/**
 * 从 KV 获取 botInfo，首次调用时从 Telegram API 拉取并缓存。
 * `memoizeAsync` 负责 isolate-scope 内存命中，免得 webhook + 群聊键盘
 * 构建每次都重读 `telegram:bot_info` 这个 KV key。
 */
export const getBotInfo = memoizeAsync(
  async (env: Env): Promise<UserFromGetMe> => {
    const cached = await getCachedBotInfo(env.EMAIL_KV);
    if (cached) return JSON.parse(cached) as UserFromGetMe;

    const api = new Api(env.TELEGRAM_BOT_TOKEN);
    const botInfo = await api.getMe();
    await putCachedBotInfo(env.EMAIL_KV, JSON.stringify(botInfo));
    return botInfo;
  },
);

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
          .answerCallbackQuery({ text: t("common:error.operationFailed") })
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
  registerArchiveHandler(bot, env);
  registerRefreshHandler(bot, env);
  registerSyncHandler(bot, env);
  registerMailListHandlers(bot, env);
  registerPinCleanupHandler(bot, env);
  // 输入处理必须最后注册（catch-all text handler）
  registerInputHandler(bot, env);

  return bot;
}
