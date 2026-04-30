import { cf } from "@worker/api/plugins/cf";
import { createBot, getBotInfo, syncBotCommands } from "@worker/bot/index";
import { timingSafeEqual } from "@worker/utils/hash";
import { Elysia } from "elysia";
import type { Update } from "grammy/types";
import { WebhookBody, WebhookQuery } from "./model";

/**
 * Telegram Bot webhook —— Bot Father 配置 webhook URL 时带 `?secret=`，
 * 用 `TELEGRAM_WEBHOOK_SECRET` 验签。始终返回 200，避免 Telegram 无限重试。
 *
 * 异步副作用：
 *  - `syncBotCommands` 给 BotFather 注册命令（KV 版本号未变就跳过）
 *  - `bot.handleUpdate` 用 grammY 处理这条 update
 * 都通过 ctx.waitUntil 在响应后跑。
 */
export const telegramController = new Elysia({ name: "controller.telegram" })
  .use(cf)
  .post(
    "/api/telegram/webhook",
    async ({ env, executionCtx, query, body, status }) => {
      const provided = query.secret;
      if (
        typeof provided !== "string" ||
        !timingSafeEqual(provided, env.TELEGRAM_WEBHOOK_SECRET)
      ) {
        return status(403, "Forbidden");
      }

      // 异步同步 Bot 命令菜单
      executionCtx.waitUntil(syncBotCommands(env).catch(() => {}));

      // 注入 waitUntil 到 env，bot handler 后台任务用
      env.waitUntil = executionCtx.waitUntil.bind(executionCtx);

      const botInfo = await getBotInfo(env);
      const bot = createBot(env, botInfo);
      try {
        await bot.handleUpdate(body as Update);
      } catch {
        // Telegram 重试爆炸：吞掉错误，始终 200
      }
      return "OK";
    },
    { body: WebhookBody, query: WebhookQuery },
  );
