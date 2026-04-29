import app from "@handlers/hono";
import { handleQueueBatch } from "@handlers/queue";
import { handleScheduled } from "@handlers/scheduled";
import type { Env, QueueMessage } from "@/types";

export type { Env } from "@/types";

export default {
  fetch: app.fetch,

  async queue(
    batch: MessageBatch<QueueMessage>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await handleQueueBatch(batch, env, ctx);
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env, ctx));
  },
};
