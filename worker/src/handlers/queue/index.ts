import { deleteMessage } from "@worker/clients/telegram";
import { processEmailMessage } from "@worker/handlers/queue/bridge";
import { type Env, type QueueMessage, QueueMessageType } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";

/** Queue consumer: 按 type 派发邮件投递 / 延迟删 TG 消息等任务 */
export async function handleQueueBatch(
  batch: MessageBatch<QueueMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      switch (msg.body.type) {
        case QueueMessageType.Email:
          await processEmailMessage(msg.body, env, ctx.waitUntil.bind(ctx));
          break;
        case QueueMessageType.DeleteTgMessage:
          await deleteMessage(
            env.TELEGRAM_BOT_TOKEN,
            msg.body.chatId,
            msg.body.messageId,
          );
          break;
      }
      msg.ack();
    } catch (error: unknown) {
      await reportErrorToObservability(env, "queue.message_failed", error, {
        attempt: msg.attempts,
        body: msg.body,
      });
      msg.retry();
    }
  }
}
