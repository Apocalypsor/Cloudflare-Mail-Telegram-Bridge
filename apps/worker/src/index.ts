import { app } from "@worker/api";
import type { RequestWithCtx } from "@worker/api/plugins/cf";
import emailHandler from "@worker/handlers/email";
import scheduledHandler from "@worker/handlers/scheduled";
import type { Env } from "@worker/types";

export { TelegramRateLimiter } from "@worker/durable-objects/telegram-rate-limiter";

export default {
  /**
   * 把 ExecutionContext 挂到 request 上，让 Elysia 的 `cf` plugin derive
   * 出来。env 走 `cloudflare:workers` 全局，不需要注入。
   */
  fetch(
    req: Request,
    _env: Env,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    (req as RequestWithCtx)._ctx = ctx;
    return app.fetch(req);
  },

  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await emailHandler(message, env, ctx);
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(scheduledHandler(event, env, ctx));
  },
};
